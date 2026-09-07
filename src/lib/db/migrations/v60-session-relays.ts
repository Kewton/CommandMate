/**
 * Migration v60: the relay ledger (Issue #2377).
 *
 * ## What a row is
 *
 * One row is one standing instruction: "when session B finishes the turn it is
 * working on, put its answer into session A's composer". Until this Issue that
 * instruction existed only as a shape in session A's own control flow — `send`,
 * then `wait`, then `capture` — which is why A had to stay blocked to collect a
 * reply it had already asked for. A ledger row is the same intent written down
 * somewhere the server can act on, so A can go and do something else.
 *
 * ## Why `from` is the requester and `to` is the worker
 *
 * The row is named after the DELEGATION, not after the delivery: `from` is the
 * session that asked (and is therefore owed the answer), `to` is the session
 * that was asked. So `commandmate relays` reads "mine, out" as
 * `from = me` and "mine, in" as `to = me`, and the badges the Agent pane draws
 * read the same way round — B's row says it owes A a reply, A's row says it is
 * waiting on n of them.
 *
 * ## The columns that are not just bookkeeping
 *
 * - **`sent_request_id`** is the idempotency key the Issue asks for. The turn's
 *   end is judged by two independent producers (the Stop hook and the poller,
 *   see `lib/polling/structured-history-gate`), so the delivery has to be
 *   claimable exactly once. It carries the `relay:<id>` request id of the row
 *   written into A's history, which is also what makes the delivered message
 *   findable from the ledger and the ledger findable from the message — that
 *   second direction is what the loop guard reads.
 * - **`pending_kind` / `pending_body`** hold a delivery that has been decided
 *   but not yet made. A is frequently mid-turn when B finishes, and typing into
 *   a running composer interrupts it (#1737's problem, one layer up), so the
 *   body waits in the ledger — durable across a restart — and the pump retries.
 *   `pending_kind IS NULL` is also the "nobody has captured this turn yet"
 *   guard that makes the two producers cost one delivery.
 * - **`prompt_signature`** dedupes the confirmation notice. A wait that lasts
 *   twenty minutes must reach A once, not once per poll.
 * - **`hops`** is the chain depth. 1 for a relay a human or an unrelated turn
 *   started; n+1 for one created while answering a relay-delivered message.
 *
 * `state` is CHECK-constrained for the reason v50's `tasks.status` is: the five
 * words are the point of the table, and a typo landing as a sixth would create
 * a bucket nothing queries.
 *
 * Both worktree columns declare a foreign key so `getWorktreeChildTables()`
 * finds them by introspection — the pair follows a worktree id rename (v54/v55)
 * and is swept when either side is deleted, which is the right lifetime: a relay
 * whose requester or whose worker is gone can never be delivered.
 *
 * Timestamps are epoch milliseconds (INTEGER), matching v44 onward.
 */

import type { Migration } from './runner';

export const v60_migrations: Migration[] = [
  {
    version: 60,
    name: 'session-relays',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_relays (
          id TEXT PRIMARY KEY,
          from_worktree_id TEXT NOT NULL,
          from_instance_id TEXT NOT NULL,
          to_worktree_id TEXT NOT NULL,
          to_instance_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','delivered','prompt','expired','cancelled')),
          hops INTEGER NOT NULL DEFAULT 1,
          sent_request_id TEXT,
          pending_kind TEXT,
          pending_body TEXT,
          prompt_signature TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          delivered_at INTEGER,

          FOREIGN KEY (from_worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
          FOREIGN KEY (to_worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // The idempotency key, enforced rather than merely intended. Partial so
      // the many rows that have not been delivered yet do not collide on NULL.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_relays_sent_request
          ON session_relays(sent_request_id)
          WHERE sent_request_id IS NOT NULL;
      `);

      // The two lookups every reader makes: "what does this session owe" and
      // "what is this session waiting for".
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_relays_to
          ON session_relays(to_worktree_id, to_instance_id, state);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_relays_from
          ON session_relays(from_worktree_id, from_instance_id, state);
      `);
      // The sweep's own read: everything still open, oldest deadline first.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_relays_open
          ON session_relays(state, expires_at);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS session_relays;');
    },
  },
];
