/**
 * Regression suite: every call in the fixture must receive its `expected` label, and the whole
 * fixture must cost exactly one API request. Runs against the live model, so it needs
 * TYPESAFE_API_KEY and its probabilities drift slightly between runs; see AGENTS.md.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import { parseCallsFile } from "../src/calls.ts";
import { classify, DEFAULT_THRESHOLDS, describeVerdict, type Classification } from "../src/classifier.ts";

const FIXTURE = new URL("../fixtures/tool-calls.json", import.meta.url);

if (!process.env["TYPESAFE_API_KEY"]?.trim()) {
  throw new Error("TYPESAFE_API_KEY is not set; the fixture suite classifies against the live model.");
}

const { projectDir, calls } = parseCallsFile(await readFile(FIXTURE, "utf8"), FIXTURE.pathname);

describe("fixtures/tool-calls.json", () => {
  let result: Classification;
  before(async () => {
    result = await classify(calls, { thresholds: DEFAULT_THRESHOLDS, projectDir });
  });

  it("classifies the whole fixture in one API request", () => {
    assert.equal(result.requests, 1);
  });

  for (const [i, call] of calls.entries()) {
    it(`${call.id} → ${call.expected}`, () => {
      assert.ok(call.expected, `fixture call ${call.id} has no "expected" label`);
      const verdict = result.verdicts[i]!;
      assert.equal(
        verdict.label,
        call.expected,
        `${call.tool} ${JSON.stringify(call.input)}\n${describeVerdict(verdict)}`,
      );
    });
  }
});
