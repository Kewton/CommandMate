/**
 * API Route tests — POST /api/worktrees/:id/verify/runs/:runId/cancel (#2063)
 *
 * The integration suite drives this route with a REAL runner, which is what
 * proves the child processes die. What it cannot reach is the route's other two
 * answers: `requested` only happens when a signalled run outlives an 8s budget,
 * and `not-running` only when a `running` row has no switch behind it. Both are
 * states you wait for or corrupt the database to produce, so here the runner is
 * mocked and the route's own translation is the thing under test.
 *
 * Three answers that must stay distinct, because the caller behaves differently
 * for each: 200 "it closed", 202 "the signal is out, keep polling", 409
 * "nothing to cancel".
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createVerificationRun, finishVerificationRun, upsertWorktree } from '@/lib/db';
import type { CancelVerificationOutcome } from '@/lib/verification/gate-runner';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

/**
 * `cancelVerification` is the ONLY thing this route uses from the runner, so a
 * total replacement is safe here and keeps the real module (better-sqlite3,
 * spawn, the push notifier) out of a route test entirely.
 */
const cancelVerification = vi.fn<(runId: number) => Promise<CancelVerificationOutcome>>();
vi.mock('@/lib/verification/gate-runner', () => ({
  cancelVerification: (runId: number) => cancelVerification(runId),
}));

let db: Database.Database;
const WT_ID = 'wt-cancel-route';
const OTHER_ID = 'wt-cancel-other';

const asReq = (req: Request) => req as unknown as NextRequest;

async function postCancel(id: string, runId: string) {
  const { POST } = await import('@/app/api/worktrees/[id]/verify/runs/[runId]/cancel/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/verify/runs/${runId}/cancel`, {
        method: 'POST',
      })
    ),
    { params: Promise.resolve({ id, runId }) }
  );
}

/** A run row in `running` state, which is the only state the route will act on. */
function openRun(worktreeId = WT_ID): number {
  return createVerificationRun(db, {
    worktreeId,
    trigger: 'api',
    instanceId: null,
    taskId: null,
    baseRef: 'main',
  }).id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  for (const id of [WT_ID, OTHER_ID]) {
    upsertWorktree(db, {
      id,
      name: `feature/${id}`,
      path: `/tmp/${id}`,
      repositoryPath: `/tmp/${id}`,
      repositoryName: 'fixture',
    });
  }
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('POST …/cancel — the runner closed the run (Issue #2063)', () => {
  it('answers 200 with the verdict the run closed at', async () => {
    const runId = openRun();
    cancelVerification.mockResolvedValue({ kind: 'cancelled', status: 'cancelled' });

    const res = await postCancel(WT_ID, String(runId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, status: 'cancelled' });
    expect(cancelVerification).toHaveBeenCalledWith(runId);
  });
});

describe('POST …/cancel — signalled but still winding down (Issue #2063)', () => {
  it('answers 202, not 200: the run has NOT reached a verdict yet', async () => {
    const runId = openRun();
    cancelVerification.mockResolvedValue({ kind: 'requested' });

    const res = await postCancel(WT_ID, String(runId));

    // 202 is the whole point of this branch. A 200 here would tell the client
    // the run is over while a SIGTERMed gate is still exiting — and the client
    // stops showing the "stopping…" state on the strength of it.
    expect(res.status).toBe(202);
    // `running`, not `cancelled`: reporting a verdict the run has not reached
    // is the same lie in the body that the status code would be in the header.
    expect(await res.json()).toEqual({ runId, status: 'running' });
  });
});

describe('POST …/cancel — nothing to cancel (Issue #2063)', () => {
  it('answers 409 when the row is running but no switch in this process owns it', async () => {
    const runId = openRun();
    cancelVerification.mockResolvedValue({ kind: 'not-running' });

    const res = await postCancel(WT_ID, String(runId));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(String(body.error)).toContain('not executing in this server process');
  });

  it('answers 409 for a run that already reached a verdict, without asking the runner', async () => {
    const runId = openRun();
    finishVerificationRun(db, runId, 'passed');

    const res = await postCancel(WT_ID, String(runId));

    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('passed');
    // Not merely "did not cancel it": the runner is never consulted, so a
    // finished run cannot be signalled by a stale id from an open tab.
    expect(cancelVerification).not.toHaveBeenCalled();
  });

  it('answers 404 for a run belonging to another worktree, without asking the runner', async () => {
    const runId = openRun(OTHER_ID);

    const res = await postCancel(WT_ID, String(runId));

    expect(res.status).toBe(404);
    expect(cancelVerification).not.toHaveBeenCalled();
  });

  it('answers 404 for a worktree that does not exist', async () => {
    expect((await postCancel('no-such-worktree', '1')).status).toBe(404);
    expect(cancelVerification).not.toHaveBeenCalled();
  });

  it('answers 500 rather than leaking when the runner throws', async () => {
    const runId = openRun();
    cancelVerification.mockRejectedValue(new Error('boom in the runner'));

    const res = await postCancel(WT_ID, String(runId));

    expect(res.status).toBe(500);
    expect(String((await res.json()).error)).not.toContain('boom in the runner');
  });
});
