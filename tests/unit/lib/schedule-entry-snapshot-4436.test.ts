/**
 * Issue #4436 I1a: a Schedule tick runs the entry the tool policy judged.
 *
 * The tick judges `state.entry` and then awaits (role resolution) before it
 * launches. A CMATE.md sync landing in that await replaces `state.entry`; the
 * launch must not pick the replacement up, or an antigravity row written while
 * a claude tick was waiting is launched unjudged. The replacement is judged on
 * the next tick instead (refused and recorded without a declaration).
 *
 * The real `executeSchedule` runs; role resolution is held open by a deferred
 * and the executor is a spy (no child, no `agy`, no credential read — I8).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Module from 'module';
import { TOOL_POLICY_DENIED, USAGE_DECLARATION_ENV } from '@/lib/tool-policy/policy';
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

vi.mock('@/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/claude-executor')>();
  return {
    ...actual,
    executeClaudeCommand: vi.fn(async () => ({ output: 'ok', exitCode: 0, status: 'completed' as const })),
  };
});

/** Role resolution held open until the test releases it. */
const roleGate = vi.hoisted(() => ({
  release: null as null | (() => void),
  hold: true,
}));
vi.mock('@/lib/session/role-launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/role-launch')>();
  return {
    ...actual,
    resolveScheduleRole: vi.fn(
      () =>
        new Promise((resolve) => {
          const done = (): void => resolve({ kind: 'none' });
          if (roleGate.hold) roleGate.release = done;
          else done();
        })
    ),
  };
});

const SCHEMA = `
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, vibe_local_model TEXT, updated_at INTEGER);
  CREATE TABLE scheduled_executions (
    id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, cli_tool_id TEXT DEFAULT 'claude', name TEXT NOT NULL,
    message TEXT NOT NULL, cron_expression TEXT, enabled INTEGER DEFAULT 1, last_executed_at INTEGER,
    next_execute_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE execution_logs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, worktree_id TEXT NOT NULL, message TEXT NOT NULL,
    result TEXT, exit_code INTEGER,
    status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'timeout', 'cancelled')),
    started_at INTEGER NOT NULL, completed_at INTEGER, created_at INTEGER NOT NULL
  );
`;

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { executeClaudeCommand } from '@/lib/session/claude-executor';
import { resolveScheduleRole } from '@/lib/session/role-launch';
import { runScheduledExecution } from '@/lib/schedule-manager';

const WT = 'wt-4436-i1a';
const SCHEDULE_ID = 'sched-4436-i1a';

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    name: 'nightly',
    cronExpression: '* * * * *',
    message: 'review the diff',
    cliToolId: 'claude',
    enabled: true,
    permission: 'default',
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

const launchedTools = (): string[] => vi.mocked(executeClaudeCommand).mock.calls.map((c) => String(c[2]));
const roleTools = (): string[] =>
  vi.mocked(resolveScheduleRole).mock.calls.map((c) => String((c[1] as { cliToolId: string }).cliToolId));
const refusalRows = (): Array<{ result: string }> =>
  db
    .prepare("SELECT result FROM execution_logs WHERE schedule_id = ? AND status = 'failed'")
    .all(SCHEDULE_ID) as Array<{ result: string }>;

/** Run one tick and, while its role resolution is pending, let a sync replace the entry. */
async function tickWithSyncDuringAwait(state: ScheduleState, replacement: ScheduleEntry): Promise<void> {
  roleGate.hold = true;
  roleGate.release = null;
  const run = runScheduledExecution(state);
  await vi.waitFor(() => expect(roleGate.release).not.toBeNull());
  // What the sync loop does with a changed CMATE.md row (synchronously).
  state.entry = replacement;
  roleGate.release!();
  await run;
}

async function plainTick(state: ScheduleState): Promise<void> {
  roleGate.hold = false;
  await runScheduledExecution(state);
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
  db.exec(SCHEMA);
  db.prepare('INSERT INTO worktrees (id, name, path) VALUES (?, ?, ?)').run(WT, WT, '/tmp/wt-4436-i1a-not-a-real-path');
  db.prepare(
    "INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, created_at, updated_at) VALUES (?, ?, 'nightly', 'review the diff', '* * * * *', 'claude', 0, 0)"
  ).run(SCHEDULE_ID, WT);
  // job-executor and schedule-manager reach the DB through a lazy CJS require.
  M._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('db-instance')) return { getDbInstance: () => db };
    return originalLoad.call(Module, request, parent, isMain);
  };
  declare(undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  M._load = originalLoad;
  declare(savedDeclaration);
  db.close();
});

describe('Issue #4436 I1a: the Schedule launches the entry the policy judged', () => {
  it('4436 I1a: claude judged, entry switched to antigravity during role resolution → agy launched 0 times, refused and recorded on the next tick (no declaration)', async () => {
    const state = stateOf(entry());
    await tickWithSyncDuringAwait(state, entry({ cliToolId: 'antigravity', message: 'switched' }));

    // The tick judged claude and launched claude, with claude's message.
    expect(launchedTools()).toEqual(['claude']);
    expect(roleTools()).toEqual(['claude']);
    expect(vi.mocked(executeClaudeCommand).mock.calls[0][0]).toBe('review the diff');
    expect(refusalRows()).toEqual([]);

    // The replacement is judged on its own tick: refused, recorded, nothing launched.
    await plainTick(state);
    expect(launchedTools()).toEqual(['claude']);
    expect(launchedTools()).not.toContain('antigravity');
    expect(refusalRows()).toHaveLength(1);
    expect(refusalRows()[0].result.startsWith(`${TOOL_POLICY_DENIED} (`)).toBe(true);
  });

  it('4436 I1a (control): with CM_ANTIGRAVITY_USAGE=api-key the switched antigravity entry runs from the next tick, nothing refused', async () => {
    declare('api-key');
    const state = stateOf(entry());
    await tickWithSyncDuringAwait(state, entry({ cliToolId: 'antigravity' }));
    await plainTick(state);

    expect(launchedTools()).toEqual(['claude', 'antigravity']);
    expect(roleTools()).toEqual(['claude', 'antigravity']);
    expect(refusalRows()).toEqual([]);
  });

  it('4436 I1a (control): another tool switched in (codex) is unchanged — the next tick runs it, nothing refused', async () => {
    const state = stateOf(entry());
    await tickWithSyncDuringAwait(state, entry({ cliToolId: 'codex' }));
    await plainTick(state);

    expect(launchedTools()).toEqual(['claude', 'codex']);
    expect(refusalRows()).toEqual([]);
  });

  it('4436 I1a (control): an unchanged entry launches as before', async () => {
    const state = stateOf(entry());
    await plainTick(state);
    expect(launchedTools()).toEqual(['claude']);
    expect(state.isExecuting).toBe(false);
  });
});
