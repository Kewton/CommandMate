/**
 * Migration v63: record the relay delivery's own attempt (Issue #4064).
 *
 * Until now a payload in `pending_*` had one state — queued — and the only lock
 * on its delivery was the in-process claim. A send whose outcome could not be
 * told (`indeterminate`, a throw after `sent`, a throw before any state) was
 * released like an unsent one and typed again by the next pump, and a server
 * that died mid-send forgot the attempt altogether.
 *
 * The columns below say, per payload, whether a delivery has started and how
 * it ended when that end is not known:
 *
 * - `delivery_state` — NULL (queued; every row that existed before this
 *   migration, `payload_id` NULL included) | `attempting` (written before the
 *   first key; only the writer of it sends) | `uncertain` (the attempt's outcome
 *   is not known; never sent again automatically).
 * - `delivery_attempt_id` — the attempt that took the payload; the result is
 *   written only under it.
 * - `delivery_owner` — the server boot that took it, so a restart can tell its
 *   own live attempts from the previous boot's interrupted ones.
 * - `delivery_reason` — why it is held (`SendAttemptReason`, `send-threw`,
 *   `threw-after-sent`, `server-restarted`), published as is.
 * - `delivery_at` — epoch ms of the last change of `delivery_state`.
 *
 * The rollback drops exactly these columns. None is indexed, part of a foreign
 * key or named in another column's CHECK.
 */

import type { Migration } from './runner';

/** The v63 columns, in the order the rollback drops them. */
export const V63_SESSION_RELAY_COLUMNS = [
  'delivery_state',
  'delivery_attempt_id',
  'delivery_owner',
  'delivery_reason',
  'delivery_at',
] as const;

export const v63_migrations: Migration[] = [
  {
    version: 63,
    name: 'session-relays-delivery-attempt',
    up: (db) => {
      const statements = [
        `ALTER TABLE session_relays ADD COLUMN delivery_state TEXT
           CHECK (delivery_state IN ('attempting','uncertain'))`,
        'ALTER TABLE session_relays ADD COLUMN delivery_attempt_id TEXT',
        'ALTER TABLE session_relays ADD COLUMN delivery_owner TEXT',
        'ALTER TABLE session_relays ADD COLUMN delivery_reason TEXT',
        'ALTER TABLE session_relays ADD COLUMN delivery_at INTEGER',
      ];
      for (const statement of statements) db.exec(statement);
    },
    down: (db) => {
      for (const column of [...V63_SESSION_RELAY_COLUMNS].reverse()) {
        db.exec(`ALTER TABLE session_relays DROP COLUMN ${column}`);
      }
    },
  },
];
