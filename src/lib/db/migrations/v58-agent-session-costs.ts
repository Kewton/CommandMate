/**
 * Migration v58: a durable ledger of what each agent session has spent
 * (Issue #2044).
 *
 * ## Why the numbers need a table at all
 *
 * Issue #2040 already reads `session.updated` off opencode's SSE stream and
 * keeps `{ cost, tokens }` per instance in `lib/hooks/agent-session-telemetry`.
 * That record is **in memory and dies with the subscription** — killing the pane
 * drops it — which is exactly right for what it publishes
 * (`structuredEvents.session`, "what is this conversation costing *now*") and
 * useless for what a daily report asks ("what did today cost"). A report
 * generated at 18:00 would see nothing of a session that ended at noon.
 *
 * So the ledger is a *sampler's* table, not a second event mapping: nothing here
 * subscribes to anything, and no `session.updated` writer is added. A sampler
 * copies the live record in, keyed by the agent's own session id.
 *
 * ## Why `session_id` is the primary key, and why writes overwrite
 *
 * `Session.cost` and `Session.tokens` are **cumulative for the session**, not
 * per-turn. Measured on opencode 1.18.22 in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §15): a session whose two
 * steps reported `0.03372225` and `0.0038181` answered `cost: 0.03754035` on
 * `GET /session`, and summing the two sessions in that project reproduced
 * `opencode stats --project ""`'s `Total Cost` ($0.07), `Input` (6),
 * `Output` (181), `Cache Read` (8.4K) and `Cache Write` (16.7K) exactly.
 *
 * That makes last-write-wins the only correct rule: **accumulating** samples
 * would multiply a long-running session's cost by however many times the
 * sampler happened to look at it. `ON CONFLICT(session_id) DO UPDATE` is
 * therefore load-bearing rather than defensive, and it is what lets the sampler
 * run on any schedule at all without the totals depending on its period.
 *
 * ## Column notes
 *
 * - **`date`** is the local calendar day the session was *first sampled*, in the
 *   `YYYY-MM-DD` spelling `daily_reports.date` uses, so the report's day and the
 *   ledger's day are the same string. `first_seen_at` keeps the instant. A
 *   session spanning midnight stays on its opening day rather than being split:
 *   the agent reports one cumulative number and there is no honest way to
 *   apportion it across two days.
 * - **every numeric column is nullable**, and null means "the agent did not
 *   say", never zero — the rule `AgentSessionTokenUsage` states. A session that
 *   has not run a turn publishes no counts, and storing `0` would make this
 *   database assert a measurement nobody took.
 * - **`worktree_id`** is spelled conventionally so `getWorktreeChildTables()`
 *   finds it by introspection: the row then follows a worktree id rename
 *   (v54/v55) and is swept when the worktree is deleted, the same lifetime
 *   `chat_messages` has. The ledger describes what a worktree spent, so it has
 *   no meaning once that worktree is gone — and a report already generated for
 *   that day keeps its text in `daily_reports` regardless. Deliberately **not**
 *   an append-only ledger: `skill_operations`-style `BEFORE UPDATE` triggers
 *   would forbid the overwrite the paragraph above requires.
 *
 * The rollback drops the table, which is the whole of what this migration adds.
 */

import type { Migration } from './runner';

export const v58_migrations: Migration[] = [
  {
    version: 58,
    name: 'agent-session-costs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_session_costs (
          session_id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          instance_id TEXT,
          date TEXT NOT NULL,
          title TEXT,
          agent TEXT,
          model TEXT,
          provider TEXT,
          cost REAL,
          tokens_input INTEGER,
          tokens_output INTEGER,
          tokens_reasoning INTEGER,
          tokens_cache_read INTEGER,
          tokens_cache_write INTEGER,
          first_seen_at INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,

          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // The daily report's only query shape: one day, grouped by worktree.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_session_costs_date
        ON agent_session_costs(date, worktree_id);
      `);
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_agent_session_costs_date;');
      db.exec('DROP TABLE IF EXISTS agent_session_costs;');
    },
  },
];
