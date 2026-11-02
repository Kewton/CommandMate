/**
 * Reads of the relay ledger shared by `relay-db` and its split-out modules.
 *
 * Split out of `relay-db` (Issue #4096); `relay-db` re-exports every name here,
 * so callers (and every `vi.mock`) keep importing from `@/lib/db/relay-db`.
 * This module must not import `relay-db` (no cycle).
 *
 * @module lib/db/relay-db-base
 */

import Database from 'better-sqlite3';
import type { SessionRelay } from '@/lib/relay/types';
import { mapRelay, RELAY_COLUMNS, type SessionRelayRow } from '@/lib/db/relay-bind-db';

/** One relay by id, or null. */
export function getRelayById(db: Database.Database, id: string): SessionRelay | null {
  const row = db
    .prepare(`SELECT ${RELAY_COLUMNS} FROM session_relays WHERE id = ?`)
    .get(id) as SessionRelayRow | undefined;
  return row ? mapRelay(row) : null;
}
