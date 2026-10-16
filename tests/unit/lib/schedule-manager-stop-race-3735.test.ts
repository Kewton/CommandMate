/**
 * A stop that lands while syncSchedules() awaits readCmateFile() must stick (Issue #3735).
 *
 * Every seam except the manager itself and croner is a double: the file read is a
 * deferred the test resolves by hand, so the stop is placed exactly in the window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stopAllSchedules,
  stopScheduleForWorktree,
  getActiveScheduleCount,
  getActiveSchedulesForWorktree,
  syncSchedulesNow,
} from '../../../src/lib/schedule-manager';
import { readCmateFile, parseSchedulesSection } from '../../../src/lib/cmate-parser';
import { getAllWorktrees, getCmateMtime, batchUpsertSchedules } from '../../../src/lib/cron-parser';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../../../src/lib/cmate-parser', () => ({
  readCmateFile: vi.fn(),
  parseSchedulesSection: vi.fn(),
}));

vi.mock('../../../src/lib/job-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/job-executor')>();
  return { ...actual, executeSchedule: vi.fn(() => Promise.resolve()), recoverRunningLogs: vi.fn() };
});

vi.mock('../../../src/lib/cron-parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/cron-parser')>();
  return {
    ...original,
    getAllWorktrees: vi.fn(),
    getCmateMtime: vi.fn(),
    batchUpsertSchedules: vi.fn(),
    disableStaleSchedules: vi.fn(),
  };
});

const WT = { id: 'wt-3735', path: '/virtual/wt-3735' };

function entry(cron: string) {
  return { name: 'nightly', message: 'm', cronExpression: cron, cliToolId: 'claude', enabled: true, permission: 'default' };
}

/** Make the next readCmateFile() wait for the returned `release`. */
function deferReadCmate(): { release: () => void } {
  let release!: () => void;
  vi.mocked(readCmateFile).mockImplementationOnce(
    () => new Promise((resolve) => { release = () => resolve(new Map([['Schedules', []]])); }) as ReturnType<typeof readCmateFile>
  );
  return { release: () => release() };
}

describe('syncSchedules vs stop (Issue #3735)', () => {
  let mtime = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__scheduleManagerStates = undefined;
    mtime += 1;
    vi.mocked(getAllWorktrees).mockReturnValue([WT] as unknown as ReturnType<typeof getAllWorktrees>);
    vi.mocked(getCmateMtime).mockImplementation(() => mtime);
    vi.mocked(parseSchedulesSection).mockReturnValue([entry('0 3 * * *')] as unknown as ReturnType<typeof parseSchedulesSection>);
    vi.mocked(batchUpsertSchedules).mockReturnValue(['sched-1']);
  });

  afterEach(() => {
    stopAllSchedules();
    globalThis.__scheduleManagerStates = undefined;
  });

  it('does not create a cron for a worktree stopped during the read', async () => {
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopScheduleForWorktree(WT.id);
    d.release();
    await sync;

    expect(getActiveSchedulesForWorktree(WT.id)).toEqual([]);
    expect(getActiveScheduleCount()).toBe(0);
  });

  it('does not create a cron after stopAllSchedules() during the read', async () => {
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopAllSchedules();
    d.release();
    await sync;

    expect(getActiveScheduleCount()).toBe(0);
  });

  it('does not swap the cron expression of an existing schedule after a stop', async () => {
    await syncSchedulesNow(); // creates sched-1 (read resolves to null mock => none yet)
    vi.mocked(readCmateFile).mockResolvedValue(new Map([['Schedules', []]]));
    mtime += 1;
    await syncSchedulesNow();
    expect(getActiveScheduleCount()).toBe(1);

    mtime += 1;
    vi.mocked(parseSchedulesSection).mockReturnValue([entry('30 4 * * *')] as unknown as ReturnType<typeof parseSchedulesSection>);
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopScheduleForWorktree(WT.id);
    d.release();
    await sync;

    expect(getActiveSchedulesForWorktree(WT.id)).toEqual([]);
  });

  it('negative: a sync after the stop creates the cron as usual (worktree)', async () => {
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopScheduleForWorktree(WT.id);
    d.release();
    await sync;
    expect(getActiveScheduleCount()).toBe(0);

    vi.mocked(readCmateFile).mockResolvedValue(new Map([['Schedules', []]]));
    await syncSchedulesNow();
    expect(getActiveSchedulesForWorktree(WT.id)).toHaveLength(1);
  });

  it('negative: a sync after stopAllSchedules() creates the cron as usual', async () => {
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopAllSchedules();
    d.release();
    await sync;
    expect(getActiveScheduleCount()).toBe(0);

    vi.mocked(readCmateFile).mockResolvedValue(new Map([['Schedules', []]]));
    await syncSchedulesNow();
    expect(getActiveScheduleCount()).toBe(1);
  });

  it('negative: stopping another worktree does not block this one', async () => {
    const d = deferReadCmate();
    const sync = syncSchedulesNow();
    stopScheduleForWorktree('some-other-worktree');
    d.release();
    await sync;

    expect(getActiveSchedulesForWorktree(WT.id)).toHaveLength(1);
  });
});
