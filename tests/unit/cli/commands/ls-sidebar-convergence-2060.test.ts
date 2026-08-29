/**
 * `commandmate ls` and the sidebar must read one response the same way
 * (Issue #2060).
 *
 * The two surfaces derive their status word independently — `deriveStatus()` in
 * `src/cli/commands/ls.ts`, `toBranchItem()` / `aggregateCliStatus()` in
 * `src/types/sidebar.ts` — from fields that `GET /api/worktrees` composes in one
 * place. Splitting that composition into a list half and a status half (#2060)
 * is exactly the kind of change that can move one surface and not the other, so
 * this suite feeds BOTH of them the route's own output and pins that they agree.
 *
 * The rows here are produced by the real route handler, not hand-written: a
 * fixture would keep agreeing after the route stopped publishing the field one
 * of the two surfaces reads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  detectWorktreeSessionStatus: vi.fn(),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/tmux/tmux', () => ({ listSessions: mocks.listSessions }));
vi.mock('@/lib/session/worktree-status-helper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/worktree-status-helper')>();
  return { ...actual, detectWorktreeSessionStatus: mocks.detectWorktreeSessionStatus };
});
vi.mock('@/lib/session/agent-instances-resolver', () => ({
  resolveAgentInstances: vi.fn((_db: unknown, _id: string, selected?: string[]) =>
    (selected ?? ['claude']).map((cliTool) => ({ id: cliTool, cliTool, alias: null }))
  ),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

/** The four worktrees, one per status word the two surfaces can produce. */
const SEED = [
  { id: 'wt-waiting', name: 'fix/waiting', cliToolId: 'claude', selectedAgents: ['claude'] },
  { id: 'wt-running', name: 'feat/running', cliToolId: 'claude', selectedAgents: ['claude'] },
  { id: 'wt-ready', name: 'feat/ready', cliToolId: 'codex', selectedAgents: ['codex'] },
  { id: 'wt-idle', name: 'chore/idle', cliToolId: 'claude', selectedAgents: ['claude'] },
  // A worktree whose SECOND agent is the one waiting while the FIRST is still
  // processing. This is the row that makes the two surfaces' precedence
  // observable: the worktree-level flags carry `isWaitingForResponse` AND
  // `isProcessing` at once, so a surface that ranks processing above waiting
  // prints a different word from one that does not.
  { id: 'wt-alias', name: 'feat/alias', cliToolId: 'claude', selectedAgents: ['claude', 'codex'] },
];

vi.mock('@/lib/db', () => ({
  getWorktrees: vi.fn(() => SEED),
  getRepositories: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  markPendingPromptsAsAnswered: vi.fn(),
  getAgentInstances: vi.fn(() => []),
}));

function flags(isRunning: boolean, isWaitingForResponse: boolean, isProcessing: boolean) {
  return { isRunning, isWaitingForResponse, isProcessing, waitingKind: null, waitingSince: null, awaitingInstruction: false };
}

const WAITING = flags(true, true, false);
const RUNNING = flags(true, false, true);
const READY = flags(true, false, false);
const IDLE = flags(false, false, false);

function statusFor(worktreeId: string) {
  const byInstance: Record<string, ReturnType<typeof flags>> =
    worktreeId === 'wt-waiting' ? { claude: WAITING }
    : worktreeId === 'wt-running' ? { claude: RUNNING }
    : worktreeId === 'wt-ready' ? { codex: READY }
    : worktreeId === 'wt-alias' ? { claude: RUNNING, codex: WAITING }
    : { claude: IDLE };

  const merged = Object.values(byInstance).reduce(
    (acc, s) => ({
      isRunning: acc.isRunning || s.isRunning,
      isWaitingForResponse: acc.isWaitingForResponse || s.isWaitingForResponse,
      isProcessing: acc.isProcessing || s.isProcessing,
    }),
    { isRunning: false, isWaitingForResponse: false, isProcessing: false }
  );

  return {
    sessionStatusByCli: byInstance,
    sessionStatusByInstance: byInstance,
    isSessionRunning: merged.isRunning,
    isWaitingForResponse: merged.isWaitingForResponse,
    isProcessing: merged.isProcessing,
  };
}

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';
import { toBranchItem, aggregateCliStatus } from '@/types/sidebar';
import type { Worktree } from '@/types/models';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

/** The route's own rows for the given query. */
async function routeRows(query = ''): Promise<Record<string, unknown>[]> {
  const res = await GET(new NextRequest(new Request(`http://localhost/api/worktrees${query}`)));
  const body = await res.json();
  return body.worktrees;
}

/** Run `commandmate ls` against those rows and return its stdout. */
async function runLs(rows: unknown[], args: string[] = []): Promise<string> {
  mockConsoleLog.mockClear();
  mockFetchResponse({ worktrees: rows, repositories: [] });
  const { createLsCommand } = await import('@/cli/commands/ls');
  await createLsCommand().parseAsync(['node', 'ls', ...args]);
  return mockConsoleLog.mock.calls[0][0] as string;
}

/** The STATUS cell of the `ls` table, keyed by worktree id. */
function lsStatusById(table: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of table.split('\n').slice(2)) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length >= 3) out[cells[0]] = cells[2];
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.detectWorktreeSessionStatus.mockImplementation(async (worktreeId: string) => statusFor(worktreeId));
});

afterEach(() => {
  restoreFetch();
});

describe('[#2060] ls and the sidebar converge on the route response', () => {
  it('derives the same status word for every worktree', async () => {
    const rows = await routeRows();
    const fromLs = lsStatusById(await runLs(rows));

    for (const row of rows) {
      const item = toBranchItem(row as unknown as Worktree);
      expect(fromLs[row.id as string], `ls vs sidebar top-level for ${row.id}`).toBe(item.status);
    }

    // And the sample is not accidentally uniform.
    expect(new Set(Object.values(fromLs))).toEqual(new Set(['waiting', 'running', 'ready', 'idle']));
  });

  it('agrees when one agent is processing while another waits', async () => {
    const rows = await routeRows();
    const fromLs = lsStatusById(await runLs(rows));

    const alias = rows.find((r) => r.id === 'wt-alias')!;
    const item = toBranchItem(alias as unknown as Worktree);

    // `wt-alias`: claude processing, codex waiting — so both worktree-level
    // flags are true at once. Both surfaces must surface the codex wait: the
    // sidebar through its per-instance aggregate, `ls` through the ORed
    // worktree-level flags. Whichever one ranks processing first is wrong.
    expect(alias).toMatchObject({ isProcessing: true, isWaitingForResponse: true });
    expect(aggregateCliStatus(item.cliStatus)).toBe('waiting');
    expect(item.status).toBe('waiting');
    expect(fromLs['wt-alias']).toBe('waiting');
  });

  it('publishes to `ls --json` exactly the rows the route composed', async () => {
    // The CLI's `--json` contract is "the server's rows, verbatim". #2060 must
    // not have inserted a projection between the two.
    const rows = await routeRows();
    const json = JSON.parse(await runLs(rows, ['--json']));
    expect(json).toEqual(rows);
  });

  it('keeps every field the two surfaces read present on the default response', async () => {
    const rows = await routeRows();
    for (const row of rows) {
      // `ls` reads these; `toBranchItem` reads the same three plus the maps.
      expect(row).toHaveProperty('isSessionRunning');
      expect(row).toHaveProperty('isWaitingForResponse');
      expect(row).toHaveProperty('isProcessing');
      expect(row).toHaveProperty('sessionStatusByCli');
      expect(row).toHaveProperty('sessionStatusByInstance');
      expect(row).toHaveProperty('agentInstances');
    }
  });

  it('both fall back to idle — together — on a list-only response', async () => {
    // `?includeStatus=0` is opt-in and no shipped consumer sends it, but if one
    // ever does, the two surfaces must degrade the same way rather than one
    // showing `idle` and the other throwing.
    const rows = await routeRows('?includeStatus=0');
    const fromLs = lsStatusById(await runLs(rows));

    for (const row of rows) {
      const item = toBranchItem(row as unknown as Worktree);
      expect(item.status).toBe('idle');
      expect(fromLs[row.id as string]).toBe('idle');
    }
  });
});

afterEach(() => {
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});
