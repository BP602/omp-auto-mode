/**
 * Deterministic allow/deny rules for bash commands, checked before the classifier is consulted.
 *
 * A rule is a whitespace-separated token list, optionally ending in `*` ("any further arguments"):
 * `git status`, `npm run *`. It matches a command only when the command is a flat argument
 * vector with no shell metacharacters, so `git status; rm -rf ~` never matches `git status` —
 * it falls through to the classifier instead. Rules never see the model.
 *
 * Config shape, at `<project>/.omp/auto-mode.json` and `<agent dir>/auto-mode.json`:
 * `{ "allow": ["git status", "npm run *"], "deny": ["git push --force *"] }`. Deny always wins.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Rule = readonly string[];

export interface Rules {
  readonly allow: readonly Rule[];
  readonly deny: readonly Rule[];
}

export const EMPTY_RULES: Rules = { allow: [], deny: [] };

export class InvalidRule extends Error {}

// ---------------------------------------------------------------------------
// Commands → argv
// ---------------------------------------------------------------------------

/** Characters that give a command shell semantics beyond a flat argument list. */
const METACHARS = /[;&|<>()$`\\\n*?[\]{}~!#]/;

/**
 * Split a command into arguments, or `undefined` when it cannot be trusted as a flat argv:
 * any metacharacter, expansion, unbalanced quote, or escape disqualifies it. Plain `"…"` and
 * `'…'` quoting is honoured so that `git commit -m "fix: x"` remains matchable.
 */
export const tokenize = (command: string): readonly string[] | undefined => {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "$" || ch === "`" || ch === "\\" || ch === "\n") {
        return undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) argv.push(current);
      current = "";
      inToken = false;
    } else if (METACHARS.test(ch)) {
      return undefined;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (inToken) argv.push(current);
  return argv.length > 0 ? argv : undefined;
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const parseRule = (text: string): Rule => {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") throw new InvalidRule(`empty rule`);
  const stray = tokens.findIndex((token, i) => token === "*" && i !== tokens.length - 1);
  if (stray !== -1) throw new InvalidRule(`"${text}": "*" is only allowed as the last token`);
  if (tokens.length === 1 && tokens[0] === "*") throw new InvalidRule(`"*" alone would allow every command`);
  return tokens;
};

export const formatRule = (rule: Rule): string => rule.join(" ");

const matches = (rule: Rule, argv: readonly string[]): boolean => {
  const wildcard = rule.at(-1) === "*";
  const literal = wildcard ? rule.slice(0, -1) : rule;
  if (wildcard ? argv.length < literal.length : argv.length !== literal.length) return false;
  return literal.every((token, i) => token === argv[i]);
};

/** `deny` beats `allow`; `undefined` means no rule applies and the classifier should decide. */
export const decide = (rules: Rules, argv: readonly string[]): "allow" | "deny" | undefined => {
  if (rules.deny.some((rule) => matches(rule, argv))) return "deny";
  if (rules.allow.some((rule) => matches(rule, argv))) return "allow";
  return undefined;
};

/**
 * Rules a user might want to persist after approving `argv`: the exact command, and — when it has
 * arguments beyond the first two tokens — the `<cmd> <sub> *` prefix.
 */
export const suggestRules = (argv: readonly string[]): readonly Rule[] => {
  const exact: Rule = argv;
  if (argv.length <= 2) return [exact];
  return [exact, [...argv.slice(0, 2), "*"]];
};

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

interface RulesFile {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

const readRulesFile = async (path: string): Promise<RulesFile> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) throw new InvalidRule(`${path}: must be an object`);
  const list = (key: string, value: unknown): readonly string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new InvalidRule(`${path}: "${key}" must be an array of strings`);
    }
    return value;
  };
  // Keep only the keys the file actually has, so a rewrite does not invent empty ones.
  return {
    ...("allow" in data ? { allow: list("allow", data.allow) } : {}),
    ...("deny" in data ? { deny: list("deny", data.deny) } : {}),
  };
};

/** Merge the rules from every path that exists; missing files contribute nothing. */
export const loadRules = async (paths: readonly string[]): Promise<Rules> => {
  const files = await Promise.all(paths.map(readRulesFile));
  return {
    allow: files.flatMap((file) => (file.allow ?? []).map(parseRule)),
    deny: files.flatMap((file) => (file.deny ?? []).map(parseRule)),
  };
};

/** Append one allow rule to a rules file, creating the file and its directory if needed. */
export const appendAllowRule = async (path: string, rule: Rule): Promise<void> => {
  const file = await readRulesFile(path);
  const allow = [...(file.allow ?? []), formatRule(rule)];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...file, allow }, null, 2)}\n`);
};
