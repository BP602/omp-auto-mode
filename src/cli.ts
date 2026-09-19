#!/usr/bin/env node
/**
 * Command-line front-end for the classifier.
 *
 * Fixture mode runs a labelled corpus and exits 0 only on a perfect match, which makes the fixture
 * the regression suite. Command mode classifies a single bash command and prints a JSON verdict.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { APIError, TypeSafeError } from "@typesafe-ai/sdk";
import {
  classify,
  DEFAULT_THRESHOLDS,
  describeVerdict,
  LABELS,
  type Label,
  type Thresholds,
  type ToolCall,
} from "./classifier.ts";

const EXIT = {
  ok: 0,
  /** Fixture mismatch, or the classifier issued more than one API request. */
  mismatch: 1,
  usage: 2,
  api: 3,
} as const;

const USAGE = `usage: omp-auto-mode <fixture.json> [options]
       omp-auto-mode [options] -- <command> [args...]

Fixture mode: classify every tool call in the fixture as safe | ask | unsafe with one
Jev request and exit 0 only when every derived label equals the fixture's expected label.

Command mode: classify one bash command (everything after "--") and print the
verdict as JSON on stdout.

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

exit codes: ${EXIT.ok} success (fixture: all labels match); ${EXIT.mismatch} fixture mismatch or request count != 1;
            ${EXIT.usage} usage/config; ${EXIT.api} API failure
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

interface FixtureInvocation extends CommonOptions {
  readonly mode: "fixture";
  readonly path: string;
}

interface CommandInvocation extends CommonOptions {
  readonly mode: "command";
  readonly command: string;
  readonly projectDir: string;
}

type Invocation = { readonly mode: "help" } | FixtureInvocation | CommandInvocation;

const parseThreshold = (flag: string, fromFlag: string | undefined, fromEnv: string | undefined, fallback: number): number => {
  const raw = fromFlag ?? fromEnv;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return usageError(`${flag} must be a number between 0 and 1, got ${raw}`);
  return value;
};

/** Split argv on `--`: options and an optional fixture path before it, the command after it. */
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
  return { ...common, mode: "fixture", path };
};

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface Sample extends ToolCall {
  readonly expected: Label;
}

interface Fixture {
  readonly project_dir: string;
  readonly samples: readonly Sample[];
}

const isLabel = (value: unknown): value is Label => (LABELS as readonly unknown[]).includes(value);

/** Validate the JSON shape with `in` narrowing; each field is checked exactly where it is used. */
const parseFixture = (raw: string, path: string): Fixture => {
  const invalid = (what: string): never => usageError(`${path}: ${what}`);
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) return invalid("fixture must be an object");

  const project_dir = "project_dir" in data ? data.project_dir : undefined;
  if (typeof project_dir !== "string") return invalid('"project_dir" must be a string');
  const samples: unknown[] = "samples" in data && Array.isArray(data.samples) ? data.samples : [];
  if (samples.length === 0) return invalid('"samples" must be a non-empty array');

  const seen = new Set<string>();
  const parsed = samples.map((sample, i): Sample => {
    if (typeof sample !== "object" || sample === null) return invalid(`samples[${i}] must be an object`);
    const id = "id" in sample ? sample.id : undefined;
    if (typeof id !== "string" || seen.has(id)) return invalid(`samples[${i}].id must be a unique string`);
    seen.add(id);
    const tool = "tool" in sample ? sample.tool : undefined;
    if (typeof tool !== "string") return invalid(`samples[${i}].tool must be a string`);
    const input = "input" in sample ? sample.input : undefined;
    if (typeof input !== "object" || input === null) return invalid(`samples[${i}].input must be an object`);
    const expected = "expected" in sample ? sample.expected : undefined;
    if (!isLabel(expected)) return invalid(`samples[${i}].expected must be one of ${LABELS.join(", ")}`);
    // Input values are forwarded to the model verbatim; the classifier's primitive-only type is
    // a contract for callers building inputs in code, not something worth validating from JSON.
    return { id, tool, input: input as ToolCall["input"], expected };
  });
  return { project_dir, samples: parsed };
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const runCommand = async ({ command, projectDir, thresholds, model }: CommandInvocation): Promise<number> => {
  const call: ToolCall = { id: "command", tool: "bash", input: { command } };
  const result = await classify([call], { thresholds, projectDir, ...(model === undefined ? {} : { model }) });
  const verdict = result.verdicts[0]!;

  const report = {
    tool: call.tool,
    input: call.input,
    label: verdict.label,
    triggered: verdict.triggered,
    uncertain: verdict.uncertain,
    hazards: verdict.hazards,
    thresholds,
    model: result.model,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return EXIT.ok;
};

const runFixture = async ({ path, thresholds, model }: FixtureInvocation): Promise<number> => {
  const fixture = parseFixture(await readFile(path, "utf8"), path);
  const result = await classify(fixture.samples, {
    thresholds,
    projectDir: fixture.project_dir,
    ...(model === undefined ? {} : { model }),
  });

  const idWidth = Math.max(...fixture.samples.map((sample) => sample.id.length));
  let matched = 0;
  for (const [i, verdict] of result.verdicts.entries()) {
    const sample = fixture.samples[i]!;
    const ok = verdict.label === sample.expected;
    if (ok) matched += 1;
    const input = JSON.stringify(sample.input).slice(0, 60);
    process.stdout.write(
      `${ok ? "ok  " : "FAIL"} ${sample.id.padEnd(idWidth)}  got=${verdict.label.padEnd(6)} want=${sample.expected.padEnd(6)}` +
        `  ${sample.tool} ${input}\n      ${describeVerdict(verdict)}\n`,
    );
  }

  const total = fixture.samples.length;
  process.stdout.write(
    `\n${matched}/${total} matched  model=${result.model}  requests=${result.requests}` +
      `  tokens=${result.usage.input_tokens}in/${result.usage.output_tokens}out` +
      `  thresholds fire>=${thresholds.fire} clear<${thresholds.clear}\n`,
  );

  if (result.requests !== 1) {
    process.stderr.write(`expected exactly 1 API request, observed ${result.requests}\n`);
    return EXIT.mismatch;
  }
  return matched === total ? EXIT.ok : EXIT.mismatch;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const run = async (invocation: Invocation): Promise<number> => {
  if (invocation.mode === "help") {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (!process.env["TYPESAFE_API_KEY"]?.trim()) {
    return usageError("TYPESAFE_API_KEY is not set; export it before running the classifier.");
  }
  return invocation.mode === "command" ? runCommand(invocation) : runFixture(invocation);
};

// Set exitCode rather than calling process.exit(): stdout may be a pipe whose writes are still
// pending, and exit() would truncate them.
try {
  process.exitCode = await run(parseCli(process.argv.slice(2)));
} catch (err: unknown) {
  const [code, message] =
    err instanceof CliError ? [err.code, err.message]
    : err instanceof APIError ? [EXIT.api, `API error ${err.status}: ${err.message}`]
    : err instanceof TypeSafeError ? [EXIT.api, err.message]
    : err instanceof SyntaxError ? [EXIT.usage, `fixture is not valid JSON: ${err.message}`]
    : err instanceof Error && "code" in err && err.code === "ENOENT" ? [EXIT.usage, err.message]
    : [EXIT.api, err instanceof Error ? (err.stack ?? err.message) : String(err)];
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}
