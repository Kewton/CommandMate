/**
 * `GET /api/worktrees?include=review` for a session whose frame no rule could
 * read (Issue #2810, B2).
 *
 * Since #2775 such a session raises no activity flag, so the worktree-level
 * triple folds back to `ready`. For the review fields that turned a stalled
 * session's "Check stalled" into "Send message". The stall is an observation
 * of its own, so a stalled unreadable session is reported as stalled again;
 * an unreadable session that is NOT stalled is left as #2775 left it.
 *
 * Harness from `worktrees-status-split-2060.test.ts`: the status helper and the
 * stall detector are the only inputs varied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));

vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return { ...actual, getAllSessionNotes: () => ({}) };
});

vi.mock('@/lib/db', () => ({
  getWorktrees: vi.fn(() => [
    { id: 'wt-2810', name: 'fix/2810', status: 'doing', cliToolId: 'codex', selectedAgents: ['claude', 'codex'] },
  ]),
  getRepositories: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  markPendingPromptsAsAnswered: vi.fn(),
  getAgentInstances: vi.fn(() => []),
}));

const mocks = vi.hoisted(() => ({
  detectWorktreeSessionStatus: vi.fn(),
  isWorktreeStalled: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => [{ name: 'mcbd-codex-wt-2810' }]) }));

vi.mock('@/lib/session/worktree-status-helper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/worktree-status-helper')>();
  return { ...actual, detectWorktreeSessionStatus: mocks.detectWorktreeSessionStatus };
});

vi.mock('@/lib/session/agent-instances-resolver', () => ({
  resolveAgentInstances: vi.fn(() => []),
}));

vi.mock('@/lib/detection/stalled-detector', () => ({ isWorktreeStalled: mocks.isWorktreeStalled }));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';
import { NEXT_ACTION_KEYS } from '@/lib/session/next-action-helper';

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

const UNCLASSIFIED = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  ...BASE,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

const READY = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'input_prompt',
};

const WAITING = {
  ...BASE,
  isWaitingForResponse: true,
  isProcessing: false,
  waitingKind: 'prompt',
};

type Entry = { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };

/** The helper's shape: per-CLI entries plus their logical-OR triple. */
function status(sessionStatusByCli: Record<string, Entry>) {
  const entries = Object.values(sessionStatusByCli);
  return {
    sessionStatusByCli,
    sessionStatusByInstance: sessionStatusByCli,
    isSessionRunning: entries.some((e) => e.isRunning),
    isWaitingForResponse: entries.some((e) => e.isWaitingForResponse),
    isProcessing: entries.some((e) => e.isProcessing),
  };
}

async function reviewRow(
  sessionStatusByCli: Record<string, Entry>,
  stalled: boolean,
): Promise<Record<string, unknown>> {
  mocks.detectWorktreeSessionStatus.mockResolvedValue(status(sessionStatusByCli));
  mocks.isWorktreeStalled.mockReturnValue(stalled);
  const res = await GET(new NextRequest(new Request('http://localhost/api/worktrees?include=review')));
  const body = await res.json();
  return body.worktrees[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#2810] include=review for an unclassified session', () => {
  it('a stalled unclassified session is "Check stalled" / stalled, as before #2775', async () => {
    const row = await reviewRow({ codex: UNCLASSIFIED }, true);

    expect(row.isStalled).toBe(true);
    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.checkStalled);
    expect(row.reviewStatus).toBe('stalled');
    // The list's own status keys are untouched: nothing here calls it processing.
    expect(row.isProcessing).toBe(false);
    expect(mocks.isWorktreeStalled).toHaveBeenCalledWith('wt-2810', 'codex');
  });

  it('an unclassified session that is not stalled stays as #2775 left it', async () => {
    const row = await reviewRow({ codex: UNCLASSIFIED }, false);

    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.sendMessage);
    expect(row.reviewStatus).toBeNull();
  });

  it('a ready that was actually read is not made stalled by the stall timer alone', async () => {
    const row = await reviewRow({ codex: READY }, true);

    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.sendMessage);
    expect(row.reviewStatus).toBeNull();
  });

  it('reads the flag off the stalled tool only', async () => {
    // claude is unreadable, but the stall is measured on codex (`cliToolId`),
    // whose frame was read as ready.
    const row = await reviewRow({ claude: UNCLASSIFIED, codex: READY }, true);

    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.sendMessage);
    expect(row.reviewStatus).toBeNull();
  });

  it('a positive running that is stalled is unchanged', async () => {
    const row = await reviewRow({ codex: THINKING }, true);

    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.checkStalled);
    expect(row.reviewStatus).toBe('stalled');
  });

  it('a waiting read from another tool keeps the worktree-level verdict', async () => {
    const row = await reviewRow({ claude: WAITING, codex: UNCLASSIFIED }, true);

    expect(row.nextAction).toBe(NEXT_ACTION_KEYS.approveReject);
    expect(row.reviewStatus).toBe('approval');
  });
});
