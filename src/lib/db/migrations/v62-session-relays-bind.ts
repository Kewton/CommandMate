/**
 * Migration v62: tie a relay to the send that asked for it (Issue #3957).
 *
 * Until now a relay row knew when it was OPENED (`created_at`, before the CLI
 * sent anything) and nothing about the send itself. The delivery therefore took
 * the newest reply written after `created_at` — which, when the send queued for
 * the input lock or failed, was somebody else's reply (S3 / S5 of the Issue).
 *
 * The columns below record the send: which attempt reserved the relay, when
 * its body started going in, whether a turn was already open then, and how the
 * send ended. `bind_mode` says whether a row takes part at all — every row that
 * existed before this migration, and every row an older CLI opens, is `legacy`
 * and is delivered exactly as before.
 *
 * ## Columns
 *
 * - `bind_mode` — `legacy` | `bound`. NOT NULL with a default, so existing rows
 *   read as legacy without a backfill.
 * - `send_state` — `awaiting` → `input_started` → `sent`, or `failed` /
 *   `unknown`. NULL for legacy (never "sent" by pretence).
 * - `bind_attempt_id` / `bind_owner` — the reservation and the server boot that
 *   holds it, so a reservation orphaned by a restart can be told apart.
 * - `input_boundary_at` / `boundary_kind` — the delivery's lower bound (ms) and
 *   where it was taken: `input_start` (right before the first key) or
 *   `dispatch` (right before an HTTP send that reports no input start).
 * - `turn_open_at_send` — 1 / 0 / NULL (not known).
 * - `obs_state` / `obs_source` — whether the observation can still be trusted
 *   (`valid`, `invalid`, `turn_unknown`) and where it was made (boot id and
 *   session generation).
 * - `input_message_id` — the send's own user row, so it is not counted as
 *   somebody else's input.
 * - `hold_reason` — why the relay is held, published as is.
 * - `held_candidates` — JSON list of completions seen before the send settled.
 * - `overlap` — `none` | `later` | `earlier` | `both` | `unknown`.
 * - `pending_reply` — JSON: a reply finished while a prompt notice was being
 *   delivered (the second slot).
 * - `payload_id` — the id of the payload now in `pending_*`, so a stale
 *   delivery cannot clear a newer one.
 *
 * The rollback drops exactly these columns. None is indexed, part of a foreign
 * key or named in another column's CHECK, so `DROP COLUMN` (SQLite 3.35+) keeps
 * the rows, the pending payloads, the indexes and the foreign keys as they were.
 */

import type { Migration } from './runner';

/** The v62 columns, in the order the rollback drops them. */
export const V62_SESSION_RELAY_COLUMNS = [
  'bind_mode',
  'send_state',
  'bind_attempt_id',
  'bind_owner',
  'input_boundary_at',
  'boundary_kind',
  'turn_open_at_send',
  'obs_state',
  'obs_source',
  'input_message_id',
  'hold_reason',
  'held_candidates',
  'overlap',
  'pending_reply',
  'payload_id',
] as const;

export const v62_migrations: Migration[] = [
  {
    version: 62,
    name: 'session-relays-bind',
    up: (db) => {
      const statements = [
        `ALTER TABLE session_relays ADD COLUMN bind_mode TEXT NOT NULL DEFAULT 'legacy'
           CHECK (bind_mode IN ('legacy','bound'))`,
        `ALTER TABLE session_relays ADD COLUMN send_state TEXT
           CHECK (send_state IN ('awaiting','input_started','sent','failed','unknown'))`,
        'ALTER TABLE session_relays ADD COLUMN bind_attempt_id TEXT',
        'ALTER TABLE session_relays ADD COLUMN bind_owner TEXT',
        'ALTER TABLE session_relays ADD COLUMN input_boundary_at INTEGER',
        `ALTER TABLE session_relays ADD COLUMN boundary_kind TEXT
           CHECK (boundary_kind IN ('input_start','dispatch'))`,
        `ALTER TABLE session_relays ADD COLUMN turn_open_at_send INTEGER
           CHECK (turn_open_at_send IN (0,1))`,
        `ALTER TABLE session_relays ADD COLUMN obs_state TEXT
           CHECK (obs_state IN ('valid','invalid','turn_unknown'))`,
        'ALTER TABLE session_relays ADD COLUMN obs_source TEXT',
        'ALTER TABLE session_relays ADD COLUMN input_message_id TEXT',
        'ALTER TABLE session_relays ADD COLUMN hold_reason TEXT',
        'ALTER TABLE session_relays ADD COLUMN held_candidates TEXT',
        `ALTER TABLE session_relays ADD COLUMN overlap TEXT
           CHECK (overlap IN ('none','later','earlier','both','unknown'))`,
        'ALTER TABLE session_relays ADD COLUMN pending_reply TEXT',
        'ALTER TABLE session_relays ADD COLUMN payload_id TEXT',
      ];
      for (const statement of statements) db.exec(statement);
    },
    down: (db) => {
      for (const column of [...V62_SESSION_RELAY_COLUMNS].reverse()) {
        db.exec(`ALTER TABLE session_relays DROP COLUMN ${column}`);
      }
    },
  },
];
