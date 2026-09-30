# OpenCode V2 history fixtures (Issue #2940)

Captured on 2026-09-28 from the real `opencode2` **2.0.18**: a private
`opencode2 serve --hostname 127.0.0.1` with its own password, in a throw-away
git repository, two turns sent with `opencode2 run --server … --format json`
(the second one with `-s <session>` and a tool call). The session was deleted
through `DELETE /api/session/{id}` (204) afterwards.

| File | What |
|---|---|
| `session-messages-two-turns-2.0.18.json` | `GET /api/session/{id}/message` after both turns, verbatim (newest first: `idle`, `assistant`, `assistant`, `user`, `idle`, `assistant`, `user`) |
| `sse-two-turns-2.0.18.json` | the `session.execution.*`, `session.text.*`, `session.step.ended` and `session.tool.called/success` frames `GET /api/event` sent for the same two turns, in order |

Only `location.directory` was edited (the scratch path is replaced with
`/…/tmp/probe/repo`). Things these pin, measured:

- a turn is `user` → one `assistant` per model step → `idle` (`outcome`);
  assistant messages carry no parent id;
- `assistant.content[]` is `{type: "reasoning" | "text" | "tool", …}`; a tool
  item has `name` and `state.status` but no `title`;
- `session.execution.succeeded` carries `data.sessionID` and no `location`.
