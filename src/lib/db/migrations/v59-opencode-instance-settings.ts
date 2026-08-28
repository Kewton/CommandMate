/**
 * Migration v59: what each opencode instance should be launched with (#2048).
 *
 * ## Why a table of its own rather than columns on `agent_instances`
 *
 * `setAgentInstances` is a **replace**: `PATCH /api/worktrees/[id]` sends the
 * whole roster and the write deletes every row for the worktree and re-inserts
 * from the payload. That payload is `AgentInstance[]` — id, tool, alias, order —
 * and nothing else, so a `model` column on that table would be silently reset to
 * null every time the operator renamed an instance or dragged one up the list.
 * A separate table survives the replace, and `pruneOpencodeInstanceSettings`
 * removes the rows whose instance genuinely went away.
 *
 * It is also the only shape that keeps `agentInstances`'s validator and its API
 * contract unchanged, which Issue #2048's second acceptance condition
 * ("claude / codex の instance 設定 UI とスナップショットが不変") asks for
 * directly.
 *
 * ## Column notes
 *
 * - **All four settings are nullable and null means "not chosen"**, never a
 *   default. The launcher omits the flag entirely for a null, so an instance
 *   with a row full of nulls launches byte-identically to one with no row.
 * - **`provider_id` / `model_id` are two columns, not one string.** `-m` takes
 *   `provider/model`, but model ids themselves contain slashes
 *   (`qwen/qwen3-coder-30b`, measured on LMStudio), so a single column could not
 *   be split back apart.
 * - **`variant` is stored even though no launch flag can carry it.** The TUI has
 *   no `--variant` (measured on 1.18.22, §20.3); it is applied on the prompt
 *   this server posts, which is a per-turn decision that still needs a durable
 *   place to be decided *once*.
 * - **`worktree_id` is spelled conventionally** so `getWorktreeChildTables()`
 *   finds it by introspection: the row then follows a worktree id rename
 *   (v54/v55) and is swept when the worktree is deleted, which is the lifetime a
 *   per-instance setting should have.
 *
 * The primary key is `(worktree_id, instance_id)` — the same identity
 * `agent_instances` uses — and the `cli_tool_id` is not part of it: an instance
 * id belongs to one tool by construction (`resolveInstanceCliTool`), so a
 * composite including it would let one instance hold two contradictory rows.
 *
 * The rollback drops the table, which is the whole of what this migration adds.
 */

import type { Migration } from './runner';

export const v59_migrations: Migration[] = [
  {
    version: 59,
    name: 'opencode-instance-settings',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS opencode_instance_settings (
          worktree_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          agent TEXT,
          provider_id TEXT,
          model_id TEXT,
          variant TEXT,
          updated_at INTEGER NOT NULL,

          PRIMARY KEY (worktree_id, instance_id),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS opencode_instance_settings;');
    },
  },
];
