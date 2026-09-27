/**
 * Issue #2865: Auto-Yes never answers a same-named tmux session another
 * CommandMate server created.
 *
 * Drives the real `detectAndRespondToPrompt` over a real permission dialog
 * fixture, with the real ownership check (`worktree-session-ownership` →
 * `tmux/session-ownership`) and only the tmux reads mocked, and asserts on
 * `sendPromptAnswer` — the keystroke the agent actually receives.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';

const LIVE_FIXTURES = path.resolve(__dirname, 'detection/fixtures');

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));

const hasSession = vi.fn(async (_name: string) => true);
const getSessionWorkingDirectory = vi.fn(async (_name: string): Promise<string | null> => null);
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: (name: string) => hasSession(name),
  getSessionWorkingDirectory: (name: string) => getSessionWorkingDirectory(name),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `mcbd-claude-${id}`, name: 'Claude' }),
    }),
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...(args as [])),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';

const WORKTREE_ID = 'wt-2865';
const WORKTREE_PATH = '/nonexistent-2865/repos/wt-2865';

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

const PERMISSION_DIALOG = stripBoxDrawing(
  stripAnsi(
    readFileSync(path.join(LIVE_FIXTURES, 'claude-live-1708', 'bash-approval-taskpanel.txt'), 'utf8')
  )
);

function skippedForeign(): boolean {
  return warn.mock.calls.some(([action]) => action === 'poller:auto-yes-skipped-foreign-session');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  resetForeignSessionWarningsForTesting();
  clearPolicySuppressions();
  upsertWorktree(db, {
    id: WORKTREE_ID,
    name: 'develop',
    branch: 'develop',
    path: WORKTREE_PATH,
    repositoryPath: '/nonexistent-2865/repos',
    repositoryName: 'repos',
  });
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
});

describe('[#2865] Auto-Yes and a session another server created', () => {
  it('does not answer a session whose session_path is another directory', async () => {
    getSessionWorkingDirectory.mockResolvedValue('/nonexistent-2865/other-server/wt-2865');

    const result = await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PERMISSION_DIALOG);

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(skippedForeign()).toBe(true);
    expect(getSessionWorkingDirectory).toHaveBeenCalledWith('mcbd-claude-wt-2865');
  });

  it('does not answer when the session_path cannot be read (fail safe)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(null);

    const result = await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PERMISSION_DIALOG);

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('does not answer for a worktree this server has no row for', async () => {
    getSessionWorkingDirectory.mockResolvedValue(WORKTREE_PATH);

    const result = await detectAndRespondToPrompt('wt-unknown', pollerState(), 'claude', PERMISSION_DIALOG);

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('still answers its own session (control)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(`${WORKTREE_PATH}/`);

    const result = await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PERMISSION_DIALOG);

    expect(result).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
    expect(skippedForeign()).toBe(false);
  });
});
