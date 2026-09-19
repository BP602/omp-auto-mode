/**
 * omp extension: classify every gated tool call before it runs.
 *
 * - `safe`   → the call proceeds to omp's normal approval gate.
 * - `ask`    → the user is asked to confirm; blocked when no UI is available.
 * - `unsafe` → the call is blocked and the reason is returned to the model.
 *
 * If the classifier itself fails (network, quota, bad key) the call falls through to omp's
 * built-in approval instead of failing closed, so a Jev outage cannot brick a session.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { classify, DEFAULT_THRESHOLDS, describeVerdict, type ToolCall, type Verdict } from "./classifier.ts";

/**
 * Tools whose calls are classified. Read-only built-ins are skipped: omp already auto-approves
 * the `read` tier, and a model round-trip per read would only add latency.
 */
const GATED_TOOLS: Record<string, true> = { bash: true, write: true, edit: true, eval: true, ast_edit: true };

/** Longest string value forwarded to the model; the hazards judge effect, not full file bodies. */
const MAX_VALUE_CHARS = 2_000;

/** Longest input summary shown in the confirmation dialog. */
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

export default function autoMode(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (!GATED_TOOLS[event.toolName]) return;

    const call: ToolCall = { id: event.toolCallId, tool: event.toolName, input: toClassifierInput(event.input) };
    let verdict: Verdict;
    try {
      const result = await classify([call], { thresholds: DEFAULT_THRESHOLDS, projectDir: ctx.cwd });
      verdict = result.verdicts[0]!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.logger.warn(`auto-mode: classification failed for ${event.toolName}; deferring to built-in approval: ${message}`);
      ctx.ui.notify(`auto-mode: classifier unavailable (${message})`, "warning");
      return;
    }

    const reason = describeVerdict(verdict);
    pi.logger.info(`auto-mode: ${event.toolName} -> ${verdict.label} (${reason})`);

    switch (verdict.label) {
      case "safe":
        return;
      case "unsafe":
        ctx.ui.notify(`auto-mode: blocked ${event.toolName} (${reason})`, "error");
        return { block: true, reason: `auto-mode: blocked as unsafe (${reason})` };
      case "ask": {
        if (!ctx.hasUI) {
          return { block: true, reason: `auto-mode: requires human approval but no UI is available (${reason})` };
        }
        const summary = truncate(JSON.stringify(call.input), MAX_SUMMARY_CHARS);
        const approved = await ctx.ui.confirm(`auto-mode: approve ${event.toolName}?`, `${summary}\n\n${reason}`);
        return approved ? undefined : { block: true, reason: "auto-mode: denied by user" };
      }
      default:
        return verdict.label satisfies never;
    }
  });
}
