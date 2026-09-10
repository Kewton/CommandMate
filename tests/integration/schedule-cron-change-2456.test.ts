/**
 * A rewritten Cron column reaches the running scheduler (Issue #2456).
 *
 * ## Why this is not the unit suite over again
 *
 * `tests/unit/lib/schedule-manager.test.ts` proves the swap with every seam
 * mocked: the file, its mtime, the parser, and the DB upsert are all doubles, so
 * what it can pin is the manager's own decision — which timer is alive and when
 * it fires. That is the half where the defect lived, and the mutant that keeps
 * the old `existingState.entry = entry` kills eight of those tests.
 *
 * It cannot, however, say that the three surfaces an operator actually looks at
 * agree afterwards. The Cron column is edited in CMATE.md, the row it upserts is
 * read back from `scheduled_executions`, and the next run time is served by
 * `GET /api/worktrees/[id]/schedules/active` off the in-memory timer — three
 * different readers of the same edit, and #2456 is precisely the shape where two
 * of them said the new expression while the third kept running the old one.
 *
 * So this file substitutes only the database handle and the CLI launch. The
 * file on disk is real (written, then `utimesSync`d so the mtime cache sees a
 * change deterministically rather than relying on filesystem timestamp
 * resolution), `readCmateFile`, `parseSchedulesSection`, `batchUpsertSchedules`,
 * `getCmateMtime`, `syncSchedulesNow` and the route handler are all the real
 * ones.
 *
 * Times are asserted as "hour 4, minute 30" rather than against a second
 * `new Cron(...).nextRun()`, which would only prove croner agrees with itself.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbHolder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => dbHolder.db,
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

// Nothing here should be able to launch a CLI even if a schedule did fire.
vi.mock('@/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/claude-executor')>();
  return { ...actual, executeClaudeCommand: vi.fn() };
});

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { syncSchedulesNow, stopAllSchedules } from '@/lib/schedule-manager';
import { GET } from '@/app/api/worktrees/[id]/schedules/active/route';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2456-int';

/** Daily at 03:00 — what the file says first. */
const NIGHTLY = '0 3 * * *';
/** Daily at 04:30 — the rewrite. */
const LATER = '30 4 * * *';

let worktreePath: string;
let mtimeSeed: number;

/**
 * `schedule-manager`, `cron-parser` and `job-executor` all reach the database
 * through a lazy CJS `require('./db/db-instance')`, which `vi.mock` does not
 * intercept. Patching `Module._load` is the seam
 * `schedule-opencode-run-options-2044.test.ts` established for the same module.
 */
type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const M = Module as unknown as ModuleWithLoad;
const originalLoad = M._load;

function cmateWith(cron: string, message: string): string {
  return `# CMATE

## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | ${cron} | ${message} | claude | true | acceptEdits |
`;
}

/**
 * Write CMATE.md and move its mtime forward by a known amount, so the manager's
 * mtime cache sees a change without the test depending on how fine-grained the
 * filesystem's timestamps happen to be.
 */
function writeCmate(cron: string, message = 'Review the diff'): void {
  const file = path.join(worktreePath, 'CMATE.md');
  fs.writeFileSync(file, cmateWith(cron, message), 'utf-8');
  mtimeSeed += 10;
  const stamp = new Date(Date.now() + mtimeSeed * 1000);
  fs.utimesSync(file, stamp, stamp);
}

interface ActiveSchedule {
  scheduleId: string;
  cronExpression: string;
  nextRunAt: number | null;
  isCronActive: boolean;
}

/** What the API serves for this worktree. */
async function activeSchedules(): Promise<ActiveSchedule[]> {
  const response = await GET(new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/schedules/active`), {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { schedules: ActiveSchedule[] };
  return body.schedules;
}

/** What the database holds for this worktree. */
function scheduleRows(): Array<{ id: string; cron_expression: string; message: string; enabled: number }> {
  return dbHolder.db
    .prepare('SELECT id, cron_expression, message, enabled FROM scheduled_executions WHERE worktree_id = ?')
    .all(WORKTREE_ID) as Array<{ id: string; cron_expression: string; message: string; enabled: number }>;
}

/** Local hour/minute of a next-run timestamp the API served. */
function clockOf(nextRunAt: number | null): { hour: number; minute: number } {
  expect(nextRunAt, 'the API served no next run time').not.toBeNull();
  const when = new Date(nextRunAt!);
  expect(when.getTime(), 'the next run is in the past').toBeGreaterThan(Date.now());
  return { hour: when.getHours(), minute: when.getMinutes() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mtimeSeed = 0;
  worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-2456-'));

  dbHolder.db = new Database(':memory:');
  runMigrations(dbHolder.db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'wt-2456-int',
    path: worktreePath,
    repositoryPath: worktreePath,
    repositoryName: 'commandmate',
    cliToolId: 'claude',
  };
  upsertWorktree(dbHolder.db, worktree);

  M._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('db-instance')) return { getDbInstance: () => dbHolder.db };
    return originalLoad.call(Module, request, parent, isMain);
  };

  globalThis.__scheduleManagerStates = undefined;
});

afterEach(() => {
  try {
    stopAllSchedules();
  } catch {
    // Cleanup only
  }
  globalThis.__scheduleManagerStates = undefined;
  M._load = originalLoad;
  dbHolder.db.close();
  fs.rmSync(worktreePath, { recursive: true, force: true });
});

describe('[#2456] a rewritten Cron column reaches the DB, the manager and the API together', () => {
  it('moves the next run onto the new expression and keeps the schedule id', async () => {
    writeCmate(NIGHTLY);
    await syncSchedulesNow();

    const before = scheduleRows();
    expect(before).toHaveLength(1);
    expect(before[0].cron_expression).toBe(NIGHTLY);

    const servedBefore = await activeSchedules();
    expect(servedBefore).toHaveLength(1);
    expect(servedBefore[0]).toMatchObject({
      scheduleId: before[0].id,
      cronExpression: NIGHTLY,
      isCronActive: true,
    });
    expect(clockOf(servedBefore[0].nextRunAt)).toEqual({ hour: 3, minute: 0 });

    writeCmate(LATER);
    await syncSchedulesNow();

    // The row is the same row — an edit, not a re-registration.
    const after = scheduleRows();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].cron_expression).toBe(LATER);

    const servedAfter = await activeSchedules();
    expect(servedAfter).toHaveLength(1);
    expect(servedAfter[0]).toMatchObject({
      scheduleId: before[0].id,
      cronExpression: LATER,
      isCronActive: true,
    });
    expect(clockOf(servedAfter[0].nextRunAt)).toEqual({ hour: 4, minute: 30 });
    expect(servedAfter[0].nextRunAt).not.toBe(servedBefore[0].nextRunAt);

    expect(mockLogger.info).toHaveBeenCalledWith('schedule:updated', {
      scheduleId: before[0].id,
      worktreeId: WORKTREE_ID,
      previousCron: NIGHTLY,
      cron: LATER,
    });
  });

  it('leaves the served next run untouched when only the Message changed', async () => {
    writeCmate(LATER);
    await syncSchedulesNow();
    const [served] = await activeSchedules();

    writeCmate(LATER, 'Review yesterday instead');
    await syncSchedulesNow();

    const rows = scheduleRows();
    expect(rows[0].message).toBe('Review yesterday instead');

    const [servedAgain] = await activeSchedules();
    expect(servedAgain.scheduleId).toBe(served.scheduleId);
    expect(servedAgain.cronExpression).toBe(LATER);
    expect(servedAgain.nextRunAt).toBe(served.nextRunAt);
    expect(
      mockLogger.info.mock.calls.filter((call) => call[0] === 'schedule:updated')
    ).toHaveLength(0);
  });

  it('disables the row and stops serving it once the schedule is removed', async () => {
    writeCmate(NIGHTLY);
    await syncSchedulesNow();
    const [served] = await activeSchedules();
    expect(served.cronExpression).toBe(NIGHTLY);

    fs.writeFileSync(path.join(worktreePath, 'CMATE.md'), '# CMATE\n\n## Schedules\n', 'utf-8');
    mtimeSeed += 10;
    const stamp = new Date(Date.now() + mtimeSeed * 1000);
    fs.utimesSync(path.join(worktreePath, 'CMATE.md'), stamp, stamp);
    await syncSchedulesNow();

    expect(await activeSchedules()).toEqual([]);
    expect(scheduleRows()[0].enabled).toBe(0);
  });
});
