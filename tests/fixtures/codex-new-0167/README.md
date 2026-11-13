# `codex-new-0167` — Codex 0.167.1 `/new` worktree picker (Issue #4313 (a))

`worktree-picker.txt` is the bottom of the pane after `/new` was sent to Codex
v0.167.1 inside a git worktree: the previous turn's tail, then the
"Where should the new conversation run?" picker. Read by
`tests/integration/api-send-codex-new-4313.test.ts`.

Source: `dev-reports/issue/4228/uat-s1-8-run/steps/capture-s7-new-cx.txt`
lines 284-292 (run 1, S7-on-cx, 2026-11-12 04:12 JST; the original has 292 lines),
trailing whitespace trimmed, nothing else edited. Server-side refusal of the next
body: `server.log.txt:6208-6243` of the same run (investigation:
`enabler-return-4313-cause.md` A-1).
