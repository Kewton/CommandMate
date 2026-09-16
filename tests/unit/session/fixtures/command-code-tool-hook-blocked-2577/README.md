# `tool_hook_blocked` streams from `commandcode -p … --output-format json` (Issue #2577)

Captured verbatim from **command-code 1.53.1** on 2026-09-16, in a scratch
directory outside the repository, with `--no-session` so no transcript was
persisted and a small `--max-turns` so each run cost at most a few turns.
**None of the runs passed `--yolo`**, so `resolvePrintHarnessMods` injected the
`print-permission-gate` mod, which answers `edit_file` / `write_file` /
`shell_command` / `monitor_command` / `kill_shell` with `block: true`.

Nothing here is hand-written or edited — these are the process's stdout bytes
(and, for the exit-8 run, its stderr).

Common flags: `--output-format json --no-session --trust --skip-onboarding --no-auto-update`.

| file | prompt (abridged) / extra flags | exit | what it demonstrates |
|------|----------------------------------|------|----------------------|
| `all-blocked.jsonl` | "call write_file once … then reply with exactly: DONE" / `--max-turns 3` | 0 | the #2577 shape: the only tool call is blocked, the run still ends `subtype: "success"`, and `finalText` is `DONE` — **it never mentions the block** |
| `blocked-then-read.jsonl` | "write_file once, then whatever happened read_file on input.txt, reply with its text" / `--max-turns 4` | 0 | a blocked call followed by a tool that *did* run (`tool_running` → `tool_completed` for `read_file`) and a real answer — the "blocked, but the run still got work done" case that must not be failed |
| `blocked-max-turns.jsonl` + `.stderr.txt` | "use write_file to create note.txt" / `--max-turns 1` | 8 | a blocked call on a run that fails for another reason (`subtype: "max_turns"`): the failure must stay a failure |

## The event, as the stream carries it

`createPrintJsonEventStream` writes every agent event through
`serializeAgentEventLine`, i.e. wrapped as `{"type":"event","event":{…}}`:

```text
{"type":"event","event":{"type":"tool_queued","toolCallId":"call_…","toolName":"write_file","input":{…}}}
{"type":"event","event":{"type":"tool_hook_blocked","toolCallId":"call_…","toolName":"write_file","hookOutput":"Error: Tool \"write_file\" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode."}}
```

`executeOne` returns straight after emitting `tool_hook_blocked`, so a blocked
call has a `tool_queued` and **no** `tool_running` / `tool_completed` /
`tool_errored` (visible in all three files).
