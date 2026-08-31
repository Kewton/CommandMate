# codex-update-dialog-2068 — the three panes of codex's own update offer

Real `tmux capture-pane` output used by
`tests/unit/lib/detection/codex-update-dialog-frames-2068.test.ts` (Issue #2068).

codex checks for a new release before its TUI opens. Once
`$CODEX_HOME/version.json` has a `latest_version` cached — which it does not on
a first run, so the dialog appears from the **second** launch onwards — the
check becomes an interactive dialog rather than the banner box everyone knows:

```
  ✨ Update available! 0.149.1 -> 0.151.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version
  Press enter to continue
```

## Provenance

| | |
|---|---|
| Captured | 2026-08-31, codex-cli 0.149.1 (latest 0.151.0) |
| Pane geometry | 200 x 1000 — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`, the production layout |
| Isolation | a private tmux server (`tmux -L cm2068`); `HOME`, `CODEX_HOME` **and `NPM_CONFIG_PREFIX`** all pointed at a throwaway scratch directory, so neither the operator's `~/.codex/version.json` nor their global npm packages were touched (verified after: `codex --version` still reported 0.149.1) |
| Command | `tmux -L cm2068 capture-pane -t '=probe:' -p -S -50` — i.e. exactly the window `capturePane(sessionName, 50)` asks tmux for |
| Shell | zsh with the macOS default prompt (`user@host dir %`) |

ANSI escapes are **not** present (no `-e`), which is what
`scripts/check-control-chars.mjs` requires of a tracked file and what every
consumer does anyway. The operator's user name and host name are replaced
length for length (`maenokota` → `localuser`, `MAENOnoMac-Studio` →
`EXAMPLEMac-Studio`), and the session UUID is zeroed — the same substitution
`tool-liveness-2070` uses, and for the same reason: the prompt's *length* is
load-bearing.

## Frames

| File | What is on the pane | What it pins |
|---|---|---|
| `update-dialog-01491.txt` | the interactive update dialog, bottom-most | `getCodexActiveDialog` → `update`, `getCodexLifecycleDialog` → `update` (the Auto-Yes guard of Issue #1829), and `detectPrompt` → a three-option `multiple_choice`, which is what puts all three choices in PromptPanel under the `ask` policy |
| `updating-01491.txt` | one second after `1`: `Updating Codex via …` and a braille spinner | the pane during `npm install`. Nothing may relaunch here — the install this server started is still running |
| `updated-shell-01491.txt` | `added 5 packages…`, `🎉 Update ran successfully! Please restart Codex.`, shell prompt | the frame the `update` policy has to recognise |

## Why `updated-shell-01491.txt` is the one that matters

`npm install -g @openai/codex` prints **three rows**. So on the frame codex
leaves behind, its dead `› 1. Update now` option row is only seven content rows
above the live shell prompt — inside `LIVENESS_ALIVE_TAIL_LINES` (12), where
`CODEX_PROMPT_PATTERN` matches it and `judgeToolLiveness` therefore answers
**alive**.

That is the shared rule of Issue #2070 behaving exactly as designed (an alive
pattern anywhere in the bottom window vetoes an exit, because a relaunch hangs
off the verdict and a relaunch into a live pane types the launch command into an
agent's composer). It is also why `CodexTool.waitForReady` asks the narrower
question `findShellPromptTail` instead, and only about a pane it has just
watched answer the update dialog. The test asserts **both** halves — that
`judgeToolLiveness` says alive and that `findShellPromptTail` finds the prompt —
so that a future widening of the shared rule shows up here as a failure rather
than as a silent behaviour change.
