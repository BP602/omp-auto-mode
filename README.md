# omp-auto-mode

Auto-mode for [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi) (`omp`): every tool call the agent wants to run is classified as **safe**, **ask**, or **unsafe** *before* it executes, using [TypeSafe Jev](https://docs.typesafe.ai) as the judgment backend.

- `safe` — runs without interruption.
- `ask` — you get a confirmation dialog with the reason.
- `unsafe` — blocked; the model is told why so it can try something else.

```
$ omp-auto-mode -- git push --force origin main
{
  "label": "unsafe",
  "triggered": ["other_risk", "runs_untrusted", "network_egress", "destroys_data", "outside_project"],
  "uncertain": ["exposes_secrets", "system_config"],
  "hazards": { "destroys_data": 0.73, "network_egress": 0.81, … },
  …
}
```

## How it decides

Instead of one "is this dangerous?" question, each call is judged against seven independent yes/no **hazards** in a single Jev request. Code, not the model, owns the policy:

| hazard | fires → | catches |
|---|---|---|
| `exposes_secrets` | unsafe | reading/printing/sending keys, tokens, `.env`, `$(env)` |
| `destroys_data` | unsafe | `rm -rf ~`, disk formatting, overwriting a dotfile, force-push to main |
| `runs_untrusted` | unsafe | `curl … \| sh` |
| `outside_project` | ask | writes or `chmod` outside the project directory |
| `network_egress` | ask | `git push`, `curl -d`, deploy/publish |
| `system_config` | ask | `npm i -g`, `sudo`, global git/shell config |
| `other_risk` | ask | catch-all: hard to undo, costs money, affects others |

Two thresholds turn probabilities into a label (`fire = 0.7`, `clear = 0.3` by default):

- any **unsafe**-severity hazard ≥ `fire` → `unsafe`
- any hazard ≥ `fire`, or any specific hazard in `[clear, fire)` (the model is genuinely unsure) → `ask`
- everything below `clear` → `safe`

Because each hazard is an absolute judgment, `safe` means *every* hazard came back near zero — not that "safe" won a relative vote. The catch-all only counts when it fires outright; its mid-range means "mildly consequential", not "unsure", so it never prompts on its own.

## Install

Requires Node ≥ 23.6 (runs TypeScript natively) and a TypeSafe credential.

```bash
git clone https://github.com/BP602/omp-auto-mode
cd omp-auto-mode && npm install
```

Load it into `omp` for one session, or link it permanently:

```bash
omp -e /path/to/omp-auto-mode
omp plugin link /path/to/omp-auto-mode
```

The extension takes its credential from omp's own credential store (`/login typesafe`, or
whatever `omp token typesafe` already resolves), so no environment variable is needed. It is
re-resolved on every classified call, so logging in mid-session takes effect immediately.
`TYPESAFE_API_KEY` still works as a fallback, and is what the CLI below uses.

Make auto-mode the sole approval gate; otherwise omp's native gate runs after the extension and
can produce a second prompt:

```yaml
tools:
  approvalMode: yolo
```

With `yolo`, no gate remains if the extension fails to load, so confirm that `omp plugin link`
lists it before relying on this setup. While the extension is loaded, it gates `bash`, `write`,
`edit`, `eval`, and `ast_edit`. Read-only tools are not classified.

Raw bash commands first pass a deterministic critical-pattern backstop. Destructive host and disk
operations, remote-fetch-then-execute shapes, and network shells prompt even if an `allow` rule
matches and even if Jev is unavailable. A classifier error also prompts instead of falling through.
Both cases block when no UI is available (`-p`, CI).

### Rules and thresholds

The same two config files control commands that skip the model and the thresholds used by the
extension. Files at `<project>/.omp/auto-mode.json` and `~/.omp/agent/auto-mode.json` are merged:

```json
{
  "allow": ["git status", "git diff *", "npm run *", "ls *"],
  "ask": ["git commit *", "git push *"],
  "thresholds": { "fire": 0.7, "clear": 0.3 }
}
```

- `allow` — runs without a model request.
- `ask` — always prompts, even for something the classifier rates `safe` (a local commit destroys
  nothing and sends nothing, so hazard scoring will never stop it for you). With no UI available
  — `-p`, CI — an `ask` rule blocks, which is also the only block a rule can produce: a tier you
  cannot say yes to would just be a worse version of this one.

The agent-directory thresholds establish the user's baseline; omitted thresholds use the defaults
above. A project can tighten policy by lowering `fire` or raising `clear`. Values that move the
other way are ignored, and a combination that would make `clear > fire` fails closed, so a cloned
repository cannot weaken the user's gate. Both values must be numbers in `[0, 1]`.

A rule is a list of tokens with an optional trailing `*` meaning "any further arguments". The
**most specific** matching rule governs a command — literal tokens counted, exact beating wildcard,
`ask` winning a tie — so the `git commit -m wip` allow rule you persist from a dialog outranks the
`git commit *` ask rule that raised it.

A command chain (`a && b`, `a; b`, `a | b`) is split and matched command by command: it asks if
**any** command asks, and is allowed only when **every** command is. Anything the matcher does not
model — `$(…)`, backticks, expansions, globs, `~`, redirects to real files, backgrounding `&`,
`if`/`for`/`{ … }` — matches no rule at all and goes to the classifier, so `git status $(curl evil)`
never matches `git status`. Redirects that cannot touch a file (`>/dev/null`, `2>&1`) are ignored
for matching, so `npm test 2>&1` matches an `npm test` rule.

Rules deliberately apply only to `bash`. `write`, `edit`, `eval`, and `ast_edit` always go through
the classifier. A trustworthy path matcher would have to reproduce omp's handling of symlinks,
`..` and absolute escapes, internal URLs, archive and database selectors, globs, and multi-file
edit destinations. A simpler matcher would create an allow-rule bypass, so auto-mode does not
maintain a second path-policy implementation.

Classifier input values are capped at 2,000 source characters. Longer values keep the first and
last 1,000 characters with an omission marker between them, so trailing commands or secrets remain
visible without increasing the model-input budget.

Within one extension session, successful classifier verdicts use a 128-entry least-recently-used
cache keyed by project directory, tool, and the canonical input sent to Jev. Changing the effective
thresholds clears the cache. Classifier failures are never cached, and a cached `ask` verdict still
opens a fresh approval dialog for every call.

When a call is classified `ask` by a rule or by the model, the dialog offers **Allow once**,
suggested **Always allow** rules, **Edit allow rule**, and **Deny**. The editor starts with the
wildcard suggestion, accepts the same trailing-`*` grammar as the config file, and keeps the user
in the editor until the rule is valid and covers the command being approved. Cancelling the editor
keeps the current approval but writes no rule. Exact suggestions are omitted when an argument
contains whitespace because that shape cannot round-trip through the config grammar.

After choosing or editing a persistent rule, a second dialog selects **This project**
(`<project>/.omp/auto-mode.json`) or **Everywhere** (`~/.omp/agent/auto-mode.json`). Cancelling the
scope also keeps the current approval without writing. Persistent choices are offered only for a
single command: persisting a rule for one half of `a && b` would allow that half on its own, which
you never approved.

Critical-pattern and classifier-error prompts offer only **Allow once** and **Deny**. An outage or
backstop match cannot create a permanent bypass.

### Approval traces

The extension writes approval events to omp's persistent log (normally
`~/.omp/logs/omp.YYYY-MM-DD.PID.log`), not to a second plugin-owned file. Search for
`auto-mode: approval `; each line contains JSON with `callId`, `tool`, `source`, `phase`, and
`outcome`. The source is `critical`, `rule`, `classifier`, `cache`, or `classifier_error`.
Phases are `decision` (the approval dialog), `editor` (a custom rule), and `scope` (where to
save it). An `opened` event precedes each dialog; a later outcome records the selection,
cancel, headless block, or saved rule. Cancelling the initial decision denies the call;
cancelling the editor or scope allows this call without persisting a rule.

Use `callId` to correlate these events with tool-call events in the session. Two `decision`
`opened` events for the same call mean auto-mode entered its approval flow twice. If there is
only one but two *initial approval* prompts are visible, check other gates; the rule editor
and scope selector have distinct phases. An unmatched `opened` means the dialog did not return
or its result was not logged, not that the tool ran. These structured records omit command
input, edited rule text, paths, and credentials; older descriptive verdict messages are separate.

## CLI

```bash
# classify one command
node src/cli.ts -- rm -rf ~/
node src/cli.ts --project-dir ~/work/app --fire 0.8 -- git push origin feature

# classify a batch of tool calls from a JSON file, all in one request
node src/cli.ts fixtures/tool-calls.json
```

Batch files look like `{ "project_dir": "...", "calls": [{ "id", "tool", "input" }] }`. Output is
one JSON envelope in both modes: `{ "model", "thresholds", "verdicts": [{ "id", "tool", "input",
"label", "triggered", "uncertain", "hazards" }] }`.


| flag / env | default | meaning |
|---|---|---|
| `--fire` / `AUTO_MODE_FIRE` | 0.7 | probability at or above which a hazard holds |
| `--clear` / `AUTO_MODE_CLEAR` | 0.3 | probability below which a hazard is absent |
| `--project-dir` | cwd | directory the command runs in (command mode) |
| `--model` | `jev-latest` | Jev model or alias |

Exit codes: `0` ok · `2` usage/config · `3` API failure.

## Development

```bash
npm run typecheck   # tsc --noEmit, free
npm test            # typecheck, then node --test against the live API (~27k input tokens)
```

Tests use `node:test`. `test/rules.test.ts` and `test/extension.test.ts` cover deterministic policy and handler behavior without an API call. `test/classifier.test.ts` sends every call in `fixtures/tool-calls.json` in one live request and asserts each expected label. Jev probabilities drift by a few hundredths, so after changing hazard wording or thresholds run it a few times and fix flakes in the question text, not by widening thresholds. See [AGENTS.md](AGENTS.md) for the conventions.

Known limitation: clearly hostile commands tend to light up unrelated hazards too (`mkfs` scores high on `exposes_secrets`). Labels are unaffected — it only over-fires on calls that are already unsafe — but the reason string for a hard block may list hazards that do not literally apply.

## License

MIT
