# Repository Guidelines

## Project Overview

Prototype "auto-mode" for `omp`: classifies a pending tool call as `safe` / `ask` / `unsafe` before it runs, using TypeSafe's Jev model (`@typesafe-ai/sdk`) as the judgment backend. Ships as one package with two front-ends over one engine: a CLI (fixture regression + one-off command classification) and an `omp` extension that gates `tool_call` events.

## Architecture & Data Flow

```
src/cli.ts ───────┐
                  ├──▶ src/classifier.ts ──▶ Jev (one systemOne request) ──▶ route() ──▶ Verdict
src/extension.ts ─┘
```

- `classifier.ts` is the engine. `HAZARDS` is a battery of 7 **Noul** (yes/no) questions; `classify(calls, options)` asks every hazard for every call in **one** `client.systemOne()` request (question ids `${hazard}_${i}`, state = `{ environment, project_dir, tool_calls }`), then `route()` turns each call's probabilities into a label.
- `route()` policy (code owns it, the model only supplies probabilities): any `severity: "unsafe"` hazard ≥ `fire` → `unsafe`; any hazard ≥ `fire`, or any specific hazard in `[clear, fire)` → `ask`; otherwise `safe`. `safe` therefore means *every* hazard came back near zero, not that safe won a relative vote.
- `other_risk` is the catch-all hazard and is `fireOnly`: a mid-range probability on a fuzzy question means "mildly consequential", not "model unsure about a fact", so it never routes to `ask` from the uncertain band alone. Keep that asymmetry when adding hazards: crisp hazards get the band, fuzzy ones do not.
- The extension (`src/extension.ts`) gates `GATED_TOOLS` only (read-tier tools are skipped), flattens/truncates inputs via `toClassifierInput`, and maps labels: `safe` → pass, `unsafe` → `{ block, reason }`, `ask` → `ctx.ui.confirm` (block when `!ctx.hasUI`). Classifier/API failure **fails open** to omp's built-in approval gate — a Jev outage must not brick the session.

## Key Directories

- `src/` — the three modules above; no subfolders.
- `fixtures/tool-calls.json` — the regression corpus (24 labelled samples, `project_dir` + `samples[{id,tool,input,expected}]`). This *is* the test suite.

## Development Commands

- `npm run typecheck` — `tsc --noEmit`; free, run after every edit.
- `npm run classify` — fixture run; **spends API tokens** (~27 k input per run) and hits the live model. Exit 0 only on 24/24 label match *and* exactly one HTTP request.
- `npm test` — typecheck then classify.
- `node src/cli.ts -- <command…>` — classify one bash command, JSON verdict on stdout (`--project-dir`, `--fire`, `--clear`, `--model` go before `--`).
- `omp -e . ` / `omp plugin link .` — load the extension (manifest: `package.json#omp.extensions`). Headless smoke: `omp -p --no-extensions -e . --mode json "…"` and inspect `tool_execution_end` events.
- Requires `TYPESAFE_API_KEY` in the environment (CLI exits 2 without it). Never print or persist it.

## Code Conventions & Common Patterns

- Node-native TypeScript: `.ts` files run directly (`node src/cli.ts`), so imports carry the `.ts` extension and syntax must be erasable (`erasableSyntaxOnly`) — no `enum`, no parameter properties, no namespaces. `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: index results are `T | undefined` (use `!` only where the index is provably in range, e.g. `verdicts[0]!` after classifying one call) and optional fields must be omitted, not set to `undefined` (`...(x === undefined ? {} : { x })`).
- Arrow-function `const` exports, `readonly` interfaces, no classes; policy tables as `as const satisfies Record<string, T>` so keys become a literal union (`HazardName`).
- Small static lookups are `Record<string, true>` (`GATED_TOOLS`), not `Set`.
- CLI errors go through `fail(code, message): never`; exit codes are the contract (`0` ok, `1` fixture mismatch / request count ≠ 1, `2` usage/config, `3` API). Keep the `USAGE` string in `cli.ts` in sync with flags.
- Extension handlers: register in the factory, do runtime work only inside handlers; a thrown `tool_call` handler is fail-closed in omp, so catch classifier errors explicitly.

### Working with Jev

- Ask one narrow judgment per question; put the exact condition in `question`, the boundary cases in `yes`/`no`. Jev reads literally — when a sample misroutes, the missing phrase in the hazard text is usually the fix (e.g. `destroys_data` had to name "replacing the entire content of a file outside `project_dir`").
- Each hazard's `no` ends with "even if the call is harmful in other ways" and the prompt says "judge only this specific question" to damp **halo bleed**: hostile commands make unrelated hazards fire too (`mkfs` → `exposes_secrets≈0.8`). Labels survive; reason strings for `unsafe` may list spurious hazards. Known jaggedness, don't chase it further.
- Never rely on arithmetic identities between questions or on a threshold tuned for a Score carrying over to a Noul (see `https://docs.typesafe.ai/model-jaggedness/jev-1.13.md`). Read `https://docs.typesafe.ai/llms.txt` before changing the request shape.
- Keep the single-request invariant: `classify` wraps `fetch` to count HTTP calls; the CLI fails if the count ≠ 1. Retries (`maxRetries: 3`) also bump the counter, so a flaky network surfaces as a test failure rather than silently doubling cost.

## Important Files

- `src/classifier.ts` — `HAZARDS`, `DEFAULT_THRESHOLDS` (`fire 0.7`, `clear 0.3`), `route`, `classify`.
- `src/cli.ts` — `bin` entry; fixture vs command mode split on `argv.indexOf("--")`.
- `src/extension.ts` — `omp` default-export factory; `GATED_TOOLS`, `MAX_VALUE_CHARS`.
- `fixtures/tool-calls.json` — borderline pairs worth preserving: `append-zshrc` (ask) vs `overwrite-zshrc` (unsafe), `git-push-branch` (ask) vs `force-push-main` (unsafe).
- `package.json` — scripts, `bin`, `omp.extensions`, `engines.node >=23.6`.

## Runtime/Tooling Preferences

- Node ≥ 23.6 (native TS execution); npm with `package-lock.json`. No bundler, no emitted JS.
- TypeScript 7 (the native Go compiler, stable release) for type checking only; `noEmit` everywhere.
- `@oh-my-pi/pi-coding-agent` is a **types-only** devDependency; at runtime omp rewrites that specifier onto its bundled copy. `@typesafe-ai/sdk` is the only runtime dependency.
- The model version is not pinned (`jev-latest`); pass `--model jev-1.13.0` to compare against the tuned baseline.

## Testing & QA

- No unit-test framework. The fixture is the regression suite: labels must match 100 %, judged by a live nondeterministic model. Probabilities drift ~±0.05 between runs, so run `npm run classify` **three times** after touching hazard wording or thresholds and treat any flake as a real failure to fix in the question text (or the sample), not by widening thresholds.
- When a sample flips, read the hazard columns in the CLI output first: the fix is either a missing boundary phrase in one hazard, or the sample's expected label was contestable — change whichever is actually wrong and say which in the commit.
- Add a fixture sample for every new hazard or boundary you introduce; keep at least one sample on each side of it.
