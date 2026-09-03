# `commandcode -p … --output-format json` fixtures (Issue #2253)

Captured verbatim from **command-code 1.40.1** on 2026-09-03, in a scratch
directory outside the repository, with `--no-session` so no transcript was
persisted and `--max-turns 1` so each run cost one turn (Issue #2253 「既知の罠」:
headless burns the operator's account quota).

Nothing here is hand-written or edited — these are the process's stdout bytes.
`unknown-model.jsonl` is **empty on purpose**: that run never reached
`runPrintMode`, so it produced no result line at all, and the empty file is the
measurement.

| file | how it was produced | exit | what it demonstrates |
|------|---------------------|------|----------------------|
| `success.jsonl` | `commandcode -p "Reply with exactly: OK" --output-format json --max-turns 1 --no-session --trust --skip-onboarding --no-auto-update` | 0 | the ordinary shape: many `{"type":"event",…}` lines, then one `{"type":"result","subtype":"success",…,"finalText":"OK"}` |
| `max-turns.jsonl` | the same, `--yolo`, asking for a shell tool call it cannot finish in one turn | 8 | the CLI writes the **whole** stream and a result line before exiting non-zero: `subtype":"max_turns"` with `finalText":""` |
| `no-query-error.jsonl` | `commandcode -p "" --output-format json --no-session … < /dev/null` | 1 | the failure shape `buildPrintResultLine` emits: a **single** line, `subtype":"error"`, `finalText":""`, and an `error` field carrying the stderr sentence. There is no `run_end` event to read here |
| `unknown-model.jsonl` (empty) + `unknown-model.stderr.txt` | `commandcode -p "hi" --output-format json --model definitely-not-a-real-model …` | 1 | a run that dies before the print loop: **empty stdout**, message on stderr only. The decoder must answer `null` rather than "the agent said nothing" |

The exit codes are `PRINT_EXIT_CODE` in `command-code@1.40.1/dist/cli.mjs`:
`{SUCCESS:0, ERROR:1, AUTH_ERROR:3, PERMISSION_DENIED:4, RATE_LIMITED:5,
CONNECTION_ERROR:6, SERVER_ERROR:7, MAX_TURNS_REACHED:8, NO_RESPONSE:9,
INSUFFICIENT_CREDITS:10, INTERRUPTED:130}`.
