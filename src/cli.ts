#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { APIError, TypeSafeError } from "@typesafe-ai/sdk";
import {
  classify,
  DEFAULT_THRESHOLDS,
  LABELS,
  type Label,
  type Thresholds,
  type ToolCall,
} from "./classifier.ts";

interface Sample extends ToolCall {
  readonly expected: Label;
}

interface Fixture {
  readonly project_dir: string;
  readonly samples: readonly Sample[];
}

const USAGE = `usage: omp-auto-mode <fixture.json> [options]
       omp-auto-mode [options] -- <command> [args...]

Fixture mode: classify every tool call in the fixture as safe | ask | unsafe with one
Jev request and exit 0 only when every derived label equals the fixture's expected label.

Command mode: classify one bash command (everything after "--") and print the
verdict as JSON on stdout.

options:
  --ask-threshold <0..1>     P(ask or unsafe) at or above which the label is "ask"
                             (default ${DEFAULT_THRESHOLDS.ask}; env AUTO_MODE_ASK_THRESHOLD)
  --unsafe-threshold <0..1>  P(unsafe) at or above which the label is "unsafe"
                             (default ${DEFAULT_THRESHOLDS.unsafe}; env AUTO_MODE_UNSAFE_THRESHOLD)
  --min-confidence <0..1>    confidence below which any verdict becomes "ask"
                             (default ${DEFAULT_THRESHOLDS.minConfidence}; env AUTO_MODE_MIN_CONFIDENCE)
  --project-dir <path>       project directory the command runs in; command mode only
                             (default: current directory)
  --model <name>             Jev model or alias (default: SDK default, jev-latest)
  -h, --help

exit codes: 0 success (fixture: all labels match); 1 fixture mismatch or request count != 1;
            2 usage/config; 3 API failure
`;

const fail = (code: number, message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const isLabel = (value: unknown): value is Label => LABELS.includes(value as Label);

const parseFixture = (raw: string, path: string): Fixture => {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) return fail(2, `${path}: fixture must be an object`);
  const { project_dir, samples } = data as Record<string, unknown>;
  if (typeof project_dir !== "string") return fail(2, `${path}: "project_dir" must be a string`);
  if (!Array.isArray(samples) || samples.length === 0) return fail(2, `${path}: "samples" must be a non-empty array`);
  const seen = new Set<string>();
  for (const [i, sample] of samples.entries()) {
    const s = sample as Record<string, unknown>;
    if (typeof s["id"] !== "string" || seen.has(s["id"])) return fail(2, `${path}: samples[${i}].id must be a unique string`);
    seen.add(s["id"]);
    if (typeof s["tool"] !== "string") return fail(2, `${path}: samples[${i}].tool must be a string`);
    if (typeof s["input"] !== "object" || s["input"] === null) return fail(2, `${path}: samples[${i}].input must be an object`);
    if (!isLabel(s["expected"])) return fail(2, `${path}: samples[${i}].expected must be one of ${LABELS.join(", ")}`);
  }
  return { project_dir, samples: samples as Sample[] };
};

const parseThreshold = (name: string, flag: string | undefined, env: string | undefined, fallback: number): number => {
  const raw = flag ?? env;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fail(2, `${name} must be a number between 0 and 1, got ${raw}`);
  return value;
};

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const command = separator === -1 ? undefined : argv.slice(separator + 1).join(" ");
  const { values, positionals } = parseArgs({
    args: separator === -1 ? argv : argv.slice(0, separator),
    options: {
      "ask-threshold": { type: "string" },
      "unsafe-threshold": { type: "string" },
      "min-confidence": { type: "string" },
      "project-dir": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const fixturePath = positionals[0];
  if (command !== undefined) {
    if (command === "" || positionals.length !== 0) return fail(2, USAGE);
  } else if (fixturePath === undefined || positionals.length !== 1 || values["project-dir"] !== undefined) {
    return fail(2, USAGE);
  }

  if (!process.env["TYPESAFE_API_KEY"]?.trim()) {
    return fail(2, "TYPESAFE_API_KEY is not set; export it before running the classifier.");
  }

  const thresholds: Thresholds = {
    ask: parseThreshold("--ask-threshold", values["ask-threshold"], process.env["AUTO_MODE_ASK_THRESHOLD"], DEFAULT_THRESHOLDS.ask),
    unsafe: parseThreshold("--unsafe-threshold", values["unsafe-threshold"], process.env["AUTO_MODE_UNSAFE_THRESHOLD"], DEFAULT_THRESHOLDS.unsafe),
    minConfidence: parseThreshold("--min-confidence", values["min-confidence"], process.env["AUTO_MODE_MIN_CONFIDENCE"], DEFAULT_THRESHOLDS.minConfidence),
  };

  const model = values.model === undefined ? {} : { model: values.model };

  if (command !== undefined) {
    const call: ToolCall = { id: "command", tool: "bash", input: { command } };
    const result = await classify([call], { thresholds, projectDir: values["project-dir"] ?? process.cwd(), ...model });
    const verdict = result.verdicts[0]!;
    const [safe, ask, unsafe] = verdict.probabilities;
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: call.tool,
          input: call.input,
          label: verdict.label,
          probabilities: { safe, ask, unsafe },
          expected_score: verdict.expected,
          confidence: verdict.confidence,
          thresholds,
          model: result.model,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const fixture = parseFixture(await readFile(fixturePath!, "utf8"), fixturePath!);

  const result = await classify(fixture.samples, { thresholds, projectDir: fixture.project_dir, ...model });

  const idWidth = Math.max(...fixture.samples.map((s) => s.id.length));
  let matched = 0;
  for (const [i, verdict] of result.verdicts.entries()) {
    const sample = fixture.samples[i]!;
    const ok = verdict.label === sample.expected;
    if (ok) matched += 1;
    const probs = verdict.probabilities.map((p) => p.toFixed(2)).join("/");
    const summary = JSON.stringify(sample.input);
    process.stdout.write(
      `${ok ? "ok  " : "FAIL"} ${sample.id.padEnd(idWidth)}  got=${verdict.label.padEnd(6)} want=${sample.expected.padEnd(6)}` +
        ` p(safe/ask/unsafe)=${probs} conf=${verdict.confidence.toFixed(2)}  ${sample.tool} ${summary.slice(0, 70)}\n`,
    );
  }

  const total = fixture.samples.length;
  process.stdout.write(
    `\n${matched}/${total} matched  model=${result.model}  requests=${result.requests}` +
      `  tokens=${result.usage.input_tokens}in/${result.usage.output_tokens}out` +
      `  thresholds ask>=${thresholds.ask} unsafe>=${thresholds.unsafe} conf>=${thresholds.minConfidence}\n`,
  );

  if (result.requests !== 1) {
    process.stderr.write(`expected exactly 1 API request, observed ${result.requests}\n`);
    return 1;
  }
  return matched === total ? 0 : 1;
};

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof APIError) return fail(3, `API error ${err.status}: ${err.message}`);
    if (err instanceof TypeSafeError) return fail(3, err.message);
    if (err instanceof SyntaxError) return fail(2, `fixture is not valid JSON: ${err.message}`);
    return fail(3, err instanceof Error ? err.stack ?? err.message : String(err));
  },
);
