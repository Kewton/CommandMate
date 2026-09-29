# OpenCode V2 session usage (Issue #2981)

Captured on 2026-09-29 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`, pane
200x60) in a throwaway git repository, with `env -i` and `HOME` /
`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed
at a temporary directory. Model: the server default
`opencode/longcat-2.5-preview-free` (no credential). Two turns typed into the
TUI: `Reply with exactly: ALPHA one`, then
`List the files in this directory using a tool, then reply with: BETA two`.

| File | What |
|---|---|
| `sse-usage-two-turns-2.0.18.json` | the `session.created` / `renamed` / `execution.*` / `step.ended` / `usage.updated` frames of `GET /api/event`, in order |
| `session-list-after-one-turn-2.0.18.json` | `GET /api/session` after turn 1 |
| `session-get-after-two-turns-2.0.18.json` | `GET /api/session/{id}` after turn 2 |
| `session-messages-two-turns-2.0.18.json` | `GET /api/session/{id}/message?limit=100&order=desc` after turn 2 |
| `model-list-opencode-provider-2.0.18.json` | `GET /api/model`, `data` narrowed to `providerID: "opencode"` (the machine's local providers removed) |
| `pane-turn1-2.0.18.txt` / `pane-turn2-2.0.18.txt` | the TUI after each turn (sidebar `Context` and the footer) |

Edited: the scratch path is replaced with `/…/tmp/probe/repo` (and the server's
cwd with `/…/tmp/probe/cwd`), trailing blanks of the pane trimmed. Nothing else.

## What each number is

| quantity | source | turn 1 | turn 2 |
|---|---|---|---|
| session, cumulative (input / output / reasoning / cache.read) | last `session.usage.updated` = `GET /api/session/{id}` `tokens` | 2857 / 12 / 64 / 3840 | 5925 / 34 / 128 / 13312 |
| context, last turn | newest assistant message `tokens` summed (= its `session.step.ended`) | 6,208 | 6,341 |
| TUI | footer / sidebar | `6.2K (1%)` / `6,208 tokens`, `1% used` | `6.3K (1%)` / `6,341 tokens`, `1% used` |
| limit | `GET /api/model` `limit.context` | 1,000,000 | 1,000,000 |

`cost` was `0` throughout (a free model). The first `session.usage.updated` of the
session (13 / 6 / 34 / 512) precedes every assistant step: it is the
title-generation call, counted in the session total and in no message. So the
session total is not the context, exactly as on v1 (#2042).

Pinned by `tests/unit/hooks/sources/opencode-v2/usage-2981.test.ts`.
