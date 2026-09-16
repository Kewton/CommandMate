/**
 * `GET /api/worktrees/:id/execution-logs` carries the blocked-tool-call warning
 * (Issue #2577).
 *
 * Placed under `tests/unit/session/` next to the executor test because what it
 * pins is the round trip of `claude-executor`'s warning line: written at the
 * head of `execution_logs.result`, read back by the list route without handing
 * the transcript to the list.
 *
 * The rows are written the way `job-executor` writes them —
 * `updateExecutionLog(logId, result.status, result.output, result.exitCode)` —
 * from a real `executeClaudeCommand` result over the 1.53.1 all-blocked fixture,
 * so the test fails if the writer and the reader drift apart.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { ChildProcess } from 'child_process';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { GET } from '@/app/api/worktrees/[id]/execution-logs/route';
import { executeClaudeCommand, type ExecutionResult } from '@/lib/session/claude-executor';

const mockedExecFile = vi.mocked(execFile);

const WORKTREE_ID = 'wt-logs-2577';
const SCHEDULE_ID = 'sch-logs-2577';
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/command-code-tool-hook-blocked-2577');

let db: Database.Database;

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** One command-code run through the real executor, exit 0. */
async function commandCodeRun(stdout: string): Promise<ExecutionResult> {
  mockedExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    callback(null, stdout, '');
    return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
  }) as unknown as typeof execFile);
  return executeClaudeCommand('run the report', '/tmp/wt', 'command-code');
}

/** Insert a finished row the way job-executor's create + update pair leaves it. */
function insertLog(id: string, createdAt: number, run: Pick<ExecutionResult, 'status' | 'output' | 'exitCode'>): void {
  db.prepare(`
    INSERT INTO execution_logs (id, schedule_id, worktree_id, message, result, exit_code, status, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, SCHEDULE_ID, WORKTREE_ID, 'run the report', run.output, run.exitCode, run.status, createdAt, createdAt + 1000, createdAt);
}

async function listLogs(): Promise<Array<Record<string, unknown>>> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/execution-logs`);
  const response = await GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
  expect(response.status).toBe(200);
  return (await response.json()).logs;
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'logs 2577',
    path: '/tmp/wt-logs-2577',
    repositoryPath: '/tmp/repo-2577',
    repositoryName: 'repo-2577',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
  const now = Date.now();
  db.prepare(`
    INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SCHEDULE_ID, WORKTREE_ID, 'githubInsights', 'run the report', '0 9 * * *', 'command-code', 1, now, now);
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('GET /api/worktrees/:id/execution-logs', () => {
  it('flags a completed run whose tool calls were blocked', async () => {
    const run = await commandCodeRun(fixture('all-blocked.jsonl'));
    expect(run.status).toBe('completed');
    insertLog('log-blocked', 2_000, run);

    const [log] = await listLogs();
    expect(log).toMatchObject({
      id: 'log-blocked',
      status: 'completed',
      exit_code: 0,
      schedule_name: 'githubInsights',
      warning: run.warning,
    });
    expect(log.warning).toMatch(/^Warning: command-code blocked 1 tool call\(s\)/);
  });

  it('gives every other row a null warning', async () => {
    insertLog('log-plain', 1_000, await commandCodeRun('{"type":"result","subtype":"success","finalText":"OK"}'));
    insertLog('log-legacy', 500, { status: 'failed', output: 'Error: Command failed\nCode: 1', exitCode: 1 });
    insertLog('log-null', 250, { status: 'failed', output: null as unknown as string, exitCode: null });

    const logs = await listLogs();
    expect(logs.map((log) => [log.id, log.warning])).toEqual([
      ['log-plain', null],
      ['log-legacy', null],
      ['log-null', null],
    ]);
  });

  it('still keeps the transcript out of the list', async () => {
    const run = await commandCodeRun(fixture('blocked-then-read.jsonl'));
    insertLog('log-worked', 3_000, run);

    const [log] = await listLogs();
    expect(log.warning).toBe(run.warning);
    expect(log).not.toHaveProperty('result');
    expect(log).not.toHaveProperty('result_head');
    expect(JSON.stringify(log)).not.toContain('report-208-lines');
  });
});
