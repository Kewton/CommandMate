# claude 2.1.285 — the effort a session actually runs at (Issue #3023)

Captured 2026-09-30 on claude 2.1.285 (`Opus 5.5 · Claude Max`), interactive
sessions on a private tmux socket (`tmux -L <socket>`, `env -i` with only
`HOME`/`PATH`/`TERM`/`USER`/`LANG`), 200x50, in an already-trusted worktree.
`~/.claude/settings.json` was NOT touched; it carries `"model": "opus"` and a
top-level `"effortLevel": "xhigh"`. Each session got its own `--settings <probe>`:

| probe | effort the session ran at (transcript `perTurnEffort`) | banner | effort row |
|-------|------|--------|-----------|
| no effort key (what CommandMate launches) | `medium` | `Opus 5.5 · Claude Max` | `◐ medium · /effort` |
| `{"modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}}}` | `xhigh` | `Opus 5.5 with xhigh effort · Claude Max` | `◉ xhigh · /effort` |
| `{"effortLevel":"xhigh"}` (flag settings, top level) | `xhigh` | `Opus 5.5 with xhigh effort · Claude Max` | `◉ xhigh · /effort` |

| file | what it is |
|------|------------|
| `plain-startup-2.1.285.txt` | first frame of the no-effort-key session |
| `plain-after-turn-2.1.285.txt` | the same session after one turn: the effort row is gone |
| `xhigh-startup-2.1.285.txt` | first frame of the `modelSettings` session |

Only the cwd line was replaced (`~/repo`); trailing blank rows and trailing
spaces were trimmed.

What the frames show:

- **The `medium` is what the session runs at, not a misreading.** claude
  2.1.285 treats a top-level `effortLevel` in the *user* settings file as a
  legacy value that applies only to the models it lists as legacy (up to Opus 5
  / Fable 5.1 / Sonnet 5 / Mythos 5.1). Opus 5.5 and Sonnet 5.5 are not in that
  list, so the user-level `xhigh` is ignored for them and the model's own
  default (`medium`) applies. The per-model form (`modelSettings.<model>.effortLevel`,
  which is what `/effort` now writes to the user settings) and a top-level
  `effortLevel` from any other scope (project, local, `--settings`, policy) do
  apply. Every local transcript since claude 2.1.280 — CommandMate-launched or
  not — records `perTurnEffort: "medium"`; 2.1.278 and earlier record `xhigh`.
- **The banner states the effort only when it differs from the model's
  default.** At the default it is `<model> · <plan>`; otherwise the older
  `<model> with <effort> effort · <plan>` clause is back, with the plan after it.
- **The right-aligned `· /effort` row is drawn on the first frame only.** It is
  gone after the first turn (not just replaced by a `tmux detected` notice), so
  a frame from later in the session reads the model and no effort.
- The `SessionStart` payload has no effort field (`session_id`,
  `transcript_path`, `cwd`, `scratchpad_dir`, `hook_event_name`, `source`,
  `model`), so there is nothing for `cmate-agent-event.sh` to relay.
