/**
 * `GET /api/worktrees`: a same-named session another CommandMate server created
 * is not "running" here (Issue #2865).
 *
 * The status detector reads session existence from the name set the route
 * hands it (#405's batch `listSessions`). The route now builds that set per
 * worktree from the sessions whose `#{session_path}` is the worktree's own
 * directory — the ownership filter is real here, and the detector stand-in
 * reports `isSessionRunning` from exactly the set it was given, as the real
 * one does (`sessionNameSet.has(sessionName)`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));

vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return { ...actual, getAllSessionNotes: () => ({}) };
});

const mockWorktrees = [
  { id: 'wt-own', name: 'own', path: '/nonexistent-2865/this-server/wt-own', status: 'doing', cliToolId: 'claude', selectedAgents: ['claude'] },
  { id: 'wt-shared', name: 'shared', path: '/nonexistent-2865/this-server/wt-shared', status: 'doing', cliToolId: 'claude', selectedAgents: ['claude'] },
];

vi.mock('@/lib/db', () => ({
  getWorktrees: vi.fn(() => mockWorktrees),
  getRepositories: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  markPendingPromptsAsAnswered: vi.fn(),
  getAgentInstances: vi.fn(() => []),
}));

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  detectWorktreeSessionStatus: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({ listSessions: mocks.listSessions }));

vi.mock('@/lib/session/worktree-status-helper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/worktree-status-helper')>();
  return { ...actual, detectWorktreeSessionStatus: mocks.detectWorktreeSessionStatus };
});

vi.mock('@/lib/session/agent-instances-resolver', () => ({
  resolveAgentInstances: vi.fn(() => [{ id: 'claude', cliTool: 'claude', alias: null }]),
}));

vi.mock('@/lib/detection/stalled-detector', () => ({ isWorktreeStalled: vi.fn(() => false) }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectWorktreeSessionStatus.mockImplementation(async (worktreeId: string, sessionNameSet: Set<string>) => ({
    sessionStatusByCli: {},
    sessionStatusByInstance: {},
    isSessionRunning: sessionNameSet.has(`mcbd-claude-${worktreeId}`),
    isWaitingForResponse: false,
    isProcessing: false,
  }));
});

async function running(): Promise<Record<string, boolean>> {
  const res = await GET(new NextRequest(new Request('http://localhost/api/worktrees')));
  const body = await res.json();
  return Object.fromEntries(
    (body.worktrees as Array<{ id: string; isSessionRunning: boolean }>).map((w) => [w.id, w.isSessionRunning])
  );
}

describe('[#2865] GET /api/worktrees and foreign sessions', () => {
  it('reports a session created in another directory as not running, and its own as running', async () => {
    mocks.listSessions.mockResolvedValue([
      { name: 'mcbd-claude-wt-own', windows: 1, attached: false, path: '/nonexistent-2865/this-server/wt-own/' },
      { name: 'mcbd-claude-wt-shared', windows: 1, attached: false, path: '/nonexistent-2865/other-server/wt-shared' },
    ]);

    expect(await running()).toEqual({ 'wt-own': true, 'wt-shared': false });
  });

  it('hands each worktree only the session names it owns', async () => {
    mocks.listSessions.mockResolvedValue([
      { name: 'mcbd-claude-wt-own', windows: 1, attached: false, path: '/nonexistent-2865/this-server/wt-own' },
      { name: 'mcbd-codex-wt-own', windows: 1, attached: false, path: '/nonexistent-2865/other-server/wt-own' },
      { name: 'mcbd-claude-wt-shared', windows: 1, attached: false, path: '' },
    ]);

    await running();

    const setFor = (id: string) =>
      [...(mocks.detectWorktreeSessionStatus.mock.calls.find(([wt]) => wt === id)![1] as Set<string>)].sort();
    expect(setFor('wt-own')).toEqual(['mcbd-claude-wt-own']);
    // An empty `#{session_path}` cannot be vouched for.
    expect(setFor('wt-shared')).toEqual([]);
  });
});
