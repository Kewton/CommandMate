# OpenCode V2: a numbered list in the reply body (Issue #2991)

`uat-tc04-pane.txt` is the pane from the 2026-09-29 UAT
(`dev-reports/uat/2026-09-29-2981-2985/evidence/tc04-pane.txt`, F-1): the real
`opencode2` 2.0.18 after it answered "Reply with exactly the following three
lines" with `Pick one:` / `❯ 1. Yes` / `  2. No`. The reply is plain text, not a
dialog. Only the footer's working-directory cell was shortened to
`/…/tmp/probe/repo:master`; nothing else was edited.

| Before #2991 | After |
|---|---|
| `waiting` / `prompt_detected`, `hasActivePrompt: true`, `multiple_choice`; `send` refused (`prompt_waiting`) | `ready` / `opencode_response_complete`, no prompt; `send` accepted |

v2's `detectDialog` answers `null` for this frame, which is why Auto-Yes already
skipped it (#2984). The positive controls are the v2 dialogs in
`../opencode-v2-dialogs-2984/`.

Pinned by `tests/unit/session/opencode-v2-body-numbered-list-2991.test.ts`.
