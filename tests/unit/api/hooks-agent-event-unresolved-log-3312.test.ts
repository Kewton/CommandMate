/**
 * Issue #3312: `agent-event-unresolved-target` says which run a stray event
 * came from — `worktreeId` when the hook named one, `cwdHash` (SHA-256 of
 * `cwd`, first 16 hex characters) when it carried a `cwd` — and never logs
 * `cwd` itself.
 *
 * Positive control: before this Issue the line held `tool` and `event` only.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (...args: unknown[]) => info(...args),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => db,
}));

const asReq = (req: Request) => req as unknown as NextRequest;

async function post(body: unknown, query = '') {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
}

function unresolvedLines(): Record<string, unknown>[] {
  return info.mock.calls
    .filter(([name]) => name === 'agent-event-unresolved-target')
    .map(([, fields]) => fields as Record<string, unknown>);
}

const sha16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

beforeEach(() => {
  info.mockClear();
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('agent-event-unresolved-target (Issue #3312)', () => {
  it('carries cwdHash for an event with no worktree id, and never the cwd', async () => {
    const cwd = '/Users/cmcheck/run/2610060715-ab12/root/repo';
    const res = await post({ tool: 'claude', event: 'stop', cwd });
    expect(res.status).toBe(202);

    const [line] = unresolvedLines();
    expect(line).toEqual({ tool: 'claude', event: 'stop', cwdHash: sha16(cwd) });
    expect(line.cwdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(info.mock.calls)).not.toContain(cwd);
  });

  it('carries the worktree id the hook URL named, with the cwdHash when a cwd came too', async () => {
    const cwd = '/Users/cmcheck/run/x/root/repo';
    await post({ tool: 'codex', event: 'stop', cwd }, '?worktreeId=wt-not-here&instanceId=codex');
    expect(unresolvedLines()).toEqual([
      { tool: 'codex', event: 'stop', worktreeId: 'wt-not-here', cwdHash: sha16(cwd) },
    ]);
  });

  it('carries the worktree id alone when no cwd came', async () => {
    await post({ tool: 'codex', event: 'stop' }, '?worktreeId=wt-not-here&instanceId=codex');
    expect(unresolvedLines()).toEqual([{ tool: 'codex', event: 'stop', worktreeId: 'wt-not-here' }]);
  });
});
