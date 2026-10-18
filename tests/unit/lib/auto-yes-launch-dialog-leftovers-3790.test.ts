/**
 * Issue #3790: the rest of #3776's launch-dialog review.
 *
 * - The launch's key outlives its window: gemini's answered dialog stays drawn,
 *   cursor on `1. Trust folder`, until the restart line comes (~0.1–2 s), and a
 *   window that closed in between (the wait ran out on its last attempts) used
 *   to hand it to the poller as unanswered — `1` + Enter beside the launch's
 *   Enter. The poller now leaves it alone for `LAUNCH_DIALOG_PRESS_SETTLE_MS`
 *   after the launch's key, and answers it again after that (a key that did not
 *   land still has a backup).
 * - copilot's folder-trust dialog gets the same window: its launch confirms
 *   with a bare `1`, and the poller's `1` + Enter beside it was submitted as a
 *   user message (measured on 1.0.91).
 * - claude's folder-trust dialog (2.1.302, unnumbered) is not a prompt to the
 *   poller at all, so there is nothing to leave to the launch.
 *
 * Frames: `tests/fixtures/launch-dialog-live-3790/` (live) and
 * `tests/fixtures/copilot-folder-trust-1080.ts`.
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
      getTool: () => ({ getSessionName: (id: string) => `mcbd-agent-${id}`, name: 'Agent' }),
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
import {
  LAUNCH_DIALOG_PRESS_SETTLE_MS,
  beginLaunchWindow,
  clearLaunchWindows,
  endLaunchWindow,
  recordLaunchDialogPress,
} from '@/lib/cli-tools/launch-window';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

import { buildCopilotFolderTrustFrame } from '../../fixtures/copilot-folder-trust-1080';
import { COPILOT_FOLDER_TRUST_LAUNCH_DIALOG_ID } from '@/lib/polling/auto-yes-prompt-suppression';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-3790';
const LIVE = path.join(process.cwd(), 'tests/fixtures/launch-dialog-live-3790');
const GEMINI_3776 = path.join(process.cwd(), 'tests/fixtures/gemini-live-3776');

function pollerState(cliToolId: CLIToolType): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId,
    instanceId: cliToolId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

function tick(cliToolId: CLIToolType, raw: string): Promise<string> {
  return detectAndRespondToPrompt(
    WORKTREE_ID,
    pollerState(cliToolId),
    cliToolId,
    stripBoxDrawing(stripAnsi(raw)),
    undefined,
    undefined,
    raw,
  );
}

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf-8');
const session = (cliToolId: CLIToolType): string => resolveSessionName(cliToolId, WORKTREE_ID);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
  clearLaunchWindows();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  clearPolicySuppressions();
  clearLaunchWindows();
});

describe('[#3790] gemini: the launch\'s Enter is not answered again after its window closes', () => {
  const TRUST = (): string => read(LIVE, 'gemini-trust-dialog-0-64-0.txt');

  it('fixture: 0.64.0 draws the declared dialog, cursor on 1. Trust folder', async () => {
    expect(await tick('gemini', TRUST())).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('window closed, the launch pressed a moment ago: no answer (was `1` + Enter)', async () => {
    recordLaunchDialogPress(session('gemini'));
    expect(await tick('gemini', TRUST())).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'gemini')?.reason).toBe('agent-launch-dialog');
  });

  it('negative control: once the settle time has passed, a dialog still drawn is answered (the key did not land)', async () => {
    recordLaunchDialogPress(session('gemini'), Date.now() - LAUNCH_DIALOG_PRESS_SETTLE_MS - 1);
    expect(await tick('gemini', TRUST())).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('a new launch forgets the earlier launch\'s key', async () => {
    recordLaunchDialogPress(session('gemini'));
    beginLaunchWindow(session('gemini'));
    endLaunchWindow(session('gemini'));
    expect(await tick('gemini', TRUST())).toBe('responded');
  });

  it('negative control: the authentication picker after the restart is answered while the press settles', async () => {
    recordLaunchDialogPress(session('gemini'));
    expect(await tick('gemini', read(GEMINI_3776, 'after-enter-auth.txt'))).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('live: 100 ms after the poller\'s `1` the dialog reads as answered, so its next tick sends nothing', async () => {
    expect(await tick('gemini', read(LIVE, 'gemini-after-digit-1-100ms-0-64-0.txt'))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3790] copilot: the folder-trust dialog is the launch\'s while it answers it', () => {
  const TRUST = buildCopilotFolderTrustFrame();
  const onRemember = (raw: string): string =>
    raw
      .replace('❯ 1. Yes ', '  1. Yes ')
      .replace('  2. Yes, and remember', '❯ 2. Yes, and remember');

  it('in the launch window: no answer (was `1` + Enter beside the launch\'s `1`)', async () => {
    beginLaunchWindow(session('copilot'));
    expect(await tick('copilot', TRUST)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'copilot')?.reason).toBe('agent-launch-dialog');
    expect(warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-launch-dialog',
      expect.objectContaining({ dialog: COPILOT_FOLDER_TRUST_LAUNCH_DIALOG_ID }),
    );
  });

  it('window closed, the launch pressed a moment ago: no answer', async () => {
    recordLaunchDialogPress(session('copilot'));
    expect(await tick('copilot', TRUST)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative control: after the window, the session-only `1. Yes` is answered `1` (nobody else will)', async () => {
    expect(await tick('copilot', TRUST)).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('fixture: the cursor edit took', () => {
    expect(onRemember(TRUST)).toContain('❯ 2. Yes, and remember');
    expect(onRemember(TRUST)).not.toContain('❯ 1. Yes');
  });

  it('after the window, the cursor on `2. … remember this folder` is left alone (it writes ~/.copilot/config.json)', async () => {
    expect(await tick('copilot', onRemember(TRUST))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'copilot')?.reason).toBe('agent-launch-dialog');
  });

  it('negative: a reply quoting the question above a permission prompt is answered, even in the window', async () => {
    beginLaunchWindow(session('copilot'));
    const quoted = [
      '● It asks "Confirm folder trust" and "Do you trust the files in this folder?" on first start.',
      '',
      'Do you want to run this command?',
      '',
      '❯ 1. Yes',
      '  2. No, and tell Copilot what to do differently (Esc)',
    ].join('\n');
    await tick('copilot', quoted);
    expect(getLastPolicySuppression(WORKTREE_ID, 'copilot')?.reason).not.toBe('agent-launch-dialog');
  });
});

describe('[#3790] claude: the folder-trust dialog is not a prompt to the poller', () => {
  it('live 2.1.302 (unnumbered, cursor on No, exit): no prompt, nothing sent', async () => {
    expect(await tick('claude', read(LIVE, 'claude-trust-2-1-302.txt'))).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('live 2.1.302 with the cursor moved to Yes: no prompt either', async () => {
    const yes = read(LIVE, 'claude-trust-2-1-302.txt')
      .replace(' ❯ No, exit', '   No, exit')
      .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
    expect(yes).toContain(' ❯ Yes, I trust this folder');
    expect(await tick('claude', yes)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});
