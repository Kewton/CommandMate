/**
 * Unit tests for the relay ledger's shared row shape and mapper, imported from
 * the module they were split into (Issue #4095).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById } from '@/lib/db/relay-db';
import * as relayBindDb from '@/lib/db/relay-bind-db';
import {
  KEEP_HELD_PAYLOAD_SET,
  OPEN_STATE_PLACEHOLDERS,
  RELAY_COLUMNS,
  mapRelay,
  parseJson,
  type SessionRelayRow,
} from '@/lib/db/relay-bind-db-base';
import { OPEN_RELAY_STATES } from '@/lib/relay/types';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function open(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const id of ['wt-a', 'wt-b']) {
    db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
      id,
      id,
      `/tmp/${id}`,
      NOW
    );
  }
  return db;
}

describe('relay-bind-db-base', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = open();
  });
  afterEach(() => db.close());

  it('relay-bind-db re-exports the same values', () => {
    expect(relayBindDb.RELAY_COLUMNS).toBe(RELAY_COLUMNS);
    expect(relayBindDb.mapRelay).toBe(mapRelay);
    expect(relayBindDb.KEEP_HELD_PAYLOAD_SET).toBe(KEEP_HELD_PAYLOAD_SET);
    expect(relayBindDb.OPEN_STATE_PLACEHOLDERS).toBe(OPEN_STATE_PLACEHOLDERS);
  });

  it('mapRelay over RELAY_COLUMNS reads the same relay as relay-db', () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW, bindMode: 'bound' });
    const row = db
      .prepare(`SELECT ${RELAY_COLUMNS} FROM session_relays WHERE id = ?`)
      .get(relay.id) as SessionRelayRow;
    const mapped = mapRelay(row);
    expect(mapped).toEqual(getRelayById(db, relay.id));
    expect(mapped.from).toEqual(A);
    expect(mapped.bindMode).toBe('bound');
    expect(mapped.sendState).toBe('awaiting');
    expect(mapped.deliveryHold).toBeNull();
  });

  it('OPEN_STATE_PLACEHOLDERS has one placeholder per open state', () => {
    expect(OPEN_STATE_PLACEHOLDERS.split(', ')).toHaveLength(OPEN_RELAY_STATES.length);
  });

  it('parseJson falls back on null and on unreadable text', () => {
    expect(parseJson<number[]>(null, [])).toEqual([]);
    expect(parseJson<number[]>('not json', [1])).toEqual([1]);
    expect(parseJson<number[]>('[2,3]', [])).toEqual([2, 3]);
  });
});
