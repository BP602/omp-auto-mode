import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { appendAllowRule, decide, InvalidRule, loadRules, parseRule, suggestRules, tokenize, type Rules } from "../src/rules.ts";

describe("tokenize", () => {
  it("splits a flat command on whitespace", () => {
    assert.deepEqual(tokenize("git  status\t--short"), [["git", "status", "--short"]]);
  });

  it("honours plain quotes without treating them as part of the argument", () => {
    assert.deepEqual(tokenize(`git commit -m "fix: handle null" -m 'second line'`), [
      ["git", "commit", "-m", "fix: handle null", "-m", "second line"],
    ]);
  });

  it("drops redirections that cannot touch a file: /dev/null targets and descriptor dups", () => {
    const cases: Record<string, readonly (readonly string[])[]> = {
      "npm install -g ccusage 2>&1": [["npm", "install", "-g", "ccusage"]],
      "echo hi >/dev/null": [["echo", "hi"]],
      "echo hi > /dev/null": [["echo", "hi"]],
      "echo hi >> /dev/null": [["echo", "hi"]],
      "echo hi 2>/dev/null": [["echo", "hi"]],
      "echo hi 2> /dev/null": [["echo", "hi"]],
      "echo hi &>/dev/null": [["echo", "hi"]],
      "echo hi &>> /dev/null": [["echo", "hi"]],
      "echo hi >/dev/null 2>&1": [["echo", "hi"]],
      "echo hi 2>&1 >/dev/null": [["echo", "hi"]],
      "echo hi >&2": [["echo", "hi"]],
      "cat x < /dev/null": [["cat", "x"]],
      "echo 2 > /dev/null": [["echo", "2"]],
      'echo ">/dev/null"': [["echo", ">/dev/null"]],
      "echo a>/dev/null b": [["echo", "a", "b"]],
    };
    for (const [command, chain] of Object.entries(cases)) assert.deepEqual(tokenize(command), chain, command);
  });

  it("splits a top-level chain into one argv per command", () => {
    const cases: Record<string, readonly (readonly string[])[]> = {
      "git add -A && git commit -m 'wip'": [["git", "add", "-A"], ["git", "commit", "-m", "wip"]],
      "cd /tmp && rm -rf build": [["cd", "/tmp"], ["rm", "-rf", "build"]],
      "git status; git diff": [["git", "status"], ["git", "diff"]],
      "git status || true": [["git", "status"], ["true"]],
      "git status | sh": [["git", "status"], ["sh"]],
      "a && b && c": [["a"], ["b"], ["c"]],
      "ls;": [["ls"]],
      // A separator inside quotes belongs to the argument, not to the chain.
      'git commit -m "a;b" && git push': [["git", "commit", "-m", "a;b"], ["git", "push"]],
      // Redirections are still dropped when a separator follows the target.
      "npm test 2>&1 | tee /dev/null": [["npm", "test"], ["tee", "/dev/null"]],
      "echo hi >/dev/null; ls": [["echo", "hi"], ["ls"]],
    };
    for (const [command, chain] of Object.entries(cases)) assert.deepEqual(tokenize(command), chain, command);
  });

  it("refuses anything with shell semantics beyond a flat chain", () => {
    for (const command of [
      "cat $(echo x)",
      "cat `echo x`",
      "echo ${HOME}",
      "ls > out.txt",
      "ls >> out.txt",
      "ls 2> err.txt",
      "ls &> out.txt",
      "ls < in.txt",
      "ls <<< text",
      "cat < ~/.ssh/id_rsa",
      "ls >/dev/null2",
      "ls >/dev/null/x",
      "ls >/dev/./null",
      "ls > /dev/nul",
      "ls >",
      "ls 2>&3",
      "ls <&0",
      "ls >2",
      "diff <(ls a) <(ls b)",
      "ls >/dev/null2; ls",
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
      // Backgrounding, dangling separators, and `case` syntax are not a chain we model.
      "sleep 10 &",
      "npm run dev & npm test",
      "ls &&",
      "ls ||",
      "ls |",
      "&& ls",
      "| ls",
      "ls && && rm",
      "case x in a);; esac",
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
    allow: [parseRule("git status"), parseRule("npm run *"), parseRule("git commit -m wip"), parseRule("cd *")],
    ask: [parseRule("npm run deploy"), parseRule("git push *"), parseRule("git commit *")],
  };
  const chain = (command: string) => tokenize(command)!;

  it("matches exact rules exactly", () => {
    assert.deepEqual(decide(rules, chain("git status")), { tier: "allow" });
    assert.equal(decide(rules, chain("git status --short")), undefined);
    assert.equal(decide(rules, chain("git")), undefined);
  });

  it("matches wildcard rules as a prefix, including with no extra arguments", () => {
    assert.deepEqual(decide(rules, chain("npm run")), { tier: "allow" });
    assert.deepEqual(decide(rules, chain("npm run test")), { tier: "allow" });
    assert.deepEqual(decide(rules, chain("npm run test -- --watch")), { tier: "allow" });
    assert.equal(decide(rules, chain("npm test")), undefined);
  });

  it("reports the ask rule that governs, so the dialog can name it", () => {
    assert.deepEqual(decide(rules, chain("git push origin main")), { tier: "ask", rule: ["git", "push", "*"] });
    assert.deepEqual(decide(rules, chain("npm run deploy")), { tier: "ask", rule: ["npm", "run", "deploy"] });
  });

  it("lets the most specific rule govern, with ask winning a tie", () => {
    // The exact allow rule a user persisted from the dialog outranks the ask rule that raised it.
    assert.deepEqual(decide(rules, chain("git commit -m wip")), { tier: "allow" });
    assert.deepEqual(decide(rules, chain("git commit -m other")), { tier: "ask", rule: ["git", "commit", "*"] });
    const tie: Rules = { allow: [parseRule("git push *")], ask: [parseRule("git push *")] };
    assert.deepEqual(decide(tie, chain("git push origin main")), { tier: "ask", rule: ["git", "push", "*"] });
  });

  it("asks for the whole chain when any command asks, and allows only when every command does", () => {
    assert.deepEqual(decide(rules, chain("cd /tmp && npm run build")), { tier: "allow" });
    assert.deepEqual(decide(rules, chain("npm run build && git push")), { tier: "ask", rule: ["git", "push", "*"] });
    // `git add` is covered by no rule: an ask rule elsewhere in the chain still wins.
    assert.deepEqual(decide(rules, chain("git add -A && git commit -m 'fix login'")), {
      tier: "ask",
      rule: ["git", "commit", "*"],
    });
    // An exact allow rule still governs its own command: here nothing asks, but `git add` is
    // uncovered, so the chain goes to the classifier rather than running unannounced.
    assert.equal(decide(rules, chain("git add -A && git commit -m wip")), undefined);
    // …but one uncovered command is enough to deny the chain an allow.
    assert.equal(decide(rules, chain("git status && git add -A")), undefined);
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
    assert.deepEqual(await loadRules([project, user]), { allow: [], ask: [] });

    await appendAllowRule(project, ["git", "status"]);
    await mkdir(join(dir, "user"), { recursive: true });
    await writeFile(user, JSON.stringify({ allow: ["npm run *"], ask: ["git push *"] }));
    await appendAllowRule(project, ["ls"]);

    assert.deepEqual(await loadRules([project, user]), {
      allow: [["git", "status"], ["ls"], ["npm", "run", "*"]],
      ask: [["git", "push", "*"]],
    });
    assert.deepEqual(JSON.parse(await readFile(project, "utf8")), { allow: ["git status", "ls"] });
  });

  it("keeps the ask list when appending an allow rule", async () => {
    const path = join(dir, "tiers", "auto-mode.json");
    await mkdir(join(dir, "tiers"), { recursive: true });
    await writeFile(path, JSON.stringify({ ask: ["git push *"] }));
    await appendAllowRule(path, ["git", "status"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ask: ["git push *"], allow: ["git status"] });
  });

  it("does not append a rule that is already present", async () => {
    const path = join(dir, "dedup", "auto-mode.json");
    await appendAllowRule(path, ["npm", "install", "-g", "ccusage"]);
    await appendAllowRule(path, ["npm", "install", "-g", "ccusage"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { allow: ["npm install -g ccusage"] });
  });

  it("rejects malformed files instead of silently ignoring them", async () => {
    const path = join(dir, "bad.json");
    await appendAllowRule(path, ["ok"]);
    await writeFile(path, JSON.stringify({ allow: "git status" }));
    await assert.rejects(loadRules([path]), InvalidRule);
  });

  it("rejects a leftover deny list rather than silently dropping the block", async () => {
    const path = join(dir, "deny.json");
    await writeFile(path, JSON.stringify({ allow: ["git status"], deny: ["git push --force *"] }));
    await assert.rejects(loadRules([path]), (err: unknown) => err instanceof InvalidRule && /"ask"/.test(err.message));
  });
});
