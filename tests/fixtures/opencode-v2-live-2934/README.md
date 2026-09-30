# OpenCode V2 live fixtures (Issue #2934)

Captured on 2026-09-28 from the real `opencode2` **2.0.18** (npm `@opencode/cli`),
launched through `scripts/opencode-v2/launch.sh` on a private tmux socket
(`tmux -L …`), pane 80x200, in a throw-away git repository. The TUI's state
directory was redirected (`XDG_STATE_HOME`) so the user's
`~/.local/state/opencode` (including the background service's `service.json`)
was not touched, and the one session the turn created was deleted through
`DELETE /api/session/{id}` (204).

| File | What | Provenance |
|---|---|---|
| `boot-idle.txt` | first frame after launch: `┃  Ask anything… "…"`, footer `shift+tab agents  ctrl+p commands` | measured |
| `turn-running.txt` | a turn in progress: footer `⬝⬝⬝⬝■■■■ esc interrupt … ctrl+p commands` | measured |
| `turn-done.txt` | the same turn finished: reply `OK`, completion row `Build · <model> · 3.5s · 11.2 tok/s`, footer `8.6K (1%)  ctrl+p commands`, composer a bare gutter | measured |
| `sse-measured-turn.json` | `session.execution.started` / `session.execution.succeeded` exactly as `GET /api/event` sent them for that turn (no `location`; `durable` instead) | measured |
| `sse-reconstructed.json` | `permission.asked` / `permission.replied` / `form.created` / `form.replied` / `form.cancelled` / `session.execution.failed` / `session.execution.interrupted`, plus one ignored type | reconstructed from the Phase 0 measurement in Epic #2370's 2026-09-28 comment (envelope and the `data` fields it lists); ids and the patch body are placeholders |

The footer's working-directory cell was shortened to `/…/tmp/probe/repo` (the
scratch path it held is not meaningful). Nothing else was edited.

Phase 1 uses these to pin: the composer / footer / running-hint patterns in
`src/lib/detection/cli-patterns.ts` (`OPENCODE_V2_*`), the fallback detector
`src/lib/detection/tools/opencode-v2/detect.ts`, and the SSE mapping table in
`src/lib/hooks/sources/opencode-v2/mappers.ts`.
