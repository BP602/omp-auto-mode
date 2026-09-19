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

Requires Node ≥ 23.6 (runs TypeScript natively) and a `TYPESAFE_API_KEY` in your environment.

```bash
git clone https://github.com/alexsatch/omp-auto-mode
cd omp-auto-mode && npm install
```

Load it into `omp` for one session, or link it permanently:

```bash
omp -e /path/to/omp-auto-mode
omp plugin link /path/to/omp-auto-mode
```

The extension gates `bash`, `write`, `edit`, `eval`, and `ast_edit`. Read-only tools are not classified. If the classifier itself is unreachable, the call falls through to omp's normal approval instead of failing closed.

## CLI

```bash
# classify one command; JSON verdict on stdout
node src/cli.ts -- rm -rf ~/
node src/cli.ts --project-dir ~/work/app --fire 0.8 -- git push origin feature

# run the labelled fixture; exit 0 only on 24/24 match
npm run classify
```

| flag / env | default | meaning |
|---|---|---|
| `--fire` / `AUTO_MODE_FIRE` | 0.7 | probability at or above which a hazard holds |
| `--clear` / `AUTO_MODE_CLEAR` | 0.3 | probability below which a hazard is absent |
| `--project-dir` | cwd | directory the command runs in (command mode) |
| `--model` | `jev-latest` | Jev model or alias |

Exit codes: `0` ok · `1` fixture mismatch or more than one API request · `2` usage/config · `3` API failure.

## Development

```bash
npm run typecheck   # tsc --noEmit, free
npm run classify    # hits the live API (~27k input tokens per run)
npm test            # both
```

There is no unit-test framework; `fixtures/tool-calls.json` *is* the regression suite. Jev's probabilities drift by a few hundredths between runs, so after changing hazard wording or thresholds run the fixture a few times and fix flakes in the question text, not by widening thresholds. See [AGENTS.md](AGENTS.md) for the conventions.

Known limitation: clearly hostile commands tend to light up unrelated hazards too (`mkfs` scores high on `exposes_secrets`). Labels are unaffected — it only over-fires on calls that are already unsafe — but the reason string for a hard block may list hazards that do not literally apply.

## License

MIT
