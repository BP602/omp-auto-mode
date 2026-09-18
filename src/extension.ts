import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { classify, DEFAULT_THRESHOLDS, type ToolCall, type Verdict } from "./classifier.ts";

/**
 * Tools whose calls are classified before execution. Read-only built-ins are skipped:
 * omp already auto-approves the `read` tier and a Jev round-trip per read would only add latency.
 */
const GATED_TOOLS: Record<string, true> = { bash: true, write: true, edit: true, eval: true, ast_edit: true };

/** Longest string value forwarded to the model; the rubric judges effect, not full file bodies. */
const MAX_VALUE_CHARS = 2_000;

/** Flatten a tool input into the primitive record the classifier sends as state. */
const toClassifierInput = (input: object): ToolCall["input"] => {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" || value === null ? value : JSON.stringify(value);
    out[key] = typeof text === "string" && text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}… [truncated ${text.length - MAX_VALUE_CHARS} chars]` : text;
  }
  return out;
};

const describe = (v: Verdict): string =>
  `p(safe/ask/unsafe)=${v.probabilities.map((p) => p.toFixed(2)).join("/")} conf=${v.confidence.toFixed(2)}`;

export default function autoMode(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (!GATED_TOOLS[event.toolName]) return;

    const call: ToolCall = { id: event.toolCallId, tool: event.toolName, input: toClassifierInput(event.input) };
    let verdict: Verdict;
    try {
      const result = await classify([call], { thresholds: DEFAULT_THRESHOLDS, projectDir: ctx.cwd });
      verdict = result.verdicts[0]!;
    } catch (err) {
      // Classifier unavailable: fall through to omp's own approval gate rather than fail closed.
      const message = err instanceof Error ? err.message : String(err);
      pi.logger.warn(`auto-mode: classification failed for ${event.toolName}; deferring to built-in approval: ${message}`);
      ctx.ui.notify(`auto-mode: classifier unavailable (${message})`, "warning");
      return;
    }

    pi.logger.info(`auto-mode: ${event.toolName} -> ${verdict.label} (${describe(verdict)})`);
    if (verdict.label === "safe") return;
    if (verdict.label === "unsafe") {
      ctx.ui.notify(`auto-mode: blocked ${event.toolName} (${describe(verdict)})`, "error");
      return { block: true, reason: `auto-mode: blocked as unsafe (${describe(verdict)})` };
    }

    if (!ctx.hasUI) {
      return { block: true, reason: `auto-mode: requires human approval but no UI is available (${describe(verdict)})` };
    }
    const summary = JSON.stringify(call.input);
    const approved = await ctx.ui.confirm(
      `auto-mode: approve ${event.toolName}?`,
      `${summary.length > 400 ? `${summary.slice(0, 400)}…` : summary}\n${describe(verdict)}`,
    );
    return approved ? undefined : { block: true, reason: "auto-mode: denied by user" };
  });
}
