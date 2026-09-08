/**
 * Migration v61: the one-line note an operator keeps beside a session (#2427).
 *
 * ## What a row is, and what it is emphatically not
 *
 * One row is a free-text reminder of what THIS session was last asked to do —
 * "#2427 の DB 層", "レビュー待ち" — rewritten every time the operator hands the
 * session a new instruction. It exists because a four-way split shows four
 * terminals whose headers all read `claude`, and the pane that is three
 * scrollbacks deep gives no answer to "which one was doing the migration".
 *
 * It is **not** an alias. `agent_instances.alias` is a *resolution key*: since
 * Issue #2376 `--instance レビュー担当` finds the roster row whose alias matches,
 * so an alias is a name the routing layer reads. A note is read by human eyes
 * only, and nothing in `resolveInstanceSelector` (the `/resolve-target` route)
 * or in `resolveInstanceCliTool` looks at this table. That separation is the
 * point of storing it apart from the roster rather than widening the alias: a
 * memo the operator rewrites hourly must never be able to change where the next
 * `send` lands.
 *
 * ## Why a table of its own rather than a column on `agent_instances`
 *
 * The reason v59 gives, unchanged: `setAgentInstances` is a full REPLACE —
 * `PATCH /api/worktrees/[id]` posts the whole roster and the write deletes every
 * row for the worktree and re-inserts from the payload, which is
 * `AgentInstance[]` (id, tool, alias, order) and nothing else. A `note` column
 * there would be silently emptied every time somebody renamed an instance or
 * dragged one up the list — i.e. by the two operations most likely to happen
 * while a note is worth keeping. A separate table survives the replace, and
 * `pruneSessionNotes` removes the rows whose instance genuinely went away.
 *
 * It also keeps `AgentInstance` — which is the roster PATCH's *input* shape, not
 * merely its output — free of a field the writer would have to echo back to
 * avoid erasing it.
 *
 * ## Column notes
 *
 * - **`note` is NOT NULL and a row means a note exists.** Clearing the text
 *   deletes the row (see `setSessionNote`) rather than storing `''`: an empty
 *   note and no note are indistinguishable to every reader, and the delete keeps
 *   the table to the sessions somebody actually annotated. That is also what
 *   makes "the note is empty" renderable as *absence* in the split header, which
 *   the Issue asks for.
 * - **`updated_at` is displayed, not just bookkeeping.** The Issue's acceptance
 *   condition is that the note carries the time it was written, so the column is
 *   part of the payload rather than an audit field. Epoch milliseconds, matching
 *   v44 onward.
 * - **`worktree_id` is spelled conventionally** so `getWorktreeChildTables()`
 *   finds it by introspection: the row then follows a worktree id rename
 *   (v54/v55) and is swept when the worktree is deleted, which is exactly as
 *   long as a note about one of that worktree's sessions can mean anything.
 *
 * The primary key is `(worktree_id, instance_id)` — the identity
 * `agent_instances` uses and the identity a note is about. `cli_tool_id` is
 * deliberately absent for v59's reason: an instance id belongs to one tool by
 * construction (`resolveInstanceCliTool`), so a composite including it would let
 * one session hold two contradictory notes.
 *
 * The rollback drops the table, which is the whole of what this migration adds.
 */

import type { Migration } from './runner';

export const v61_migrations: Migration[] = [
  {
    version: 61,
    name: 'session-notes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_notes (
          worktree_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          note TEXT NOT NULL,
          updated_at INTEGER NOT NULL,

          PRIMARY KEY (worktree_id, instance_id),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS session_notes;');
    },
  },
];
