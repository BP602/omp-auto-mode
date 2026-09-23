# Repository Guidelines

## Project Overview

Prototype "auto-mode" for `omp`: classifies a pending tool call as `safe` / `ask` / `unsafe` before it runs, using TypeSafe's Jev model (`@typesafe-ai/sdk`) as the judgment backend. Ships as one package with two front-ends over one engine: a CLI (batch file or one-off command) and an `omp` extension that gates `tool_call` events.

## Architecture & Data Flow

```
src/cli.ts ──────────────────────────┐
                                     ├──▶ src/classifier.ts ──▶ Jev (one systemOne request) ──▶ route() ──▶ Verdict
src/extension.ts ──▶ src/rules.ts ───┘
        │            (allow/ask, no API call)
        └──▶ src/paths.ts (allowPaths for write/edit, no API call)
```

- `classifier.ts` is the engine. `HAZARDS` is a battery of 7 **Noul** (yes/no) questions; `classify(calls, options)` asks every hazard for every call in **one** `client.systemOne()` request (question ids `${hazard}_${i}`, state = `{ environment, project_dir, tool_calls }`), then `route()` turns each call's probabilities into a label.
- `route()` policy (code owns it, the model only supplies probabilities): any `severity: "unsafe"` hazard ≥ `fire` → `unsafe`; any hazard ≥ `fire`, or any specific hazard in `[clear, fire)` → `ask`; otherwise `safe`. `safe` therefore means *every* hazard came back near zero, not that safe won a relative vote.
- `other_risk` is the catch-all hazard and is `fireOnly`: a mid-range probability on a fuzzy question means "mildly consequential", not "model unsure about a fact", so it never routes to `ask` from the uncertain band alone. Keep that asymmetry when adding hazards: crisp hazards get the band, fuzzy ones do not.
- The extension (`src/extension.ts`) gates `GATED_TOOLS` only (read-tier tools are skipped), flattens/truncates inputs via `toClassifierInput`, and maps labels: `safe` → pass, `unsafe` → `{ block, reason }`, `ask` → `askUser` select dialog (block when `!ctx.hasUI`). Classifier/API failure is also an ask, with no persistent-allow option, and blocks when headless. This matters because `tools.approvalMode: yolo` makes the extension the only gate; falling through would run the call.
- `toClassifierInput()` caps each value at 2,000 source characters. Values over the boundary retain the first and last 1,000 characters with the truncation marker between them; never regress to head-only truncation because the consequential statement may be at the tail.
- `rules.ts` is the deterministic command layer in front of the model, bash only. `isCriticalBash()` mirrors omp's critical raw-command patterns and is checked before user rules, so yolo cannot suppress those prompts and an allow rule cannot bypass them. A critical match prompts without persistent allow and blocks when `!ctx.hasUI`.
- `paths.ts` is the only path-shaped rule: agent-file `allowPaths` roots pre-approve `write` and `edit` (never `bash`, `eval`, `ast_edit`). A partial matcher is an allow bypass, so every doubt falls through to the classifier: non-plain spellings (`:`/`?` selectors and URLs, `~`, `@`, `[`, `\`, `..`, control chars, Unicode spaces), targets not strictly beneath the root both lexically and after `realpath` of the target or its deepest existing ancestor, dangling links, non-regular or `nlink > 1` files, and missing relative `edit` targets (the native edit engine suffix-recovers those to other workspace files — verified, not hypothetical). Edit targets come from `editInspect` (`@oh-my-pi/pi-natives`) under **every** edit mode, because the active mode depends on model/env/settings the extension cannot see; union all `paths`, `entries`, and `fileOps` `path`/`to`, and any inspection throw means no allow. A project file containing `allowPaths` is an `InvalidRule`. This is approval, not containment: document, don't paper over, the check-to-write race.
- Successful extension verdicts use a session-scoped, 128-entry LRU keyed by project directory, tool name, and canonically ordered post-truncation input. A threshold change clears the whole cache. Cache only completed classifications: failures must retry, and a cached `ask` verdict must still prompt on every call. On a hit, replace the cached verdict id with the current tool-call id.
- User rules have two tiers, not three: `allow` runs without a model request and `ask` always prompts. `tokenize()` returns one argv per command in a top-level chain (`a && b`, `a; b`, `a | b`) or `undefined` when anything is unmodelled: expansions, globs, `~`, real redirect targets, backgrounding `&`, `if`/`for`/`{ … }`. Unmodelled commands go to the classifier. Redirections that cannot touch a file (`/dev/null` targets, `2>&1` dups) are dropped so harness-style `cmd 2>&1` still matches.
- `decide()` picks the most specific matching rule per command (literal token count, exact beats wildcard, `ask` wins a tie), then asks if any command asks and allows only if every command is covered. This lets a persisted `git commit -m wip` allow rule outrank the `git commit *` ask rule that raised the dialog. Persistent choices are offered only for a single-command chain. The edit choice uses `parseRule()` and `ruleCovers()` in a retrying prompt; exact suggestions containing whitespace are omitted because they cannot round-trip through the config grammar. The scope selector writes project choices to `<cwd>/.omp/auto-mode.json`, everywhere choices to `<getAgentDir()>/auto-mode.json`, and cancellation allows once without writing. Persistence is de-duplicated. A leftover `deny` key throws `InvalidRule`. Both files are re-read on every gated call. Never widen `tokenize` to a real file target.
- Thresholds share the rules files. `loadRules()` validates complete `{ fire, clear }` objects in `[0, 1]` with `clear <= fire`. Agent-directory thresholds establish the baseline (code defaults when absent); project config may lower `fire` or raise `clear`, with non-tightening values ignored. A conflicting merged pair fails closed. The merged thresholds apply to every classified tool, not only bash.

## Key Directories

- `src/` — engine (`classifier.ts`), command rules (`rules.ts`), directory roots (`paths.ts`), shared batch-file parser (`calls.ts`), CLI, extension. No subfolders.
- `test/classifier.test.ts` — fixture regression on the live API. `test/rules.test.ts` — pure unit tests for critical-pattern, tokenizing, matching, and rules-file boundaries. `test/paths.test.ts` — real-filesystem root containment boundaries. `test/extension.test.ts` — handler regressions with stubbed omp, natives, and classifier modules. Add deterministic boundaries to those three, never to the live fixture.
- `fixtures/tool-calls.json` — the regression corpus: 27 labelled calls in the same `{ project_dir, calls[{id,tool,input,expected}] }` shape the CLI's batch mode accepts (`expected` is ignored there).

## Development Commands

- `npm run typecheck` — `tsc --noEmit`; free, run after every edit.
- `npm test` — typecheck, then `node --test`; **spends API tokens** (~27 k input per run) against the live model. One subtest per fixture call plus one asserting exactly one HTTP request.
- `node src/cli.ts -- <command…>` / `node src/cli.ts <calls.json>` — JSON envelope on stdout (`--project-dir`, `--fire`, `--clear`, `--model` go before `--`). Also spends tokens.
- `omp -e . ` / `omp plugin link .` — load the extension (manifest: `package.json#omp.extensions`). Headless smoke: `omp -p --no-extensions -e . --mode json "…"` and inspect `tool_execution_end` events.
- Two credential paths for the same key, and they are not interchangeable: the **extension** resolves it from omp's credential store via `ctx.modelRegistry.getApiKeyForProvider("typesafe")` (what `/login typesafe` and `omp token typesafe` use), re-resolved per classified call and passed as `ClassifyOptions.apiKey`; the **CLI and live classifier tests** have no `ExtensionContext` and rely on `TYPESAFE_API_KEY` in the environment (CLI exits 2 without it). `classify` omits `apiKey` when undefined, so the SDK's own env fallback still applies. Never print or persist the key.

## Code Conventions & Common Patterns

- Node-native TypeScript: `.ts` files run directly (`node src/cli.ts`), so imports carry the `.ts` extension and syntax must be erasable (`erasableSyntaxOnly`) — no `enum`, no parameter properties, no namespaces. `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: index results are `T | undefined` (use `!` only where the index is provably in range, e.g. `verdicts[0]!` after classifying one call) and optional fields must be omitted, not set to `undefined` (`...(x === undefined ? {} : { x })`).
- Arrow-function `const` exports, `readonly` interfaces, no classes; policy tables as `as const satisfies Record<string, T>` so keys become a literal union (`HazardName`).
- Small static lookups are `Record<string, true>` (`GATED_TOOLS`), not `Set`.
- CLI failures throw `CliError(code, message)` (or `InvalidCallsFile` from `calls.ts`) and are mapped once at the entry point; exit is set via `process.exitCode`, never `process.exit()`, so piped stdout is not truncated. Exit codes are the contract (`0` ok, `2` usage/config, `3` API). Keep the `USAGE` string in `cli.ts` in sync with flags.
- Extension handlers: register in the factory, do runtime work only inside handlers; a thrown `tool_call` handler is fail-closed in omp, so catch classifier errors explicitly.

### Working with Jev

- Ask one narrow judgment per question; put the exact condition in `question`, the boundary cases in `yes`/`no`. Jev reads literally — when a sample misroutes, the missing phrase in the hazard text is usually the fix (e.g. `destroys_data` had to name "replacing the entire content of a file outside `project_dir`").
- Each hazard's `no` ends with "even if the call is harmful in other ways" and the prompt says "judge only this specific question" to damp **halo bleed**: hostile commands make unrelated hazards fire too (`mkfs` → `exposes_secrets≈0.8`). Labels survive; reason strings for `unsafe` may list spurious hazards. Known jaggedness, don't chase it further.
- Never rely on arithmetic identities between questions or on a threshold tuned for a Score carrying over to a Noul (see `https://docs.typesafe.ai/model-jaggedness/jev-1.13.md`). Read `https://docs.typesafe.ai/llms.txt` before changing the request shape.
- Keep the single-request invariant: `classify` wraps `fetch` to count HTTP calls and the test asserts the count is 1. Retries (`maxRetries: 3`) also bump the counter, so a flaky network surfaces as a test failure rather than silently doubling cost.

## Important Files

- `src/classifier.ts` — `HAZARDS`, `DEFAULT_THRESHOLDS` (`fire 0.7`, `clear 0.3`), `route`, `classify`.
- `src/cli.ts` — `bin` entry; batch vs command mode split on `argv.indexOf("--")`.
- `src/calls.ts` — `parseCallsFile`; the one place the JSON batch/fixture shape is validated.
- `src/extension.ts` — `omp` default-export factory; `GATED_TOOLS`, `MAX_VALUE_CHARS`.
- `src/rules.ts` — `isCriticalBash`, `tokenize`, `parseRule`, `ruleCovers`, `decide`, `suggestRules`, `loadRules`, `appendAllowRule`; critical patterns, rule coverage, threshold and `allowPaths` validation/merge, `METACHARS`, and explicit `;`/`|`/`&` handling are security boundaries.
- `src/paths.ts` — `writeTargets`, `editTargets`, `withinRoots`; plain-spelling filter and real-destination resolution are security boundaries.
- `fixtures/tool-calls.json` — borderline pairs worth preserving: `append-zshrc` (ask) vs `overwrite-zshrc` (unsafe), `git-push-branch` (ask) vs `force-push-main` (unsafe).
- `package.json` — scripts, `bin`, `omp.extensions`, `engines.node >=23.6`.

## Runtime/Tooling Preferences

- Node ≥ 23.6 (native TS execution); npm with `package-lock.json`. No bundler, no emitted JS.
- TypeScript 7 (the native Go compiler, stable release) for type checking only; `noEmit` everywhere.
- `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-natives` are **types-only** devDependencies (keep their versions aligned); at runtime omp rewrites those specifiers onto its bundled copies. `@oh-my-pi/pi-natives` cannot load under Node (Bun-only loader), so tests stub it. `@typesafe-ai/sdk` is the only runtime dependency.
- The model version is not pinned (`jev-latest`); pass `--model jev-1.13.0` to compare against the tuned baseline.

## Testing & QA

- `node:test`, no framework. The fixture is the regression suite: labels must match 100 %, judged by a live nondeterministic model. Probabilities drift ~±0.05 between runs, so run `npm test` **three times** after touching hazard wording or thresholds and treat any flake as a real failure to fix in the question text (or the sample), not by widening thresholds.
- When a call flips, the assertion message carries `describeVerdict` (fired and uncertain hazards with probabilities): the fix is either a missing boundary phrase in one hazard, or the call's expected label was contestable — change whichever is actually wrong and say which in the commit.
- Add a fixture sample for every new hazard or boundary you introduce; keep at least one sample on each side of it.
