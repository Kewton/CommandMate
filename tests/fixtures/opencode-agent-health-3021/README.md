# opencode-agent-health-3021 — the daily probe's opencode 1.18.33 frames

Used by `tests/unit/detection/tools/opencode/agent-health-frames-3021.test.ts`
(Issues #3021 / #3022).

| File | What | Source |
|---|---|---|
| `model-error-running-turn.txt` | `Run the shell command: sleep 20` answered with LM Studio's "No models loaded" error | daily report `2026-09-30.json.retry-opencode-screen-running.json` (`evidence`) |
| `model-error-quoted-turn.txt` | the quoted-dialog request answered with the same error | daily report `2026-09-30.json.retry-opencode-screen-quoted-dialog.json` (`evidence`) |
| `running-turn-submitted.txt` | the `sleep 20` turn just after Enter (`esc interrupt` footer) | live capture, fixed probe |
| `running-turn-sleep.txt` | the same turn while `⠋ sleep 20` runs | live capture, fixed probe |
| `quoted-dialog-reply-done.txt` | the quoted permission box in the reply, turn finished (`· 1.2s`) | live capture, fixed probe |

The two `model-error-*` files are the report's `paneEvidence` — ANSI already
stripped and the empty rows above the transcript dropped. They are kept exactly
as the daily run recorded them. The three live captures are raw
`tmux -L cm-agent-health capture-pane -p -e -S -200 -E -` bytes (80x200, the
production opencode geometry), taken on 2026-09-30 while
`npx tsx scripts/agent-health/run.ts --tools opencode` ran against opencode
1.18.33 (model `Claude Sonnet 5.5`, GitHub Copilot — the model the user's
`model.json` names, seeded into the isolated `XDG_STATE_HOME`).

Why the error frames exist: with #2953's empty `XDG_STATE_HOME` opencode had no
model pick and started on its built-in default (LM Studio `Qwen3 Coder 30B`,
not loaded), so every turn ended in the error above.
