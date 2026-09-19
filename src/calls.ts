/**
 * JSON batch input: `{ "project_dir": "...", "calls": [{ "id", "tool", "input", "expected"? }] }`.
 *
 * The production CLI and the regression fixture share this shape. `expected` is optional and
 * ignored by the CLI; the test suite uses it to check labels.
 */
import { LABELS, type Label, type ToolCall } from "./classifier.ts";

export interface LabelledCall extends ToolCall {
  readonly expected?: Label;
}

export interface CallsFile {
  readonly projectDir: string;
  readonly calls: readonly LabelledCall[];
}

/** The file is missing, not JSON, or not the shape above. */
export class InvalidCallsFile extends Error {}

const isLabel = (value: unknown): value is Label => (LABELS as readonly unknown[]).includes(value);

/** Validate with `in` narrowing; each field is checked exactly where it is used. */
export const parseCallsFile = (raw: string, path: string): CallsFile => {
  const invalid = (what: string): never => {
    throw new InvalidCallsFile(`${path}: ${what}`);
  };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return invalid(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof data !== "object" || data === null) return invalid("must be an object");

  const projectDir = "project_dir" in data ? data.project_dir : undefined;
  if (typeof projectDir !== "string") return invalid('"project_dir" must be a string');
  const rawCalls: unknown[] = "calls" in data && Array.isArray(data.calls) ? data.calls : [];
  if (rawCalls.length === 0) return invalid('"calls" must be a non-empty array');

  const seen = new Set<string>();
  const calls = rawCalls.map((call, i): LabelledCall => {
    if (typeof call !== "object" || call === null) return invalid(`calls[${i}] must be an object`);
    const id = "id" in call ? call.id : undefined;
    if (typeof id !== "string" || seen.has(id)) return invalid(`calls[${i}].id must be a unique string`);
    seen.add(id);
    const tool = "tool" in call ? call.tool : undefined;
    if (typeof tool !== "string") return invalid(`calls[${i}].tool must be a string`);
    const input = "input" in call ? call.input : undefined;
    if (typeof input !== "object" || input === null) return invalid(`calls[${i}].input must be an object`);
    const expected = "expected" in call ? call.expected : undefined;
    if (expected !== undefined && !isLabel(expected)) {
      return invalid(`calls[${i}].expected must be one of ${LABELS.join(", ")}`);
    }
    // Input values are forwarded to the model verbatim; the classifier's primitive-only type is
    // a contract for callers building inputs in code, not something worth validating from JSON.
    return { id, tool, input: input as ToolCall["input"], ...(expected === undefined ? {} : { expected }) };
  });

  return { projectDir, calls };
};
