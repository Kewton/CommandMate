# OpenCode V2 form frames (Issue #2945)

`sse-form-measured.json` is what `GET /api/event` sent on opencode2 2.0.18
(2026-09-28, isolated server, a throwaway repository) when the model was asked to
use its question tool and the question was then answered over
`POST /api/session/{id}/form/{formID}/reply`:

- `form.created` carries the whole form NESTED, as `data.form` (`{id, sessionID,
  title, metadata: {kind: "question", tool}, fields}`) — not as `data`;
- `form.replied` carries `data: {id, sessionID, answer}`.

Only `location.directory` was replaced (`/tmp/probe/repo`); ids are as sent.

## Screen frames (Issue #2965)

Captured on 2026-09-29 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`), pane
80x200, in a throwaway git repository whose `opencode.json` sets
`"permission": {"edit": "ask"}`. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` /
`XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed at a scratch directory, and the one
session the probe created was deleted through `DELETE /api/session/{id}` (204).
ANSI was stripped, trailing blanks trimmed, and the footer's working-directory
cell shortened to `/…/tmp/probe/repo`. Nothing else was edited.

| File | What |
|---|---|
| `permission-required.txt` | an edit approval: `△ Permission required` / `→ Edit notes.txt` / the diff / `┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter con`; no footer, no `esc interrupt`; `!` on the session tab |
| `turn-done-after-approval.txt` | the same turn after `Allow once`: `Done.` / `Build · <model> · 23.2s · 18.3 tok/s`, footer `8.8K (1%)  ctrl+p commands` |
| `question.txt` | the question tool's form: `Questions` / `Which color do you prefer?` / `1. Red` / `2. Blue` / `3. Type your own answer` / `┃  ↑↓ select  enter submit  esc dismiss`; no footer; `?` on the session tab; the previous turn's completion row is still above it |
| `question-answered.txt` | after Enter on `Red`: `You chose Red.` / `Build · <model> · 22.1s · 21.2 tok/s` |

Pinned by `tests/unit/detection/tools/opencode-v2/detect.test.ts`.
