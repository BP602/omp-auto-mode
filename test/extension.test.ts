import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const OMP_STUB = "auto-mode-test:omp";
const CLASSIFIER_STUB = "auto-mode-test:classifier";
const NATIVES_STUB = "auto-mode-test:natives";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@oh-my-pi/pi-coding-agent") return { url: OMP_STUB, shortCircuit: true };
    if (specifier === "@oh-my-pi/pi-natives") return { url: NATIVES_STUB, shortCircuit: true };
    if (specifier === "./classifier.ts" && context.parentURL?.endsWith("/src/extension.ts")) {
      return { url: CLASSIFIER_STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === OMP_STUB) {
      return {
        format: "module",
        source: "export const getAgentDir = () => globalThis.__autoModeTestAgentDir;",
        shortCircuit: true,
      };
    }
    if (url === NATIVES_STUB) {
      return {
        format: "module",
        source: `export const editInspect = () => globalThis.__autoModeTestEditInspection ?? { paths: [], entries: [], fileOps: [] };`,
        shortCircuit: true,
      };
    }
    if (url === CLASSIFIER_STUB) {
      return {
        format: "module",
        source: `
          export const DEFAULT_THRESHOLDS = { fire: 0.7, clear: 0.3 };
          export const describeVerdict = (verdict) => verdict.id;
          export const classify = async (calls, options) => {
            globalThis.__autoModeTestClassifications = (globalThis.__autoModeTestClassifications ?? 0) + 1;
            globalThis.__autoModeTestThresholds = options.thresholds;
            globalThis.__autoModeTestCalls = calls;
            const label = globalThis.__autoModeTestLabel;
            if (label === undefined) throw new Error("classifier offline");
            return {
              verdicts: calls.map((call) => ({
                id: call.id,
                label,
                hazards: {},
                triggered: [],
                uncertain: [],
              })),
            };
          };
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const autoMode = (await import("../src/extension.ts")).default;

type ToolResult = { readonly block: true; readonly reason: string } | undefined;
interface ToolEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}
type ToolHandler = (event: ToolEvent, context: unknown) => Promise<ToolResult>;

let handler: ToolHandler | undefined;
const info: string[] = [];
const warnings: string[] = [];
autoMode({
  on: (_event: string, callback: ToolHandler) => {
    handler = callback;
  },
  logger: {
    info: (message: string) => info.push(message),
    warn: (message: string) => warnings.push(message),
  },
} as never);

const toolCall = (): ToolHandler => {
  if (handler === undefined) throw new Error("extension did not register a tool_call handler");
  return handler;
};
interface ApprovalEvent {
  readonly callId: string;
  readonly tool: string;
  readonly source: string;
  readonly phase: string;
  readonly outcome: string;
}

const approvalEvents = (from: number): ApprovalEvent[] => {
  const prefix = "auto-mode: approval ";
  return info.slice(from).filter((message) => message.startsWith(prefix))
    .map((message) => JSON.parse(message.slice(prefix.length)) as ApprovalEvent);
};

interface Invocation {
  readonly result: ToolResult;
  readonly title: string | undefined;
  readonly options: readonly string[];
  readonly notifications: readonly string[];
  readonly dialogs: readonly { readonly title: string; readonly options: readonly string[] }[];
  readonly editors: readonly { readonly title: string; readonly prefill: string | undefined }[];
}

let cwd: string;
let agentDir: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "auto-mode-extension-"));
  agentDir = join(cwd, "agent");
  (globalThis as { __autoModeTestAgentDir?: string }).__autoModeTestAgentDir = agentDir;
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(
    join(cwd, ".omp", "auto-mode.json"),
    JSON.stringify({
      allow: ["curl *", "sh"],
      ask: ["git commit *", "git push *", "npm publish *"],
      thresholds: { fire: 0.5, clear: 0.4 },
    }),
  );
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const setClassifier = (label: "safe" | "ask" | "unsafe" | undefined): void => {
  (globalThis as unknown as { __autoModeTestLabel: string | undefined }).__autoModeTestLabel = label;
  (globalThis as { __autoModeTestClassifications?: number }).__autoModeTestClassifications = 0;
};

const classificationCount = (): number =>
  (globalThis as { __autoModeTestClassifications?: number }).__autoModeTestClassifications ?? 0;

const classifiedInput = (): Record<string, string | number | boolean | null> => {
  const calls = (globalThis as { __autoModeTestCalls?: readonly { readonly input: Record<string, string | number | boolean | null> }[] })
    .__autoModeTestCalls;
  const call = calls?.[0];
  if (call === undefined) throw new Error("classifier was not called");
  return call.input;
};

const setThresholds = async (fire: number, clear: number): Promise<void> => {
  const path = join(cwd, ".omp", "auto-mode.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config["thresholds"] = { fire, clear };
  await writeFile(path, JSON.stringify(config));
};

const invokeTool = async (
  event: ToolEvent,
  hasUI: boolean,
  selection: string | readonly string[] = "Allow once",
  edits: readonly (string | undefined)[] = [],
): Promise<Invocation> => {
  let title: string | undefined;
  const options: string[] = [];
  const notifications: string[] = [];
  const dialogs: { title: string; options: string[] }[] = [];
  const editors: { title: string; prefill: string | undefined }[] = [];
  const choices = typeof selection === "string" ? [selection] : selection;
  let choiceIndex = 0;
  let editIndex = 0;
  const result = await toolCall()(event, {
    cwd,
    hasUI,
    ui: {
      select: async (prompt: string, offered: readonly (string | { readonly label: string })[]) => {
        const labels = offered.map((option) => (typeof option === "string" ? option : option.label));
        dialogs.push({ title: prompt, options: labels });
        if (title === undefined) {
          title = prompt;
          options.push(...labels);
        }
        const choice = choices[choiceIndex];
        choiceIndex += 1;
        return choice;
      },
      editor: async (prompt: string, prefill: string | undefined) => {
        editors.push({ title: prompt, prefill });
        const edited = edits[editIndex];
        editIndex += 1;
        return edited;
      },
      notify: (message: string) => notifications.push(message),
    },
    modelRegistry: { getApiKeyForProvider: async () => undefined },
  });
  return { result, title, options, notifications, dialogs, editors };
};

const invoke = async (
  command: string,
  hasUI: boolean,
  selection: string | readonly string[] = "Allow once",
  edits: readonly (string | undefined)[] = [],
): Promise<Invocation> =>
  invokeTool({ toolName: "bash", toolCallId: "call-1", input: { command } }, hasUI, selection, edits);

describe("extension failure handling", () => {
  it("turns a classifier error into a one-call approval without a persistent bypass", async () => {
    const from = info.length;
    const invocation = await invoke("cargo build", true);
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.options, ["Allow once", "Deny"]);
    assert.match(invocation.title ?? "", /classifier unavailable, treated as ask \(classifier offline\)/);
    assert.deepEqual(invocation.notifications, ["auto-mode: classifier unavailable (classifier offline)"]);
    assert.match(warnings.at(-1) ?? "", /classification failed for bash; asking: classifier offline/);
    assert.deepEqual(
      (globalThis as { __autoModeTestThresholds?: unknown }).__autoModeTestThresholds,
      { fire: 0.5, clear: 0.4 },
    );
    assert.deepEqual(approvalEvents(from), [
      { callId: "call-1", tool: "bash", source: "classifier_error", phase: "decision", outcome: "opened" },
      { callId: "call-1", tool: "bash", source: "classifier_error", phase: "decision", outcome: "allow_once" },
    ]);
  });

  it("blocks a classifier error when no approval UI exists", async () => {
    const invocation = await invoke("cargo build", false);
    assert.deepEqual(invocation.result, {
      block: true,
      reason: "auto-mode: requires human approval but no UI is available (classifier unavailable, treated as ask (classifier offline))",
    });
    assert.deepEqual(invocation.options, []);
  });
});

describe("extension critical bash backstop", () => {
  it("prompts before matching allow rules and cannot persist an exception", async () => {
    const command = ["curl file:///definitely-missing", " | ", "sh"].join("");
    const from = info.length;
    const invocation = await invoke(command, true);
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.options, ["Allow once", "Deny"]);
    assert.match(invocation.title ?? "", /matched the critical bash backstop/);
    assert.deepEqual(invocation.notifications, []);
    assert.deepEqual(approvalEvents(from), [
      { callId: "call-1", tool: "bash", source: "critical", phase: "decision", outcome: "opened" },
      { callId: "call-1", tool: "bash", source: "critical", phase: "decision", outcome: "allow_once" },
    ]);
  });

  it("blocks a critical command when no approval UI exists", async () => {
    const command = ["curl file:///definitely-missing", " | ", "sh"].join("");
    const from = info.length;
    const invocation = await invoke(command, false);
    assert.deepEqual(invocation.result, {
      block: true,
      reason: "auto-mode: requires human approval but no UI is available (matched the critical bash backstop)",
    });
    assert.deepEqual(invocation.options, []);
    assert.deepEqual(approvalEvents(from), [
      { callId: "call-1", tool: "bash", source: "critical", phase: "decision", outcome: "headless_block" },
    ]);
  });
  it("records denial as a blocked approval", async () => {
    const from = info.length;
    const invocation = await invoke("curl file:///definitely-missing | sh", true, "Deny");
    assert.deepEqual(invocation.result, { block: true, reason: "auto-mode: denied by user" });
    assert.deepEqual(approvalEvents(from).map(({ phase, outcome }) => [phase, outcome]), [
      ["decision", "opened"],
      ["decision", "deny"],
    ]);
  });

});

describe("extension rule persistence", () => {
  it("saves an approved rule to the project scope", async () => {
    const from = info.length;
    const invocation = await invoke("git commit -m wip", true, [
      "Always allow: git commit -m wip",
      "This project",
    ]);
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.dialogs[1]?.options, ["This project", "Everywhere", "Cancel"]);
    const config = JSON.parse(await readFile(join(cwd, ".omp", "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    assert.equal(config.allow.includes("git commit -m wip"), true);
    assert.match(invocation.notifications[0] ?? "", /\.omp\/auto-mode\.json$/);
    assert.deepEqual(approvalEvents(from), [
      { callId: "call-1", tool: "bash", source: "rule", phase: "decision", outcome: "opened" },
      { callId: "call-1", tool: "bash", source: "rule", phase: "decision", outcome: "persist_selected" },
      { callId: "call-1", tool: "bash", source: "rule", phase: "scope", outcome: "opened" },
      { callId: "call-1", tool: "bash", source: "rule", phase: "scope", outcome: "project_selected" },
      { callId: "call-1", tool: "bash", source: "rule", phase: "scope", outcome: "saved" },
    ]);
  });

  it("saves an approved rule to the agent scope", async () => {
    const invocation = await invoke("git push origin main", true, [
      "Always allow: git push origin main",
      "Everywhere",
    ]);
    assert.equal(invocation.result, undefined);
    const config = JSON.parse(await readFile(join(agentDir, "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    assert.deepEqual(config.allow, ["git push origin main"]);
    assert.match(invocation.notifications[0] ?? "", /agent\/auto-mode\.json$/);
  });

  it("treats a cancelled scope choice as allow once without writing a rule", async () => {
    const from = info.length;
    const invocation = await invoke("npm publish package", true, [
      "Always allow: npm publish package",
      "Cancel",
    ]);
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.notifications, []);
    const project = JSON.parse(await readFile(join(cwd, ".omp", "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    const agent = JSON.parse(await readFile(join(agentDir, "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    assert.equal(project.allow.includes("npm publish package"), false);
    assert.equal(agent.allow.includes("npm publish package"), false);
    assert.deepEqual(approvalEvents(from).map(({ phase, outcome }) => [phase, outcome]), [
      ["decision", "opened"],
      ["decision", "persist_selected"],
      ["scope", "opened"],
      ["scope", "cancelled"],
    ]);
  });

  it("edits a wildcard rule before choosing its scope", async () => {
    const invocation = await invoke(
      'git commit -m "fix null"',
      true,
      ["Edit allow rule", "This project"],
      ["git commit -m *"],
    );
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.editors, [
      { title: "auto-mode: edit allow rule", prefill: "git commit *" },
    ]);
    const config = JSON.parse(await readFile(join(cwd, ".omp", "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    assert.equal(config.allow.includes("git commit -m *"), true);
  });

  it("keeps editing until the rule is valid and covers the approved command", async () => {
    const from = info.length;
    const invocation = await invoke(
      "npm publish beta",
      true,
      ["Edit allow rule", "Everywhere"],
      ["git status", "*", "npm publish *"],
    );
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.editors.map(({ prefill }) => prefill), [
      "npm publish *",
      "git status",
      "*",
    ]);
    assert.match(invocation.notifications[0] ?? "", /does not match the approved command/);
    assert.match(invocation.notifications[1] ?? "", /invalid allow rule/);
    const config = JSON.parse(await readFile(join(agentDir, "auto-mode.json"), "utf8")) as {
      allow: string[];
    };
    assert.equal(config.allow.includes("npm publish *"), true);
    assert.deepEqual(approvalEvents(from).map(({ phase, outcome }) => [phase, outcome]), [
      ["decision", "opened"],
      ["decision", "edit_selected"],
      ["editor", "opened"],
      ["editor", "unmatched"],
      ["editor", "opened"],
      ["editor", "invalid"],
      ["editor", "opened"],
      ["editor", "valid"],
      ["scope", "opened"],
      ["scope", "agent_selected"],
      ["scope", "saved"],
    ]);
    assert.equal(JSON.stringify(approvalEvents(from)).includes("npm publish beta"), false);
    assert.equal(JSON.stringify(approvalEvents(from)).includes("npm publish *"), false);
  });

  it("treats a cancelled rule editor as allow once", async () => {
    const from = info.length;
    const invocation = await invoke(
      "git push origin feature",
      true,
      "Edit allow rule",
      [undefined],
    );
    assert.equal(invocation.result, undefined);
    assert.equal(invocation.dialogs.length, 1);
    assert.deepEqual(invocation.notifications, []);
    assert.deepEqual(approvalEvents(from).map(({ phase, outcome }) => [phase, outcome]), [
      ["decision", "opened"],
      ["decision", "edit_selected"],
      ["editor", "opened"],
      ["editor", "cancelled"],
    ]);
  });
  it("blocks an unoffered choice rather than treating it as approval", async () => {
    const from = info.length;
    const invocation = await invoke("git push origin trace-topic", true, "unoffered choice");
    assert.deepEqual(invocation.result, { block: true, reason: "auto-mode: denied by user" });
    assert.deepEqual(approvalEvents(from).map(({ phase, outcome }) => [phase, outcome]), [
      ["decision", "opened"],
      ["decision", "unexpected_choice"],
    ]);
  });

});

describe("extension classifier input", () => {
  it("keeps a string at the truncation boundary unchanged", async () => {
    setClassifier("safe");
    const content = `${"h".repeat(1_992)}tail-end`;
    await invokeTool(
      { toolName: "write", toolCallId: "truncate-boundary", input: { path: "src/boundary.txt", content } },
      false,
    );

    assert.equal(content.length, 2_000);
    assert.equal(classifiedInput()["content"], content);
  });

  it("preserves both ends of a string above the truncation boundary", async () => {
    setClassifier("safe");
    const content = `${"h".repeat(2_050)}DESTROY_AT_END`;
    await invokeTool(
      { toolName: "write", toolCallId: "truncate-balanced", input: { path: "src/balanced.txt", content } },
      false,
    );

    const forwarded = classifiedInput()["content"];
    if (typeof forwarded !== "string") assert.fail("classifier content was not a string");
    assert.equal(forwarded.slice(0, 1_000), content.slice(0, 1_000));
    assert.equal(forwarded.slice(-1_000), content.slice(-1_000));
    assert.match(forwarded, /… \[truncated 64 chars\]/);
    assert.equal(forwarded.endsWith("DESTROY_AT_END"), true);
  });
});

describe("extension verdict cache", () => {
  it("reuses a verdict for canonically equal input but prompts for each ask", async () => {
    await setThresholds(0.51, 0.4);
    setClassifier("ask");
    const from = info.length;
    const first = await invokeTool(
      { toolName: "write", toolCallId: "cache-canonical-1", input: { path: "src/cache.txt", content: "x" } },
      true,
    );
    const second = await invokeTool(
      { toolName: "write", toolCallId: "cache-canonical-2", input: { content: "x", path: "src/cache.txt" } },
      true,
    );

    assert.equal(first.dialogs.length, 1);
    assert.equal(second.dialogs.length, 1);
    assert.equal(classificationCount(), 1);
    assert.deepEqual(approvalEvents(from), [
      { callId: "cache-canonical-1", tool: "write", source: "classifier", phase: "decision", outcome: "opened" },
      { callId: "cache-canonical-1", tool: "write", source: "classifier", phase: "decision", outcome: "allow_once" },
      { callId: "cache-canonical-2", tool: "write", source: "cache", phase: "decision", outcome: "opened" },
      { callId: "cache-canonical-2", tool: "write", source: "cache", phase: "decision", outcome: "allow_once" },
    ]);
  });

  it("drops cached verdicts when effective thresholds change", async () => {
    await setThresholds(0.52, 0.4);
    setClassifier("safe");
    await invoke("cargo cache-thresholds", false);
    await invoke("cargo cache-thresholds", false);
    assert.equal(classificationCount(), 1);

    await setThresholds(0.53, 0.4);
    await invoke("cargo cache-thresholds", false);
    assert.equal(classificationCount(), 2);
    assert.deepEqual(
      (globalThis as { __autoModeTestThresholds?: unknown }).__autoModeTestThresholds,
      { fire: 0.53, clear: 0.4 },
    );
  });

  it("evicts the least recently used verdict at the session bound", async () => {
    await setThresholds(0.54, 0.4);
    setClassifier("safe");
    await invoke("cargo cache-oldest", false);
    for (let index = 0; index < 127; index += 1) {
      await invoke(`cargo cache-${index}`, false);
    }
    await invoke("cargo cache-oldest", false);
    await invoke("cargo cache-overflow", false);
    await invoke("cargo cache-oldest", false);
    await invoke("cargo cache-0", false);

    assert.equal(classificationCount(), 130);
  });

  it("does not cache classifier failures", async () => {
    await setThresholds(0.55, 0.4);
    setClassifier(undefined);
    await invoke("cargo cache-failure", true);
    await invoke("cargo cache-failure", true);

    assert.equal(classificationCount(), 2);
  });
});

describe("trusted directory pre-approval", () => {
  let root: string;
  before(async () => {
    root = join(cwd, "trusted");
    await mkdir(root);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "auto-mode.json"), JSON.stringify({ allowPaths: [root] }));
  });
  after(async () => {
    await rm(join(agentDir, "auto-mode.json"));
    delete (globalThis as { __autoModeTestEditInspection?: unknown }).__autoModeTestEditInspection;
  });

  it("skips classification only for plain writes beneath a trusted root", async () => {
    setClassifier(undefined);
    const from = info.length;
    const inside = await invokeTool(
      { toolName: "write", toolCallId: "trusted-write", input: { path: join(root, "new.txt"), content: "x" } },
      false,
    );
    assert.equal(inside.result, undefined);
    assert.equal(classificationCount(), 0);
    assert.deepEqual(info.slice(from), ['auto-mode: path allow {"callId":"trusted-write","tool":"write"}']);

    const outside = await invokeTool(
      { toolName: "write", toolCallId: "outside-write", input: { path: join(cwd, "outside.txt"), content: "x" } },
      false,
    );
    assert.equal(outside.result?.block, true);
    assert.equal(classificationCount(), 1);
  });

  it("requires every inspected edit target and move destination to remain beneath the root", async () => {
    setClassifier(undefined);
    (globalThis as { __autoModeTestEditInspection?: unknown }).__autoModeTestEditInspection = {
      paths: [join(root, "new.txt")], entries: [], fileOps: [],
    };
    const inside = await invokeTool(
      { toolName: "edit", toolCallId: "trusted-edit", input: { patch: "edit" } },
      false,
    );
    assert.equal(inside.result, undefined);
    assert.equal(classificationCount(), 0);

    (globalThis as { __autoModeTestEditInspection?: unknown }).__autoModeTestEditInspection = {
      paths: [join(root, "new.txt")], entries: [], fileOps: [{ path: join(root, "new.txt"), to: join(cwd, "outside.txt") }],
    };
    const outside = await invokeTool(
      { toolName: "edit", toolCallId: "escaping-edit", input: { patch: "move" } },
      false,
    );
    assert.equal(outside.result?.block, true);
    assert.equal(classificationCount(), 1);
  });

  it("does not pre-approve eval or ast_edit merely because their input mentions the root", async () => {
    setClassifier(undefined);
    for (const toolName of ["eval", "ast_edit"]) {
      const invocation = await invokeTool(
        { toolName, toolCallId: `trusted-${toolName}`, input: { path: join(root, "new.txt") } },
        false,
      );
      assert.equal(invocation.result?.block, true);
    }
    assert.equal(classificationCount(), 2);
  });
});
