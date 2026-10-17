/**
 * Issue #3776: the Auto-Yes poller leaves gemini's folder-trust question to
 * `GeminiTool.waitForReady`, as it leaves codex's launch dialogs (#1829).
 *
 * Measured on the v0.62.0 frames (`tests/fixtures/gemini-live-3776/`): the
 * generic parser reads the dialog as a multiple choice whose default is the
 * cursor row, so before #3776 the poller answered `1` beside the launch's own
 * Enter, and `3` (`Don't trust`) when the cursor was there. Driven through the
 * real `detectAndRespondToPrompt`, asserting on the keys the agent receives.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import fs from 'fs';
import path from 'path';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
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
      getTool: () => ({ getSessionName: (id: string) => `mcbd-gemini-${id}`, name: 'Gemini CLI' }),
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
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';

const WORKTREE_ID = 'wt-3776';
const LIVE = path.join(process.cwd(), 'tests/fixtures/gemini-live-3776');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'gemini',
    instanceId: 'gemini',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One poller tick over a measured frame, cleaned as `capturePollerFrame` cleans it. */
function tick(name: string): Promise<string> {
  const raw = fs.readFileSync(path.join(LIVE, `${name}.txt`), 'utf-8');
  return detectAndRespondToPrompt(
    WORKTREE_ID,
    pollerState(),
    'gemini',
    stripBoxDrawing(stripAnsi(raw)),
    undefined,
    undefined,
    raw,
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
});

describe('[#3776] the poller leaves gemini\'s folder-trust question to the launch', () => {
  it('sends nothing to the dialog with the cursor on 1. Trust folder (the launch sends the one Enter)', async () => {
    expect(await tick('trust-dialog')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'gemini')?.reason).toBe('agent-launch-dialog');
    expect(warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-launch-dialog',
      expect.objectContaining({ dialog: 'gemini-folder-trust' }),
    );
  });

  it('sends nothing — in particular not `3` — with the cursor on Don\'t trust', async () => {
    expect(await tick('trust-dialog-cursor-dont-trust')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative control: the authentication picker after the trust restart is answered as before', async () => {
    expect(await tick('after-enter-auth')).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });
});
