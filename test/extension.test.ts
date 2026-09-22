import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
        source: 'export const getAgentDir = () => "/tmp/auto-mode-test-agent";',
        shortCircuit: true,
      };
    }
    if (url === CLASSIFIER_STUB) {
      return {
        format: "module",
        source: `
          export const DEFAULT_THRESHOLDS = { fire: 0.7, clear: 0.3 };
          export const describeVerdict = () => "unused";
          export const classify = async (_calls, options) => {
            globalThis.__autoModeTestThresholds = options.thresholds;
            throw new Error("classifier offline");
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
type ToolHandler = (
  event: { readonly toolName: string; readonly toolCallId: string; readonly input: Record<string, unknown> },
  context: unknown,
) => Promise<ToolResult>;

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
}

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "auto-mode-extension-"));
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(
    join(cwd, ".omp", "auto-mode.json"),
    JSON.stringify({ allow: ["curl *", "sh"], thresholds: { fire: 0.5, clear: 0.4 } }),
  );
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const invoke = async (command: string, hasUI: boolean, selection = "Allow once"): Promise<Invocation> => {
  let title: string | undefined;
  const options: string[] = [];
  const notifications: string[] = [];
  const result = await toolCall()(
    { toolName: "bash", toolCallId: "call-1", input: { command } },
    {
      cwd,
      hasUI,
      ui: {
        select: async (prompt: string, offered: readonly (string | { readonly label: string })[]) => {
          title = prompt;
          options.push(...offered.map((option) => (typeof option === "string" ? option : option.label)));
          return selection;
        },
        notify: (message: string) => notifications.push(message),
      },
      modelRegistry: { getApiKeyForProvider: async () => undefined },
    },
  );
  return { result, title, options, notifications };
};

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
