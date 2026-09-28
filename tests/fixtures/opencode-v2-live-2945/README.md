# OpenCode V2 form frames (Issue #2945)

`sse-form-measured.json` is what `GET /api/event` sent on opencode2 2.0.18
(2026-09-28, isolated server, a throwaway repository) when the model was asked to
use its question tool and the question was then answered over
`POST /api/session/{id}/form/{formID}/reply`:

- `form.created` carries the whole form NESTED, as `data.form` (`{id, sessionID,
  title, metadata: {kind: "question", tool}, fields}`) — not as `data`;
- `form.replied` carries `data: {id, sessionID, answer}`.

Only `location.directory` was replaced (`/tmp/probe/repo`); ids are as sent.
