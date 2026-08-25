# `opencode run --format json` fixtures (Issue #2044)

Captured verbatim from **opencode 1.18.22** on 2026-08-25, inside an isolated
`HOME` built exactly as `docs/design/opencode-server-live-verification.md` §4
prescribes (scratchpad `HOME`, `auth.json` copied at mode 600 and deleted after,
model pinned in `opencode.jsonc`, model picker never opened, dedicated port
4877, no tmux involved). `GET /path` confirmed every one of `home` / `state` /
`config` / `worktree` / `directory` under the scratchpad before anything ran.

Nothing here is hand-written or edited — these are the process's stdout bytes.
See §15 of that design document for the transcript and the reconciliation
against `opencode stats --project ""`.

| file | how it was produced | what it demonstrates |
|------|---------------------|----------------------|
| `plain-text.jsonl` | `opencode run --format json "Reply with exactly this text and nothing else: hello-2044"` | the minimal shape: `step_start` / `text` / `step_finish`; one message |
| `tool-use-then-text.jsonl` | `opencode run --format json --agent plan --variant high --title cm-2044-probe "Read README.md and reply with its exact contents."` | a `tool_use` event and **two** assistant messages — the reason extraction keys on `messageID` rather than "the last text event" |
| `continue-session.jsonl` | `opencode run -c --format json "Reply with exactly: cont-ok"` | `-c` reuses the prior `sessionID` |
| `error.jsonl` | `opencode run --format json -m bogusprovider/nope "hi"` | the failure shape: a single `error` frame **on stdout**, empty stderr, exit 1 |

`step_finish.part.cost` / `.tokens` in these files are per-step. Summing a
session's steps equals what `GET /session` reports for that session, and summing
the sessions equals `opencode stats` — the measurement migration v58's
last-write-wins rule rests on.
