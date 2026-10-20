/**
 * Auto-Yes does not answer agy's login-method screen (Issue #3808).
 *
 * agy 1.4's not-signed-in screen draws `Select login method:` over `> 1. Google
 * OAuth` / `2. Use a Google Cloud project` under a `↑/↓ Navigate · enter
 * Select` footer. It passes agy's structural numbered-dialog test, and before
 * this Issue agy's reader read it as a `multiple_choice` prompt — so the
 * Auto-Yes poller, which reads frames through the same reader
 * (`detectPromptOnCleanFrame`, #2368), could pick a login method by number.
 * #3797 fixed only the prompt observation's kind.
 *
 * Asserted through the real `detectAndRespondToPrompt`, as
 * `auto-yes-poller-2368.test.ts` asserts the positive side, and with a hook
 * receipt recorded first: the receipt gate (#2849) would withhold the frame
 * anyway, and what this suite is about is the READING, so the gate is opened.
 *
 * Positive control: the measured 1.1.27 permission dialog is still answered.
 * Negative: the measured login-method screen (`prompt-observation-3797/`, read,
 * not rewritten) and the permission dialog with its `tab Amend` footer cut or
 * spelled otherwise (`prompt-observation-3808/`, constructed).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: the poller answers only a session created in the worktree's own
// directory. Ownership itself is covered by tests/unit/tmux/session-ownership.test.ts.
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

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
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));

// `withContext` is part of the logger contract and the detection layer uses it.
// A mock missing a method the production path calls does not fail as
// "unmocked": it throws inside the poller's catch and every assertion here
// would read `'error'` instead of the verdict under test.
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { judgeEnterFallback } from '@/lib/polling/auto-yes-enter-fallback';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WORKTREE_ID = 'wt-3808';
const FIXTURES = path.resolve(__dirname, '../../fixtures');

const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** The frame exactly as `captureAndCleanOutput` hands it to `detectAndRespondToPrompt`. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

const answersSent = (): string[] => sendPromptAnswer.mock.calls.map(([p]) => p.answer);

/** Drive the real poller over one fixture, with agy's hook receipt in hand. */
async function respondTo(rel: string): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity', 'run_command');
  const raw = read(rel);
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity', raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  db.close();
});

describe('[#3808] the permission dialog is still answered (positive control)', () => {
  it('answers the highlighted `1` on the measured 1.1.27 Bash approval', async () => {
    expect(await respondTo('antigravity-live-2364/dialog-bash-oneline.txt')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });
});

describe('[#3808] numbered screens without the `tab Amend` footer get no answer', () => {
  it.each([
    ['the login-method screen (agy 1.4.2, measured)', 'prompt-observation-3797/antigravity-login-method.txt'],
    ['a permission dialog whose footer a narrow pane cut', 'prompt-observation-3808/antigravity-permission-footer-truncated.txt'],
    ['a permission dialog whose footer a narrow pane wrapped', 'prompt-observation-3808/antigravity-permission-footer-wrapped.txt'],
    ['a permission dialog under another version\'s footer', 'prompt-observation-3808/antigravity-permission-footer-other-version.txt'],
    ['a permission dialog whose footer is below the pane', 'prompt-observation-3808/antigravity-permission-footer-offscreen.txt'],
    ['a permission dialog whose footer is cut at `↑/↓ Nav`', 'prompt-observation-3808/antigravity-permission-footer-cut-at-nav.txt'],
    ['a cut-footer permission dialog whose option 2 quotes `1-6 Select`', 'prompt-observation-3808/antigravity-permission-footer-cut-feedback-words.txt'],
  ])('sends nothing on %s', async (_label, rel) => {
    expect(await respondTo(rel)).toBe('no_prompt');
    expect(answersSent()).toEqual([]);
    // Nor the #3397 Enter, which would confirm the highlighted row.
    expect(judgeEnterFallback('antigravity', read(rel), {} as NodeJS.ProcessEnv).eligible).toBe(false);
  });
});
