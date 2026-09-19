#!/usr/bin/env node
/**
 * Command-line front-end for the classifier.
 *
 * Batch mode classifies every call in a JSON file; command mode classifies a single bash command.
 * Both go through the same one-request `classify()` and print the same JSON envelope.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { InvalidCallsFile, parseCallsFile } from "./calls.ts";
import { classify, DEFAULT_THRESHOLDS, type Classification, type Thresholds, type ToolCall } from "./classifier.ts";

const EXIT = { ok: 0, usage: 2, api: 3 } as const;

const USAGE = `usage: omp-auto-mode <calls.json> [options]
       omp-auto-mode [options] -- <command> [args...]

Batch mode: classify every tool call in a JSON file ({ "project_dir", "calls": [{ "id",
"tool", "input" }] }) with one Jev request.

Command mode: classify one bash command (everything after "--").

Either way the verdicts are printed as JSON on stdout.

options:
  --fire <0..1>              hazard probability at or above which the hazard holds
                             (default ${DEFAULT_THRESHOLDS.fire}; env AUTO_MODE_FIRE)
  --clear <0..1>             hazard probability below which the hazard is absent; values in
                             [clear, fire) are uncertain and route to "ask"
                             (default ${DEFAULT_THRESHOLDS.clear}; env AUTO_MODE_CLEAR)
  --project-dir <path>       project directory the command runs in; command mode only
                             (default: current directory)
  --model <name>             Jev model or alias (default: SDK default, jev-latest)
  -h, --help

exit codes: ${EXIT.ok} success; ${EXIT.usage} usage/config; ${EXIT.api} API failure
`;

/** Thrown for any failure the CLI reports itself; caught once at the entry point. */
class CliError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const usageError = (message: string): never => {
  throw new CliError(EXIT.usage, message);
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CommonOptions {
  readonly thresholds: Thresholds;
  readonly model?: string;
}

interface BatchInvocation extends CommonOptions {
  readonly mode: "batch";
  readonly path: string;
}

interface CommandInvocation extends CommonOptions {
  readonly mode: "command";
  readonly command: string;
  readonly projectDir: string;
}

type Invocation = { readonly mode: "help" } | BatchInvocation | CommandInvocation;

const parseThreshold = (flag: string, fromFlag: string | undefined, fromEnv: string | undefined, fallback: number): number => {
  const raw = fromFlag ?? fromEnv;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return usageError(`${flag} must be a number between 0 and 1, got ${raw}`);
  return value;
};

/** Split argv on `--`: options and an optional file path before it, the command after it. */
const parseCli = (argv: readonly string[]): Invocation => {
  const separator = argv.indexOf("--");
  const command = separator === -1 ? undefined : argv.slice(separator + 1).join(" ");
  const { values, positionals } = parseArgs({
    args: separator === -1 ? [...argv] : argv.slice(0, separator),
    options: {
      fire: { type: "string" },
      clear: { type: "string" },
      "project-dir": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) return { mode: "help" };

  const thresholds: Thresholds = {
    fire: parseThreshold("--fire", values.fire, process.env["AUTO_MODE_FIRE"], DEFAULT_THRESHOLDS.fire),
    clear: parseThreshold("--clear", values.clear, process.env["AUTO_MODE_CLEAR"], DEFAULT_THRESHOLDS.clear),
  };
  if (thresholds.clear > thresholds.fire) {
    return usageError(`--clear (${thresholds.clear}) must not exceed --fire (${thresholds.fire})`);
  }
  const common: CommonOptions = { thresholds, ...(values.model === undefined ? {} : { model: values.model }) };

  if (command !== undefined) {
    if (command === "" || positionals.length !== 0) return usageError(USAGE);
    return { ...common, mode: "command", command, projectDir: values["project-dir"] ?? process.cwd() };
  }
  const path = positionals[0];
  if (path === undefined || positionals.length !== 1 || values["project-dir"] !== undefined) return usageError(USAGE);
  return { ...common, mode: "batch", path };
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const printVerdicts = (calls: readonly ToolCall[], result: Classification, thresholds: Thresholds): void => {
  const envelope = {
    model: result.model,
    thresholds,
    verdicts: result.verdicts.map((verdict, i) => ({
      id: verdict.id,
      tool: calls[i]!.tool,
      input: calls[i]!.input,
      label: verdict.label,
      triggered: verdict.triggered,
      uncertain: verdict.uncertain,
      hazards: verdict.hazards,
    })),
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
};

const run = async (invocation: Invocation): Promise<number> => {
  if (invocation.mode === "help") {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (!process.env["TYPESAFE_API_KEY"]?.trim()) {
    return usageError("TYPESAFE_API_KEY is not set; export it before running the classifier.");
  }

  const { thresholds, model } = invocation;
  const options = { thresholds, ...(model === undefined ? {} : { model }) };

  if (invocation.mode === "command") {
    const calls: ToolCall[] = [{ id: "command", tool: "bash", input: { command: invocation.command } }];
    printVerdicts(calls, await classify(calls, { ...options, projectDir: invocation.projectDir }), thresholds);
    return EXIT.ok;
  }

  const file = parseCallsFile(await readFile(invocation.path, "utf8"), invocation.path);
  printVerdicts(file.calls, await classify(file.calls, { ...options, projectDir: file.projectDir }), thresholds);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Set exitCode rather than calling process.exit(): stdout may be a pipe whose writes are still
// pending, and exit() would truncate them.
try {
  process.exitCode = await run(parseCli(process.argv.slice(2)));
} catch (err: unknown) {
  const [code, message] =
    err instanceof CliError ? [err.code, err.message]
    : err instanceof InvalidCallsFile ? [EXIT.usage, err.message]
    : err instanceof Error && "code" in err && err.code === "ENOENT" ? [EXIT.usage, err.message]
    : err instanceof APIError ? [EXIT.api, `API error ${err.status}: ${err.message}`]
    : err instanceof TypeSafeError ? [EXIT.api, err.message]
    : [EXIT.api, err instanceof Error ? (err.stack ?? err.message) : String(err)];
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}
