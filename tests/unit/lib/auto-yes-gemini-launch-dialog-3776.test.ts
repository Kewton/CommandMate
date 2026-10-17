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
 * Review of #3776: the dialog is left to the launch only while the launch
 * window is open (`cli-tools/launch-window`); after it, the poller's default
 * goes through when the cursor is on `1. Trust folder` — the launch's Enter
 * did not land, or gemini drew the dialog late. And only the dialog itself
 * counts: a reply quoting the question is not it.
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
import { beginLaunchWindow, clearLaunchWindows } from '@/lib/cli-tools/launch-window';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

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
  return tickRaw(fs.readFileSync(path.join(LIVE, `${name}.txt`), 'utf-8'));
}

function tickRaw(raw: string): Promise<string> {
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

/** The launch is still in `waitForReady` for this worktree's gemini. */
function openLaunchWindow(): void {
  beginLaunchWindow(resolveSessionName('gemini', WORKTREE_ID));
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
  clearLaunchWindows();
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
  clearLaunchWindows();
});

describe('[#3776] the poller leaves gemini\'s folder-trust question to the launch', () => {
  it('sends nothing to the dialog with the cursor on 1. Trust folder (the launch sends the one Enter)', async () => {
    openLaunchWindow();
    expect(await tick('trust-dialog')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'gemini')?.reason).toBe('agent-launch-dialog');
    expect(warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-launch-dialog',
      expect.objectContaining({ dialog: 'gemini-folder-trust' }),
    );
  });

  it('sends nothing — in particular not `3` — with the cursor on Don\'t trust', async () => {
    openLaunchWindow();
    expect(await tick('trust-dialog-cursor-dont-trust')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('inside the window, a dismissed dialog above the restart line gets no keys either', async () => {
    openLaunchWindow();
    expect(await tick('after-enter-restarting')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('after the window, the cursor on 1. Trust folder is answered with the default `1` (nobody else will)', async () => {
    expect(await tick('trust-dialog')).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('after the window, a dismissed dialog above the restart line is still left alone', async () => {
    expect(await tick('after-enter-restarting')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative control: in the window, the authentication picker after the restart is answered', async () => {
    openLaunchWindow();
    expect(await tick('after-enter-auth')).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('in the window, an authentication picker drawn just under the dismissed dialog is answered', async () => {
    openLaunchWindow();
    // Synthetic: the restarting frame with a short picker under it, so the
    // dismissed dialog is still within the live rows.
    const picker = [
      '│ How would you like to authenticate for this project?     │',
      '│ ● 1. Sign in with Google                                  │',
      '│   2. Use Gemini API Key                                   │',
      '│   3. Vertex AI                                            │',
    ].join('\n');
    const raw = `${fs.readFileSync(path.join(LIVE, 'after-enter-restarting.txt'), 'utf-8').trimEnd()}\n${picker}\n`;
    expect(await tickRaw(raw)).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('after the window, the cursor on Don\'t trust is still left alone', async () => {
    expect(await tick('trust-dialog-cursor-dont-trust')).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'gemini')?.reason).toBe('agent-launch-dialog');
  });

  it('negative: a reply quoting the question above a permission prompt is not the dialog, even in the window', async () => {
    openLaunchWindow();
    const quoted = [
      '✦ The dialog asks "Do you trust this folder?" before gemini starts.',
      '╭──────────────────────────────────────╮',
      "│ Allow execution of: 'npm'?           │",
      '│                                      │',
      '│ ● 1. Allow once                      │',
      '│   2. Allow for this session          │',
      '│   3. No, suggest changes (esc)       │',
      '╰──────────────────────────────────────╯',
    ].join('\n');
    expect(await tickRaw(quoted)).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
    expect(getLastPolicySuppression(WORKTREE_ID, 'gemini')?.reason).not.toBe('agent-launch-dialog');
  });

  it('negative control: the authentication picker after the trust restart is answered as before', async () => {
    expect(await tick('after-enter-auth')).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });
});
