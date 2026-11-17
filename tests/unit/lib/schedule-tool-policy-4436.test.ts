/**
 * Issue #4436: a Schedule (CMATE.md) is an unattended run, so under the default
 * usage declaration (`personal`) an antigravity schedule is refused before
 * anything is launched, and the refusal is recorded once per streak in
 * `execution_logs` (reason code + FAQ link) instead of once per tick.
 *
 * I1 refused (0 calls) · I2 declared → as before (1 call) · I3 other tools
 * unchanged · I5 sixty ticks of refusals keep one row · I6 removing the
 * declaration refuses from the next tick · I8 nothing is launched (the executor
 * is a spy; no `agy`, no credential read).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Module from 'module';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  TOOL_POLICY_DENIED,
  USAGE_DECLARATION_ENV,
} from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { ScheduleEntry } from '@/types/cmate';
import type { ScheduleState } from '@/lib/job-executor';

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

vi.mock('@/lib/cmate-parser', () => ({
  readCmateFile: vi.fn().mockResolvedValue(null),
  parseSchedulesSection: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/job-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/job-executor')>();
  return { ...actual, executeSchedule: vi.fn(() => Promise.resolve()), recoverRunningLogs: vi.fn() };
});

vi.mock('@/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/claude-executor')>();
  return { ...actual, executeClaudeCommand: vi.fn() };
});

vi.mock('@/lib/cron-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cron-parser')>();
  return {
    ...actual,
    getAllWorktrees: vi.fn().mockReturnValue([]),
    getCmateMtime: vi.fn().mockReturnValue(null),
    batchUpsertSchedules: vi.fn().mockReturnValue([]),
    disableStaleSchedules: vi.fn(),
  };
});

const SCHEMA = `
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, vibe_local_model TEXT, updated_at INTEGER);
  CREATE TABLE scheduled_executions (
    id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, cli_tool_id TEXT DEFAULT 'claude', name TEXT NOT NULL,
    message TEXT NOT NULL, cron_expression TEXT, enabled INTEGER DEFAULT 1, last_executed_at INTEGER,
    next_execute_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
  );
  CREATE TABLE execution_logs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, worktree_id TEXT NOT NULL, message TEXT NOT NULL,
    result TEXT, exit_code INTEGER,
    status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'timeout', 'cancelled')),
    started_at INTEGER NOT NULL, completed_at INTEGER, created_at INTEGER NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES scheduled_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
  );
`;

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { executeSchedule } from '@/lib/job-executor';
import { executeClaudeCommand } from '@/lib/session/claude-executor';
import { getAllWorktrees, getCmateMtime, batchUpsertSchedules } from '@/lib/cron-parser';
import { readCmateFile, parseSchedulesSection } from '@/lib/cmate-parser';
import { runScheduledExecution, stopAllSchedules, syncSchedulesNow } from '@/lib/schedule-manager';

const WT = 'wt-4436';
const WT_PATH = '/tmp/wt-4436-not-a-real-path';
const SCHEDULE_ID = 'sched-4436';
const EVERY_MINUTE = '* * * * *';

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    name: 'nightly',
    cronExpression: EVERY_MINUTE,
    message: 'review the diff',
    cliToolId: 'antigravity',
    enabled: true,
    permission: '--dangerously-skip-permissions',
    ...overrides,
  };
}

function stateOf(e: ScheduleEntry): ScheduleState {
  return {
    scheduleId: SCHEDULE_ID,
    worktreeId: WT,
    cronJob: { stop: vi.fn() } as unknown as ScheduleState['cronJob'],
    isExecuting: false,
    entry: e,
  };
}

interface LogRow {
  id: string;
  status: string;
  result: string | null;
  started_at: number;
  completed_at: number | null;
}
function logRows(): LogRow[] {
  return db
    .prepare('SELECT id, status, result, started_at, completed_at FROM execution_logs WHERE schedule_id = ? ORDER BY started_at, created_at')
    .all(SCHEDULE_ID) as LogRow[];
}

const savedDeclaration = process.env[USAGE_DECLARATION_ENV];
function declare(value: string | undefined): void {
  if (value === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = value;
}

type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const M = Module as unknown as ModuleWithLoad;
const originalLoad = M._load;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO worktrees (id, name, path) VALUES (?, ?, ?)').run(WT, WT, WT_PATH);
  db.prepare(
    'INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)'
  ).run(SCHEDULE_ID, WT, 'nightly', 'review the diff', EVERY_MINUTE, 'antigravity');
  // schedule-manager reaches the DB through a lazy CJS require, which vi.mock does
  // not intercept (the seam schedule-manager.test.ts uses for the same reason).
  M._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('db-instance')) return { getDbInstance: () => db };
    return originalLoad.call(Module, request, parent, isMain);
  };
  declare(undefined);
  vi.clearAllMocks();
  globalThis.__scheduleManagerStates = undefined;
});

afterEach(() => {
  try {
    stopAllSchedules();
  } catch {
    // nothing to stop
  }
  globalThis.__scheduleManagerStates = undefined;
  M._load = originalLoad;
  declare(savedDeclaration);
  vi.useRealTimers();
  db.close();
});

describe('Issue #4436: a Schedule tick goes through the tool policy before anything runs', () => {
  const DECLARATIONS: Array<[string, string | undefined, boolean]> = [
    ['unset (personal)', undefined, false],
    ['personal', 'personal', false],
    ['an unknown value', 'API-KEY', false],
    ['api-key', 'api-key', true],
    ['enterprise', 'enterprise', true],
  ];

  for (const tool of CLI_TOOL_IDS) {
    for (const [label, value, unlocks] of DECLARATIONS) {
      const runs = tool !== 'antigravity' || unlocks;
      it(`4436 I1/I2/I3: ${tool} with the declaration ${label} ${runs ? 'runs once' : 'is refused (0 runs)'}`, async () => {
        declare(value);
        const state = stateOf(entry({ cliToolId: tool }));

        await runScheduledExecution(state);

        expect(vi.mocked(executeSchedule)).toHaveBeenCalledTimes(runs ? 1 : 0);
        expect(vi.mocked(executeClaudeCommand)).not.toHaveBeenCalled();
        if (runs) {
          expect(vi.mocked(executeSchedule).mock.calls[0][0]).toBe(state);
          expect(logRows()).toEqual([]);
        } else {
          const rows = logRows();
          expect(rows).toHaveLength(1);
          expect(rows[0].status).toBe('failed');
          expect(rows[0].result).toContain(TOOL_POLICY_DENIED);
          expect(rows[0].result).toContain(ANTIGRAVITY_CONSUMER_TERMS);
          expect(rows[0].result).toContain(ANTIGRAVITY_FAQ_URL);
          expect(rows[0].result).toContain(USAGE_DECLARATION_ENV);
        }
      });
    }
  }

  it('4436 I1: a refusal does not touch last_executed_at nor the isExecuting guard', async () => {
    const state = stateOf(entry());
    await runScheduledExecution(state);
    const row = db.prepare('SELECT last_executed_at FROM scheduled_executions WHERE id = ?').get(SCHEDULE_ID) as {
      last_executed_at: number | null;
    };
    expect(row.last_executed_at).toBeNull();
    expect(state.isExecuting).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'execution:tool-policy-denied',
      expect.objectContaining({ code: TOOL_POLICY_DENIED, reason: ANTIGRAVITY_CONSUMER_TERMS, faq: ANTIGRAVITY_FAQ_URL })
    );
  });

  it('4436 I5: sixty refusals in a row keep one row, whose completed_at follows the latest refusal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 10, 17, 9, 0, 0).getTime();
    const state = stateOf(entry());
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(start + i * 60_000);
      await runScheduledExecution(state);
    }
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].started_at).toBe(start);
    expect(rows[0].completed_at).toBe(start + 59 * 60_000);
    expect(rows[0].result).toContain(ANTIGRAVITY_FAQ_URL);
    // One warning per streak, not one per minute.
    expect(mockLogger.warn.mock.calls.filter((c) => c[0] === 'execution:tool-policy-denied')).toHaveLength(1);
    expect(vi.mocked(executeSchedule)).not.toHaveBeenCalled();
  });

  it('4436 I5: a refusal after a real run starts a new row; the real run is never overwritten', async () => {
    db.prepare(
      "INSERT INTO execution_logs (id, schedule_id, worktree_id, message, result, status, started_at, completed_at, created_at) VALUES ('ran', ?, ?, 'm', 'the answer', 'completed', 1, 2, 1)"
    ).run(SCHEDULE_ID, WT);
    const state = stateOf(entry());
    await runScheduledExecution(state);
    await runScheduledExecution(state);
    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'ran', status: 'completed', result: 'the answer', completed_at: 2 });
    expect(rows[1].result).toContain(TOOL_POLICY_DENIED);
  });

  it('4436 I5: a failed run that is not a refusal is not reused for the refusal', async () => {
    db.prepare(
      "INSERT INTO execution_logs (id, schedule_id, worktree_id, message, result, status, started_at, completed_at, created_at) VALUES ('boom', ?, ?, 'm', 'Error: spawn agy ENOENT', 'failed', 1, 2, 1)"
    ).run(SCHEDULE_ID, WT);
    await runScheduledExecution(stateOf(entry()));
    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'boom', result: 'Error: spawn agy ENOENT' });
  });

  it('4436 I6: removing the declaration (a restart without it) refuses from the next tick', async () => {
    const state = stateOf(entry());
    declare('api-key');
    await runScheduledExecution(state);
    expect(vi.mocked(executeSchedule)).toHaveBeenCalledTimes(1);

    declare(undefined);
    await runScheduledExecution(state);
    expect(vi.mocked(executeSchedule)).toHaveBeenCalledTimes(1);
    expect(logRows()).toHaveLength(1);
  });

  it('4436 I1: a record that cannot be written is logged and still runs nothing', async () => {
    db.exec('DROP TABLE execution_logs');
    await expect(runScheduledExecution(stateOf(entry()))).resolves.toBeUndefined();
    expect(vi.mocked(executeSchedule)).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith('execution:tool-policy-record-failed', expect.any(Object));
  });
});

describe('Issue #4436: the cron timer itself goes through the gate (sixty real ticks)', () => {
  function cmateSays(entries: ScheduleEntry[]): void {
    vi.mocked(getAllWorktrees).mockReturnValue([{ id: WT, path: WT_PATH }]);
    vi.mocked(getCmateMtime).mockReturnValue(1);
    vi.mocked(readCmateFile).mockResolvedValue(new Map([['Schedules', [['row']]]]));
    vi.mocked(parseSchedulesSection).mockReturnValue(entries);
    vi.mocked(batchUpsertSchedules).mockReturnValue([SCHEDULE_ID]);
  }

  it('4436 I1/I5: an every-minute antigravity schedule fires sixty times, runs nothing and keeps one row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 30));
    cmateSays([entry()]);
    await syncSchedulesNow();
    expect(globalThis.__scheduleManagerStates?.schedules.has(SCHEDULE_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(vi.mocked(executeSchedule)).not.toHaveBeenCalled();
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].completed_at! - rows[0].started_at).toBe(59 * 60_000);
  });

  it('4436 I3: the same timer on claude runs every tick as before', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 30));
    cmateSays([entry({ cliToolId: 'claude', permission: 'acceptEdits' })]);
    await syncSchedulesNow();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(vi.mocked(executeSchedule)).toHaveBeenCalledTimes(5);
    expect(logRows()).toEqual([]);
  });

  it('4436 I2: with CM_ANTIGRAVITY_USAGE=enterprise the antigravity timer runs every tick as before', async () => {
    declare('enterprise');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 30));
    cmateSays([entry()]);
    await syncSchedulesNow();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(vi.mocked(executeSchedule)).toHaveBeenCalledTimes(5);
    expect(logRows()).toEqual([]);
  });
});
