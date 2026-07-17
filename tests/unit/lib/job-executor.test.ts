/**
 * Issue #1343: executeSchedule() must always reset the in-memory isExecuting
 * guard, even when createExecutionLog() (a DB INSERT) throws. If the flag stays
 * true the schedule is skipped by the concurrency guard until the server
 * restarts, with no error surfaced to the user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'module';
import { executeSchedule, type ScheduleState } from '@/lib/job-executor';
import type { ScheduleEntry } from '@/types/cmate';

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

const mockExecuteClaudeCommand = vi.fn();
vi.mock('@/lib/session/claude-executor', () => ({
  executeClaudeCommand: (...args: unknown[]) => mockExecuteClaudeCommand(...args),
}));

/**
 * job-executor reaches the DB through a lazy CJS `require('./db/db-instance')`,
 * which vi.mock does not intercept (it is not resolvable as ESM under vitest).
 * Patching Module._load is the only way to substitute the DB here.
 */
type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const M = Module as unknown as ModuleWithLoad;
const originalLoad = M._load;

/** SQL -> statement stub. Any statement may be told to throw. */
let statements: Array<{ sql: string; run: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }>;
let failOnInsert: boolean;
let failOnUpdateLog: boolean;

function installDbStub(): void {
  M._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('db-instance')) {
      return {
        getDbInstance: () => ({
          prepare: (sql: string) => {
            const stmt = {
              sql,
              run: vi.fn(() => {
                if (failOnInsert && sql.includes('INSERT INTO execution_logs')) {
                  throw new Error('SQLITE_BUSY: database is locked');
                }
                if (failOnUpdateLog && sql.includes('UPDATE execution_logs SET status')) {
                  throw new Error('SQLITE_BUSY: database is locked');
                }
                return { changes: 1 };
              }),
              get: vi.fn(() => {
                if (sql.includes('FROM worktrees')) {
                  return { path: '/tmp/wt', vibe_local_model: null };
                }
                return undefined;
              }),
            };
            statements.push(stmt);
            return stmt;
          },
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function createState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  const entry: ScheduleEntry = {
    name: 'nightly-review',
    message: 'Review code',
    cronExpression: '0 3 * * *',
    cliToolId: 'claude',
    enabled: true,
  } as ScheduleEntry;

  return {
    scheduleId: 'sched-1',
    worktreeId: 'wt-1',
    cronJob: {} as ScheduleState['cronJob'],
    isExecuting: false,
    entry,
    ...overrides,
  };
}

describe('executeSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statements = [];
    failOnInsert = false;
    failOnUpdateLog = false;
    mockExecuteClaudeCommand.mockResolvedValue({ status: 'completed', output: 'ok', exitCode: 0 });
    installDbStub();
  });

  afterEach(() => {
    M._load = originalLoad;
  });

  it('resets isExecuting after a successful run', async () => {
    const state = createState();

    await executeSchedule(state);

    expect(state.isExecuting).toBe(false);
    expect(mockExecuteClaudeCommand).toHaveBeenCalledOnce();
  });

  it('skips execution while another run is in flight', async () => {
    const state = createState({ isExecuting: true });

    await executeSchedule(state);

    expect(mockExecuteClaudeCommand).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith('execution:skip-concurrent', { name: 'nightly-review' });
  });

  // Regression: the bug of Issue #1343.
  it('resets isExecuting when createExecutionLog throws', async () => {
    failOnInsert = true;
    const state = createState();

    await expect(executeSchedule(state)).resolves.toBeUndefined();

    expect(state.isExecuting).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'execution:failed',
      expect.objectContaining({ name: 'nightly-review' })
    );
  });

  // The failed INSERT produced no log row, so nothing may be updated afterwards.
  it('does not update an execution log that was never created', async () => {
    failOnInsert = true;

    await executeSchedule(createState());

    const updates = statements.filter((s) => s.sql.includes('UPDATE execution_logs SET status'));
    expect(updates).toHaveLength(0);
  });

  // A schedule must recover on the next cron tick rather than stay wedged.
  it('runs again on the next tick after a createExecutionLog failure', async () => {
    const state = createState();

    failOnInsert = true;
    await executeSchedule(state);
    expect(mockExecuteClaudeCommand).not.toHaveBeenCalled();

    failOnInsert = false;
    await executeSchedule(state);

    expect(mockExecuteClaudeCommand).toHaveBeenCalledOnce();
    expect(state.isExecuting).toBe(false);
  });

  it('resets isExecuting when the command execution rejects', async () => {
    mockExecuteClaudeCommand.mockRejectedValue(new Error('spawn failed'));
    const state = createState();

    await executeSchedule(state);

    expect(state.isExecuting).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'execution:failed',
      expect.objectContaining({ error: 'spawn failed' })
    );
  });

  // If even the error-path write fails, executeSchedule rejects. The guard must
  // still be released; schedule-manager attaches the .catch() for the rejection.
  it('resets isExecuting when the failure log write itself throws', async () => {
    mockExecuteClaudeCommand.mockRejectedValue(new Error('spawn failed'));
    failOnUpdateLog = true;
    const state = createState();

    await expect(executeSchedule(state)).rejects.toThrow('SQLITE_BUSY');

    expect(state.isExecuting).toBe(false);
  });
});
