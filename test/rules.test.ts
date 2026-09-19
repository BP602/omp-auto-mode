import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { appendAllowRule, decide, InvalidRule, loadRules, parseRule, suggestRules, tokenize, type Rules } from "../src/rules.ts";

describe("tokenize", () => {
  it("splits a flat command on whitespace", () => {
    assert.deepEqual(tokenize("git  status\t--short"), ["git", "status", "--short"]);
  });

  it("honours plain quotes without treating them as part of the argument", () => {
    assert.deepEqual(tokenize(`git commit -m "fix: handle null" -m 'second line'`), [
      "git",
      "commit",
      "-m",
      "fix: handle null",
      "-m",
      "second line",
    ]);
  });

  it("refuses anything with shell semantics beyond a flat argv", () => {
    for (const command of [
      "git status; rm -rf ~",
      "git status && rm -rf ~",
      "git status || true",
      "git status | sh",
      "cat $(echo x)",
      "cat `echo x`",
      "echo ${HOME}",
      "ls > out.txt",
      "ls < in.txt",
      "rm -rf ~/",
      "ls *.ts",
      "ls file?",
      "echo {a,b}",
      "echo hi # comment",
      "echo 'unterminated",
      `echo "$HOME"`,
      `echo "back\\slash"`,
      "echo a\\ b",
      "ls\nrm -rf ~",
      "",
      "   ",
    ]) {
      assert.equal(tokenize(command), undefined, command);
    }
  });
});

describe("parseRule", () => {
  it("accepts a trailing wildcard only", () => {
    assert.deepEqual(parseRule("npm run *"), ["npm", "run", "*"]);
    assert.throws(() => parseRule("npm * test"), InvalidRule);
    assert.throws(() => parseRule("*"), InvalidRule);
    assert.throws(() => parseRule("   "), InvalidRule);
  });
});

describe("decide", () => {
  const rules: Rules = {
    allow: [parseRule("git status"), parseRule("npm run *"), parseRule("git push")],
    deny: [parseRule("npm run deploy"), parseRule("git push --force *")],
  };

  it("matches exact rules exactly", () => {
    assert.equal(decide(rules, ["git", "status"]), "allow");
    assert.equal(decide(rules, ["git", "status", "--short"]), undefined);
    assert.equal(decide(rules, ["git"]), undefined);
  });

  it("matches wildcard rules as a prefix, including with no extra arguments", () => {
    assert.equal(decide(rules, ["npm", "run"]), "allow");
    assert.equal(decide(rules, ["npm", "run", "test"]), "allow");
    assert.equal(decide(rules, ["npm", "run", "test", "--", "--watch"]), "allow");
    assert.equal(decide(rules, ["npm", "test"]), undefined);
  });

  it("lets deny win over allow", () => {
    assert.equal(decide(rules, ["npm", "run", "deploy"]), "deny");
    assert.equal(decide(rules, ["git", "push", "--force", "origin", "main"]), "deny");
    assert.equal(decide(rules, ["git", "push"]), "allow");
  });
});

describe("suggestRules", () => {
  it("offers the exact command, plus a two-token prefix when there are more arguments", () => {
    assert.deepEqual(suggestRules(["git", "status"]), [["git", "status"]]);
    assert.deepEqual(suggestRules(["git", "push", "origin", "feature/login"]), [
      ["git", "push", "origin", "feature/login"],
      ["git", "push", "*"],
    ]);
  });
});

describe("rules files", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-mode-rules-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats missing files as empty and merges the rest", async () => {
    const project = join(dir, "project", "auto-mode.json");
    const user = join(dir, "user", "auto-mode.json");
    assert.deepEqual(await loadRules([project, user]), { allow: [], deny: [] });

    await appendAllowRule(project, ["git", "status"]);
    await appendAllowRule(user, ["npm", "run", "*"]);
    await appendAllowRule(project, ["ls"]);

    assert.deepEqual(await loadRules([project, user]), {
      allow: [["git", "status"], ["ls"], ["npm", "run", "*"]],
      deny: [],
    });
    assert.deepEqual(JSON.parse(await readFile(project, "utf8")), { allow: ["git status", "ls"] });
  });

  it("rejects malformed files instead of silently ignoring them", async () => {
    const path = join(dir, "bad.json");
    await appendAllowRule(path, ["ok"]);
    await writeFile(path, JSON.stringify({ allow: "git status" }));
    await assert.rejects(loadRules([path]), InvalidRule);
  });
});
