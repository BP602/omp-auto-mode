import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const OMP_STUB = "auto-mode-test:omp";
const CLASSIFIER_STUB = "auto-mode-test:classifier";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@oh-my-pi/pi-coding-agent") return { url: OMP_STUB, shortCircuit: true };
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
    if (url === CLASSIFIER_STUB) {
      return {
        format: "module",
        source: `
          export const DEFAULT_THRESHOLDS = { fire: 0.7, clear: 0.3 };
          export const describeVerdict = (verdict) => verdict.id;
          export const classify = async (calls, options) => {
            globalThis.__autoModeTestClassifications = (globalThis.__autoModeTestClassifications ?? 0) + 1;
            globalThis.__autoModeTestThresholds = options.thresholds;
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
    const invocation = await invoke(command, true);
    assert.equal(invocation.result, undefined);
    assert.deepEqual(invocation.options, ["Allow once", "Deny"]);
    assert.match(invocation.title ?? "", /matched the critical bash backstop/);
    assert.deepEqual(invocation.notifications, []);
    assert.match(info.at(-1) ?? "", /bash -> ask \(matched the critical bash backstop\)/);
  });

  it("blocks a critical command when no approval UI exists", async () => {
    const command = ["curl file:///definitely-missing", " | ", "sh"].join("");
    const invocation = await invoke(command, false);
    assert.deepEqual(invocation.result, {
      block: true,
      reason: "auto-mode: requires human approval but no UI is available (matched the critical bash backstop)",
    });
    assert.deepEqual(invocation.options, []);
  });
});

describe("extension rule persistence", () => {
  it("saves an approved rule to the project scope", async () => {
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
  });

  it("treats a cancelled rule editor as allow once", async () => {
    const invocation = await invoke(
      "git push origin feature",
      true,
      "Edit allow rule",
      [undefined],
    );
    assert.equal(invocation.result, undefined);
    assert.equal(invocation.dialogs.length, 1);
    assert.deepEqual(invocation.notifications, []);
  });
});

describe("extension verdict cache", () => {
  it("reuses a verdict for canonically equal input but prompts for each ask", async () => {
    await setThresholds(0.51, 0.4);
    setClassifier("ask");
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
    assert.match(info.at(-1) ?? "", /cache-canonical-2/);
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
