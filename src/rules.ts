/**
 * Deterministic bash rules and classifier-threshold config, checked before classification.
 *
 * A rule is a whitespace-separated token list, optionally ending in `*` ("any further arguments"):
 * `git status`, `npm run *`. It matches a command only when that command is a flat argument
 * vector, so `git status $(curl x)` never matches `git status` — it falls through to the
 * classifier instead. A command *chain* (`a && b`, `a; b`, `a | b`) is split at the top level and
 * every command in it is matched on its own, so `git add -A && git commit -m wip` is matchable.
 *
 * Two tiers, because a block the user cannot lift is not a policy they need: `allow` runs without
 * a model request, `ask` prompts (and blocks when no UI is available). The most specific matching
 * rule governs each command — otherwise the `git commit -m wip` allow rule a user just persisted
 * from the dialog could never outrank the `git commit *` ask rule that produced the dialog.
 *
 * Config shape, at `<project>/.omp/auto-mode.json` and `<agent dir>/auto-mode.json`:
 * `{ "allow": ["git status"], "ask": ["git push *"], "thresholds": { "fire": 0.7, "clear": 0.3 } }`.
 * The agent file may also list `allowPaths` (see `paths.ts`); a project file cannot, because a
 * cloned repository must not grant itself writes to host directories.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Thresholds } from "./classifier.ts";

export type Rule = readonly string[];

/** One command as an argument vector, and a top-level chain of them. */
export type Argv = readonly string[];
export type Chain = readonly Argv[];

export type Tier = "allow" | "ask";

export interface Rules {
  readonly allow: readonly Rule[];
  readonly ask: readonly Rule[];
}

export interface LoadedRules extends Rules {
  readonly thresholds: Thresholds;
  /** Absolute, normalized directory roots for `write`/`edit` pre-approval; agent file only. */
  readonly allowPaths: readonly string[];
}

/** The deciding rule is only meaningful for `ask`: an allowed chain is allowed by one rule per command. */
export type Decision = { readonly tier: "allow" } | { readonly tier: "ask"; readonly rule: Rule };

export class InvalidRule extends Error {}

/**
 * Raw command shapes that must retain an approval gate even when omp runs in `yolo` mode.
 *
 * This intentionally mirrors omp's `CRITICAL_BASH_PATTERNS`: yolo ignores the bare `override`
 * returned by that list, so the extension has to enforce the prompt itself. Keep the two lists
 * behaviorally aligned when updating the omp devDependency.
 */
const CRITICAL_BASH_PATTERNS = [
  /\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i,
  /\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+[0-7]+\s+\//i,
  /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
  /\bchown\s+-R\s+\S+\s+\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=.+of=\/dev\//i,
  /\bshred\s+\/dev\//i,
  /\bcryptsetup\b/i,
  />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
  /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
  /\bkill\s+-9\s+1\b/,
  /(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
  /(?:^|[\s;&|(])init\s+0\b/i,
  /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
] as const;

/** Whether a raw bash command must prompt before user rules or the classifier can allow it. */
export const isCriticalBash = (command: string): boolean =>
  CRITICAL_BASH_PATTERNS.some((pattern) => pattern.test(command));

// ---------------------------------------------------------------------------
// Commands → argv chain
// ---------------------------------------------------------------------------

/**
 * Characters that give a command semantics the rule layer does not model. `;`, `|` and `&` are
 * absent because they are handled explicitly below: the first two split a chain, the third is
 * ambiguous (`&>` redirect, `&&` chain, or a lone backgrounding `&`).
 */
const METACHARS = /[<>()$`\\\n*?[\]{}~!#]/;

/**
 * The only redirection targets the rule layer vouches for. Sending a stream to `/dev/null` or
 * duplicating one onto another (`2>&1`) changes where output goes, never what executes or which
 * files are touched. Any real file target — `> out.txt`, `< secret` — is refused.
 */
const NULL_TARGET = /^[ \t]*\/dev\/null(?=$|[\s"';|&])/;
const FD_DUP = /^[ \t]*&[12](?=$|[\s"';|&])/;

/**
 * Split a command line into one argv per command, or `undefined` when it cannot be trusted as a
 * flat chain: any expansion, glob, unbalanced quote, escape, backgrounding, real redirection, or
 * compound construct (`if`, `for`, `( … )`, `{ … }`) disqualifies the whole line. Plain `"…"` and
 * `'…'` quoting is honoured so that `git commit -m "fix: x"` remains matchable, and redirections
 * to `/dev/null` or between descriptors are dropped rather than refused.
 */
export const tokenize = (command: string): Chain | undefined => {
  const chain: Argv[] = [];
  let argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  let dangling = false;

  /** End the current command; a separator with nothing before it is not a chain we understand. */
  const cut = (): boolean => {
    if (inToken) argv.push(current);
    current = "";
    inToken = false;
    if (argv.length === 0) return false;
    chain.push(argv);
    argv = [];
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (ch === "$" || ch === "`" || ch === "\\" || ch === "\n") return undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inToken) argv.push(current);
      current = "";
      inToken = false;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      // `&>` / `&>>` redirect both streams; the `>` is handled on the next iteration.
      if (ch === "&" && command[i + 1] === ">") continue;
      // `&&` and `||` chain; a lone `&` backgrounds the command, and `;;` is `case` syntax.
      const doubled = command[i + 1] === ch;
      if (ch === "&" ? !doubled : ch === ";" && doubled) return undefined;
      if (!cut()) return undefined;
      if (doubled) i += 1;
      dangling = true;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // A lone digit glued to the operator is a file descriptor (`2>`), not an argument;
      // anything else glued to it (`a>/dev/null`) is an ordinary argument that ends here.
      if (inToken && current !== "0" && current !== "1" && current !== "2") argv.push(current);
      current = "";
      inToken = false;
      let after = i + 1;
      if (ch === ">" && command[after] === ">") after += 1;
      const rest = command.slice(after);
      const consumed = (ch === ">" ? FD_DUP.exec(rest) : null) ?? NULL_TARGET.exec(rest);
      if (consumed === null) return undefined;
      i = after + consumed[0].length - 1;
      dangling = false;
      continue;
    }
    if (METACHARS.test(ch)) return undefined;
    current += ch;
    inToken = true;
    dangling = false;
  }
  if (quote !== undefined) return undefined;
  if (inToken) argv.push(current);
  if (argv.length > 0) chain.push(argv);
  // `a && ` or `a | ` is an unfinished command; only `;` may legitimately end a line.
  else if (dangling && !command.trimEnd().endsWith(";")) return undefined;
  return chain.length > 0 ? chain : undefined;
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

/** Whether a rule covers the approved argv it is intended to persist for. */
export const ruleCovers = (rule: Rule, argv: Argv): boolean => {
  const wildcard = rule.at(-1) === "*";
  const literal = wildcard ? rule.slice(0, -1) : rule;
  if (wildcard ? argv.length < literal.length : argv.length !== literal.length) return false;
  return literal.every((token, i) => token === argv[i]);
};

/** Literal tokens matched, with an exact rule beating a wildcard one of the same length. */
const specificity = (rule: Rule): number =>
  rule.at(-1) === "*" ? (rule.length - 1) * 2 : rule.length * 2 + 1;

/** The rule that governs one command: the most specific match, `ask` winning a tie. */
const govern = (rules: Rules, argv: Argv): { tier: Tier; rule: Rule } | undefined => {
  let best: { tier: Tier; rule: Rule; score: number } | undefined;
  for (const tier of ["allow", "ask"] as const) {
    for (const rule of rules[tier]) {
      if (!ruleCovers(rule, argv)) continue;
      const score = specificity(rule);
      if (best === undefined || score > best.score || (score === best.score && tier === "ask")) {
        best = { tier, rule, score };
      }
    }
  }
  return best;
};

/**
 * Decide a whole chain: one `ask` anywhere asks, and the chain is allowed only when every command
 * in it is. `undefined` means no rule covers some command and the classifier should decide.
 */
export const decide = (rules: Rules, chain: Chain): Decision | undefined => {
  const governing = chain.map((argv) => govern(rules, argv));
  const asked = governing.find((rule) => rule?.tier === "ask");
  if (asked !== undefined) return { tier: "ask", rule: asked.rule };
  return governing.every((rule) => rule !== undefined) ? { tier: "allow" } : undefined;
};

/**
 * Representable rules a user might persist after approving `argv`: the exact command, and, when
 * it has arguments beyond the first two tokens, the `<cmd> <sub> *` prefix. Exact argv containing
 * whitespace cannot round-trip through the whitespace-delimited config grammar and is omitted.
 */
export const suggestRules = (argv: Argv): readonly Rule[] => {
  const candidates: Rule[] = argv.length <= 2 ? [argv] : [argv, [...argv.slice(0, 2), "*"]];
  return candidates.filter((rule) => rule.every((token) => !/\s/.test(token)));
};

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

interface RulesFile {
  readonly allow?: readonly string[];
  readonly ask?: readonly string[];
  readonly thresholds?: Thresholds;
  readonly allowPaths?: readonly string[];
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
  // A dropped tier must fail loudly: silently ignoring "deny" would turn a hard block into nothing.
  if ("deny" in data) {
    throw new InvalidRule(
      `${path}: "deny" is no longer a tier; move those rules to "ask" (an ask rule blocks when no UI is available)`,
    );
  }
  const list = (key: string, value: unknown): readonly string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new InvalidRule(`${path}: "${key}" must be an array of strings`);
    }
    return value;
  };
  const thresholds = (value: unknown): Thresholds => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InvalidRule(`${path}: "thresholds" must be an object`);
    }
    const record = value as Record<string, unknown>;
    const probability = (key: "fire" | "clear"): number => {
      const candidate = record[key];
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
        throw new InvalidRule(`${path}: "thresholds.${key}" must be a number between 0 and 1`);
      }
      return candidate;
    };
    const parsed = { fire: probability("fire"), clear: probability("clear") };
    if (parsed.clear > parsed.fire) {
      throw new InvalidRule(`${path}: "thresholds.clear" (${parsed.clear}) must not exceed "thresholds.fire" (${parsed.fire})`);
    }
    return parsed;
  };
  const roots = (value: unknown): readonly string[] => {
    const entries = list("allowPaths", value);
    for (const entry of entries) {
      if (!isAbsolute(entry) || entry.split("/").includes("..") || resolve(entry) === "/") {
        throw new InvalidRule(`${path}: "allowPaths" entry "${entry}" must be an absolute directory below "/" without ".."`);
      }
    }
    return entries;
  };
  // Keep only the keys the file actually has, so a rewrite does not invent empty ones.
  return {
    ...("allow" in data ? { allow: list("allow", data.allow) } : {}),
    ...("ask" in data ? { ask: list("ask", data.ask) } : {}),
    ...("thresholds" in data ? { thresholds: thresholds(data.thresholds) } : {}),
    ...("allowPaths" in data ? { allowPaths: roots(data.allowPaths) } : {}),
  };
};

/**
 * Merge project and agent rules. Agent thresholds establish the baseline. Lowering `fire` and
 * raising `clear` are the only monotonic tightenings; any combination that collapses their order
 * is rejected rather than silently weakening one boundary.
 */
export const loadRules = async (
  paths: { readonly project: string; readonly agent: string },
  defaults: Thresholds,
): Promise<LoadedRules> => {
  const [project, agent] = await Promise.all([readRulesFile(paths.project), readRulesFile(paths.agent)]);
  const baseline = agent.thresholds ?? defaults;
  const thresholds =
    project.thresholds === undefined
      ? baseline
      : {
          fire: Math.min(project.thresholds.fire, baseline.fire),
          clear: Math.max(project.thresholds.clear, baseline.clear),
        };
  if (thresholds.clear > thresholds.fire) {
    throw new InvalidRule(
      `${paths.project}: project thresholds conflict with the agent threshold baseline (clear ${thresholds.clear} exceeds fire ${thresholds.fire})`,
    );
  }
  if (project.allowPaths !== undefined) {
    throw new InvalidRule(
      `${paths.project}: "allowPaths" is only read from ${paths.agent}; a project cannot pre-approve host directories`,
    );
  }
  return {
    allow: [project, agent].flatMap((file) => (file.allow ?? []).map(parseRule)),
    ask: [project, agent].flatMap((file) => (file.ask ?? []).map(parseRule)),
    thresholds,
    allowPaths: (agent.allowPaths ?? []).map((root) => resolve(root)),
  };
};

/** Append one allow rule to a rules file, creating the file and its directory if needed; no-op if present. */
export const appendAllowRule = async (path: string, rule: Rule): Promise<void> => {
  const file = await readRulesFile(path);
  const text = formatRule(rule);
  if (file.allow?.includes(text)) return;
  const allow = [...(file.allow ?? []), text];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...file, allow }, null, 2)}\n`);
};
