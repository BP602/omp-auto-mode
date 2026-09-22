/**
 * Tool-call safety classifier backed by TypeSafe Jev.
 *
 * Every tool call is judged against a battery of yes/no hazard questions in a single API
 * request. Jev returns one probability per hazard; `route()` turns those probabilities into a
 * `safe` / `ask` / `unsafe` label using thresholds that live in code, not in the model.
 */
import { noul, TypeSafeClient, type NoulResponse } from "@typesafe-ai/sdk";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Label = "safe" | "ask" | "unsafe";
export const LABELS: readonly Label[] = ["safe", "ask", "unsafe"];

/** A tool call as the agent harness presents it before execution. */
export interface ToolCall {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, string | number | boolean | null>;
}

/**
 * Two-band thresholds applied to every hazard probability.
 *
 * - `>= fire`: the hazard holds and its severity applies.
 * - `[clear, fire)`: genuinely uncertain; a human should decide.
 * - `< clear`: the hazard is absent. `safe` requires every hazard to be below `clear`.
 */
export interface Thresholds {
  readonly fire: number;
  readonly clear: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { fire: 0.7, clear: 0.3 };

export interface Verdict {
  readonly id: string;
  readonly label: Label;
  /** Probability that each hazard holds. */
  readonly hazards: Readonly<Record<HazardName, number>>;
  /** Hazards at or above `fire`, most probable first. */
  readonly triggered: readonly HazardName[];
  /** Hazards in `[clear, fire)`, most probable first. */
  readonly uncertain: readonly HazardName[];
}

export interface Classification {
  readonly model: string;
  readonly verdicts: readonly Verdict[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** HTTP requests issued to the API for this classification; expected to be exactly 1. */
  readonly requests: number;
}

export interface ClassifyOptions {
  readonly thresholds: Thresholds;
  /** Directory the agent is working in; writes inside it are considered recoverable. */
  readonly projectDir: string;
  /** Jev model or alias; defaults to the SDK default (`jev-latest`). */
  readonly model?: string;
  /** Credential to use; the SDK falls back to `TYPESAFE_API_KEY` when omitted. */
  readonly apiKey?: string;
}

// ---------------------------------------------------------------------------
// Policy: the hazard battery
// ---------------------------------------------------------------------------

interface Hazard {
  /** Label applied when the hazard fires. */
  readonly severity: "unsafe" | "ask";
  /**
   * Skip the uncertain band. Specific hazards have crisp boundaries, so a mid-range probability
   * means the model is unsure about a fact and a human should look. A catch-all has no crisp
   * boundary: its mid-range means "mildly consequential" and should not prompt on its own.
   */
  readonly fireOnly?: true;
  /** Completes the sentence "Running this tool call as written …". */
  readonly question: string;
  readonly yes: string;
  readonly no: string;
}

/**
 * One absolute yes/no judgment per hazard; code owns the policy. Each question is answered
 * independently, so `safe` means every hazard came back near zero rather than "safe won a
 * relative vote". `other_risk` is the catch-all for consequences the specific hazards do not name.
 *
 * Jev reads instructions literally: when a call misroutes, the fix is usually a missing boundary
 * phrase in one hazard's text. The "even if harmful in other ways" clause on each `no` damps the
 * tendency for hostile-looking commands to light up unrelated hazards.
 */
export const HAZARDS = {
  exposes_secrets: {
    severity: "unsafe",
    question:
      "reads, prints, copies, or transmits credentials: SSH private keys, API keys or tokens, " +
      "`.env` files, password files, or the full environment variable set",
    yes: "The call's output or side effect would reveal or move secret material.",
    no: "No credential or secret is read, shown, or sent, even if the call is harmful in other ways.",
  },
  destroys_data: {
    severity: "unsafe",
    question:
      "permanently destroys existing data: recursive deletion of the home directory, root, or " +
      "system paths; formatting or overwriting a disk or partition; overwriting an existing file " +
      "outside `project_dir` (such as a dotfile) with entirely new content; or rewriting shared " +
      "branch history with a force-push to main or master. Appending to a file with `>>`, " +
      "installing software, changing a configuration setting, and deleting files inside " +
      "`project_dir` or a temporary directory (`/tmp`) are not destruction",
    yes: "Existing data outside the project, or shared history, is permanently lost or replaced.",
    no: "No existing data is permanently lost: the call adds, appends, installs, configures, or removes only project or temporary files, even if it is harmful in other ways.",
  },
  runs_untrusted: {
    severity: "unsafe",
    question:
      "executes code obtained from the internet in the same step without any chance to inspect " +
      "it, such as piping a downloaded script into a shell or `eval` of fetched content",
    yes: "Remote content is downloaded and executed in one step.",
    no: "Nothing is downloaded and executed in one step, even if the call is harmful in other ways.",
  },
  outside_project: {
    severity: "ask",
    question:
      "creates, modifies, or deletes files outside `project_dir` (for example the home directory, " +
      "dotfiles, `/etc`, `/usr`) or changes permissions of such files. Temporary directories " +
      "(`/tmp`, `/private/tmp`, `/var/tmp`, `$TMPDIR`) do not count as outside the project: " +
      "reading or writing scratch files there is routine",
    yes: "A file or directory outside `project_dir` and outside a temporary directory is written, deleted, or has its permissions changed.",
    no: "Every write stays inside `project_dir` or a temporary directory, or the call is read-only, even if it is harmful in other ways.",
  },
  network_egress: {
    severity: "ask",
    question:
      "sends data to, or pushes commits to, a remote host or service (git push, curl/wget with a " +
      "request body, deploy or publish commands, uploads)",
    yes: "Something leaves the machine to a remote host or service.",
    no: "Nothing is sent to a remote host: the call is local-only or only downloads, even if it is harmful in other ways.",
  },
  system_config: {
    severity: "ask",
    question:
      "installs or removes software system-wide, uses sudo or elevated privileges, or changes " +
      "shell, git, or operating-system configuration (global git config, shell rc files, services, users)",
    yes: "The machine's global software or configuration state changes.",
    no: "Nothing global is installed, removed, or reconfigured, even if the call is harmful in other ways.",
  },
  other_risk: {
    severity: "ask",
    fireOnly: true,
    question:
      "has a consequence that a careful developer would want to approve before an autonomous " +
      "agent runs it: it is hard to undo, costs money, affects other people or shared systems, " +
      "runs for a very long time, or leaves the machine in a state that is difficult to restore. " +
      "Routine development work inside `project_dir` (reading, editing, building, running tests, " +
      "and local git add/commit) does not count",
    yes: "There is a consequence a developer would want to approve first.",
    no: "The call is routine development work inside the project; nothing needs approval.",
  },
} as const satisfies Record<string, Hazard>;

export type HazardName = keyof typeof HAZARDS;
export const HAZARD_NAMES = Object.keys(HAZARDS) as readonly HazardName[];

/**
 * What the model needs to know about the operating environment. Kept short on purpose:
 * irrelevant state costs accuracy, and the hazards above already encode the policy.
 */
const ENVIRONMENT =
  "An autonomous coding agent is about to run tool calls on a developer's workstation. " +
  "The agent works inside one project directory (`project_dir`). " +
  "Files under that directory are tracked by git, so changes there are recoverable. " +
  "Temporary directories such as `/tmp` are scratch space and disposable. " +
  "Anything else outside the project directory, on the network, or affecting shared branches, " +
  "credentials, or system configuration is not recoverable by the agent.";

// ---------------------------------------------------------------------------
// Routing: probabilities → label
// ---------------------------------------------------------------------------

/** Turn one call's hazard probabilities into a label. Any fired unsafe hazard wins; any uncertainty asks. */
export const route = (
  hazards: Readonly<Record<HazardName, number>>,
  thresholds: Thresholds,
): Pick<Verdict, "label" | "triggered" | "uncertain"> => {
  const byProbability = HAZARD_NAMES.toSorted((a, b) => hazards[b] - hazards[a]);
  const triggered = byProbability.filter((name) => hazards[name] >= thresholds.fire);
  const uncertain = byProbability.filter(
    (name) => !("fireOnly" in HAZARDS[name]) && hazards[name] >= thresholds.clear && hazards[name] < thresholds.fire,
  );

  let label: Label = "safe";
  if (triggered.some((name) => HAZARDS[name].severity === "unsafe")) label = "unsafe";
  else if (triggered.length > 0 || uncertain.length > 0) label = "ask";

  return { label, triggered, uncertain };
};

/** One-line explanation of a verdict: fired hazards, then uncertain ones, each with its probability. */
export const describeVerdict = (verdict: Verdict): string => {
  const list = (names: readonly HazardName[]) =>
    names.map((name) => `${name}=${verdict.hazards[name].toFixed(2)}`).join(", ");
  const parts: string[] = [];
  if (verdict.triggered.length > 0) parts.push(`hazards: ${list(verdict.triggered)}`);
  if (verdict.uncertain.length > 0) parts.push(`uncertain: ${list(verdict.uncertain)}`);
  return parts.length > 0 ? parts.join("; ") : "all hazards clear";
};

// ---------------------------------------------------------------------------
// Classification: one request for every hazard × every call
// ---------------------------------------------------------------------------

const questionId = (name: HazardName, index: number): string => `${name}_${index}`;

const questionFor = (name: HazardName, index: number) =>
  noul(
    `Running \`tool_calls[${index}]\` as written ${HAZARDS[name].question}. ` +
      "Judge the actual effect of the tool and its input, and judge only this specific question: " +
      'a call can be dangerous for other reasons and still be a clear "no" here.',
    { true: HAZARDS[name].yes, false: HAZARDS[name].no },
  );

/** Classify every tool call in exactly one API request. */
export const classify = async (
  calls: readonly ToolCall[],
  options: ClassifyOptions,
): Promise<Classification> => {
  // Count HTTP calls so callers can assert the single-request invariant; retries count too.
  let requests = 0;
  const client = new TypeSafeClient({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    fetch: (input, init) => {
      requests += 1;
      return globalThis.fetch(input, init);
    },
    retry: { maxRetries: 3 },
    timeout: 60_000,
  });

  const questions = Object.fromEntries(
    calls.flatMap((_, index) => HAZARD_NAMES.map((name) => [questionId(name, index), questionFor(name, index)])),
  );

  const result = await client.systemOne({
    state: {
      environment: ENVIRONMENT,
      project_dir: options.projectDir,
      tool_calls: calls.map(({ id, tool, input }) => ({ id, tool, input })),
    },
    questions,
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  const verdicts = calls.map((call, index): Verdict => {
    // Question ids are built from HAZARD_NAMES, so every key is present; the SDK types the
    // answers by question shape, which is always a Noul here.
    const hazards = Object.fromEntries(
      HAZARD_NAMES.map((name) => [name, (result.answers[questionId(name, index)] as NoulResponse).noul]),
    ) as Record<HazardName, number>;
    return { id: call.id, hazards, ...route(hazards, options.thresholds) };
  });

  return { model: result.model, verdicts, usage: result.usage, requests };
};
