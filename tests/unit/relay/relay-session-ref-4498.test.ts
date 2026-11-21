/**
 * Issue #4498: `tryResolveRelaySession` is the delivery's reading of a relay end —
 * the same answer as `resolveRelaySession` when the roster can be read, and null
 * (never the claude fallback) when it cannot. `resolveRelaySession`'s display
 * behaviour is unchanged (I3).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { resolveRelaySession, tryResolveRelaySession } from '@/lib/relay/relay-session-ref';

const WT = 'wt-4498-ref';
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    WT, WT, `/tmp/${WT}`, 'codex', Date.now(),
  );
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(WT, 'rev-1', 'gemini', 'Reviewer', Date.now());
});

afterEach(() => {
  db.close();
});

describe('Issue #4498: tryResolveRelaySession', () => {
  it('4498 a readable roster: the same answer as resolveRelaySession (roster, ad-hoc → default, tool-named id)', () => {
    for (const instanceId of ['rev-1', 'x-adhoc', 'claude']) {
      const endpoint = { worktreeId: WT, instanceId };
      expect(tryResolveRelaySession(db, endpoint)).toEqual(resolveRelaySession(db, endpoint));
    }
    expect(tryResolveRelaySession(db, { worktreeId: WT, instanceId: 'rev-1' })).toMatchObject({ cliToolId: 'gemini', alias: 'Reviewer' });
  });

  it('4498 an unreadable roster: null, where the display reading still answers claude and the id (I3)', () => {
    const broken = new Database(':memory:');
    try {
      const endpoint = { worktreeId: WT, instanceId: 'rev-1' };
      expect(tryResolveRelaySession(broken, endpoint)).toBeNull();
      expect(resolveRelaySession(broken, endpoint)).toEqual({ worktreeId: WT, instanceId: 'rev-1', cliToolId: 'claude', alias: 'rev-1' });
    } finally {
      broken.close();
    }
  });
});
