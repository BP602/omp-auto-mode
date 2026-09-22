/**
 * omp extension: gate every classified tool call before it runs.
 *
 * Bash commands are first checked against a critical-pattern backstop, then the deterministic
 * rules in `auto-mode.json` (project `.omp/` and the omp agent directory). A critical match or an
 * `ask` rule prompts; an `allow` rule passes. Everything else goes to the classifier:
 *
 * - `safe`   → the call proceeds.
 * - `ask`    → the user chooses: allow once, always allow (persisted as a rule), or deny.
 *              Blocked when no UI is available.
 * - `unsafe` → the call is blocked and the reason is returned to the model.
 *
 * The Jev credential comes from omp's own credential store (`/login typesafe`), resolved per call
 * so a mid-session login takes effect; `TYPESAFE_API_KEY` still works as the SDK's own fallback.
 * If the classifier itself fails (network, quota, bad key) the call is treated as an ask: the
 * user decides per call, and with no UI it blocks. This extension is the only gate when omp runs
 * `tools.approvalMode: yolo` — there is no built-in approval behind it to fall through to.
 */
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { classify, DEFAULT_THRESHOLDS, describeVerdict, type ToolCall, type Verdict } from "./classifier.ts";
import {
  appendAllowRule,
  decide,
  formatRule,
  isCriticalBash,
  loadRules,
  suggestRules,
  tokenize,
  type Chain,
  type Rule,
} from "./rules.ts";

/**
 * Tools whose calls are classified. Read-only built-ins are skipped: omp already auto-approves
 * the `read` tier, and a model round-trip per read would only add latency.
 */
const GATED_TOOLS: Record<string, true> = { bash: true, write: true, edit: true, eval: true, ast_edit: true };

const RULES_FILE = "auto-mode.json";

/** omp's provider id for the Jev backend; `omp token typesafe` reads the same credential. */
const TYPESAFE_PROVIDER = "typesafe";

/** Longest string value forwarded to the model; the hazards judge effect, not full file bodies. */
const MAX_VALUE_CHARS = 2_000;

/** Longest input summary shown in the approval dialog. */
const MAX_SUMMARY_CHARS = 400;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;

/** Flatten a tool input into the primitive record the classifier sends as state. */
const toClassifierInput = (input: object): ToolCall["input"] => {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "string") out[key] = truncate(value, MAX_VALUE_CHARS);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
    else out[key] = truncate(JSON.stringify(value), MAX_VALUE_CHARS);
  }
  return out;
};

/** The raw command when this is a well-formed bash tool call. */
const bashCommand = (event: ToolCallEvent): string | undefined => {
  if (event.toolName !== "bash") return undefined;
  const command = "command" in event.input ? event.input.command : undefined;
  return typeof command === "string" ? command : undefined;
};

/**
 * Ask the user what to do. The command and the reason go in the title, above the options.
 * "Always allow" is offered only for a single command the rule matcher can represent: persisting a
 * rule for one half of `a && b` would allow that half on its own, which the user never approved.
 */
const askUser = async (
  ctx: ExtensionContext,
  toolName: string,
  summary: string,
  reason: string,
  chain: Chain | undefined,
): Promise<"allow" | "deny"> => {
  const only = chain?.length === 1 ? chain[0]! : undefined;
  const persistable: readonly Rule[] = only === undefined ? [] : suggestRules(only);
  const ALLOW_ONCE = "Allow once";
  const DENY = "Deny";
  const always = persistable.map((rule) => ({ rule, label: `Always allow: ${formatRule(rule)}` }));

  const choice = await ctx.ui.select(`auto-mode: approve ${toolName}?\n${summary}\n\n${reason}`, [
    ALLOW_ONCE,
    ...always.map(({ label }) => ({ label, description: `Adds an allow rule to .omp/${RULES_FILE}` })),
    DENY,
  ]);

  if (choice === undefined || choice === DENY) return "deny";
  const chosen = always.find(({ label }) => label === choice);
  if (chosen !== undefined) {
    await appendAllowRule(join(ctx.cwd, ".omp", RULES_FILE), chosen.rule);
    ctx.ui.notify(`auto-mode: added allow rule "${formatRule(chosen.rule)}"`, "info");
  }
  return "allow";
};

export default function autoMode(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (!GATED_TOOLS[event.toolName]) return;

    const call: ToolCall = { id: event.toolCallId, tool: event.toolName, input: toClassifierInput(event.input) };
    const summary = truncate(
      event.toolName === "bash" && typeof call.input["command"] === "string" ? call.input["command"] : JSON.stringify(call.input),
      MAX_SUMMARY_CHARS,
    );

    /** Run the approval dialog, or block when there is nobody to answer it. */
    const prompt = async (reason: string, chain: Chain | undefined) => {
      if (!ctx.hasUI) return { block: true, reason: `auto-mode: requires human approval but no UI is available (${reason})` };
      const decision = await askUser(ctx, event.toolName, summary, reason, chain);
      return decision === "allow" ? undefined : { block: true, reason: "auto-mode: denied by user" };
    };

    const command = bashCommand(event);
    if (command !== undefined && isCriticalBash(command)) {
      const reason = "matched the critical bash backstop";
      pi.logger.info(`auto-mode: ${event.toolName} -> ask (${reason})`);
      return prompt(reason, undefined);
    }

    const chain = command === undefined ? undefined : tokenize(command);
    if (chain !== undefined) {
      const rules = await loadRules([join(ctx.cwd, ".omp", RULES_FILE), join(getAgentDir(), RULES_FILE)]);
      const ruled = decide(rules, chain);
      if (ruled?.tier === "allow") return;
      if (ruled?.tier === "ask") {
        const reason = `matched ask rule "${formatRule(ruled.rule)}" in ${RULES_FILE}`;
        pi.logger.info(`auto-mode: ${event.toolName} -> ask (${reason})`);
        return prompt(reason, chain);
      }
    }

    let verdict: Verdict;
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(TYPESAFE_PROVIDER);
      const result = await classify([call], {
        thresholds: DEFAULT_THRESHOLDS,
        projectDir: ctx.cwd,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      verdict = result.verdicts[0]!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.logger.warn(`auto-mode: classification failed for ${event.toolName}; asking: ${message}`);
      ctx.ui.notify(`auto-mode: classifier unavailable (${message})`, "warning");
      return prompt(`classifier unavailable, treated as ask (${message})`, undefined);
    }

    const reason = describeVerdict(verdict);
    pi.logger.info(`auto-mode: ${event.toolName} -> ${verdict.label} (${reason})`);

    switch (verdict.label) {
      case "safe":
        return;
      case "unsafe":
        ctx.ui.notify(`auto-mode: blocked ${event.toolName} (${reason})`, "error");
        return { block: true, reason: `auto-mode: blocked as unsafe (${reason})` };
      case "ask":
        return prompt(reason, chain);
      default:
        return verdict.label satisfies never;
    }
  });
}
