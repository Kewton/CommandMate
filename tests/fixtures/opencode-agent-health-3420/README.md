# opencode-agent-health-3420 — opencode v2.0.18 turns the model provider refused

Used by `tests/unit/lib/agent-health/model-auth-3420.test.ts` (Issues #3420 / #3421 / #3422).

| File | What | Source |
|---|---|---|
| `unauthorized-running-turn.txt` | `Run the shell command: sleep 20` answered with `Error: Unauthorized` (`Build · Mistral Large 4 · 721ms`, Ollama Cloud) | `~/.commandmate/agent-health/frames/2026-10-08/opencode-v2-screen-running.txt` (the retry's frame) |
| `unauthorized-quoted-turn.txt` | the quoted-dialog request alone, answered with the same error | `…/frames/2026-10-08/opencode-v2-screen-quoted-dialog.txt` (the retry's frame) |
| `unauthorized-quoted-after-running-turn.txt` | the daily run's quoted-dialog frame: the refused `sleep 20` turn, then the refused quoted turn | report `2026-10-08.json`, `screen-quoted-dialog` `evidence` |

The two `unauthorized-*-turn.txt` files are raw
`tmux -L cm-agent-health capture-pane -p -e` bytes as the frame archive
(#3183) wrote them, kept byte for byte. The third is the report's
`paneEvidence` (ANSI stripped, the empty rows above the transcript dropped).

Why they exist: on 2026-10-08 the probe's opencode-v2 started on
`Mistral Large 4` (Ollama Cloud) and the provider refused the credentials, so
every turn ended within a second with no reply. The detector read those frames
correctly (`ready` / `opencode_response_complete` after the error, `waiting`
on the quoted dialog left as the last thing on the pane) — the checks could
not be done, nothing in CommandMate was broken.
