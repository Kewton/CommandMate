/**
 * Issue #3881 (the second half, finding 8): agy's hook receipt is not, on its
 * own, evidence that a numbered list on the screen is a permission dialog.
 *
 * Before this, a reply's plain `1. … N.` list (no `>` cursor, no permission
 * heading, no `↑/↓` footer — #1928's legacy reading, which #3818 left to the
 * generic parser) was answered whenever agy's `PreToolUse` hook had recorded a
 * tool call a moment earlier: the receipt gate (#2849) let it through and the
 * generic parser typed `1`. The receipt says a tool call happened; it does not
 * say this list is that call's approval UI.
 *
 * The paired fixture (`tests/fixtures/antigravity-receipt-pair-3881/`): the
 * live agy 1.1.27 Bash approval, and the same capture with agy's reply — the
 * tool's output and a numbered question — in place of the panel. Both are read
 * with the same receipt in hand.
 *
 * Positive control (fails on the implementation before this change): the
 * reply list with a receipt gets no key on the answering entry and the real
 * poller. Negative controls: the live approval with the same receipt is
 * answered `1`; `/feedback` keeps its generic reading; a list whose rows read
 * as agy's permission wording keeps it; and without a receipt scope (a caller
 * that only shows the frame) the reply list reads as it did.
 *
 * #1928's acceptance criterion is "返答本文の番号リスト … で Auto-Yes が撃たない
 * ことを pin" — this is that, for agy; the one #1928 test that pinned the
 * opposite on agy is updated in `auto-yes-unclassified-frame-1928.test.ts`.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/lib/tmux/tmux', () => ({ sendSpecialKeys: vi.fn(async () => {}) }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => ''),
  captureSessionOutputFresh: vi.fn(async () => ''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Antigravity',
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? 'antigravity'}`,
      }),
    }),
  },
}));
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

import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import {
  isAntigravityFeedbackMenuScreen,
  isAntigravityUnansweredNumberedScreen,
  readAntigravityNumberedDialog,
} from '@/lib/detection/tools/antigravity/dialog';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { isAntigravityGenericReadingOnScreen } from '@/lib/polling/response-checker-dialog-gate';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WT = 'wt-3881-agy';
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** The pair: the live approval, and the same capture with a reply's list in the panel's place. */
const PERMISSION = read('antigravity-receipt-pair-3881/permission-dialog.txt');
const REPLY_LIST = read('antigravity-receipt-pair-3881/reply-list.txt');
/** agy 1.1.27's `/feedback` menu, the one generic reading #2364 left in place. */
const FEEDBACK = read('antigravity-live-2364/dialog-feedback-category.txt');

const SCOPE = { worktreeId: WT, instanceId: 'antigravity' };
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

let tmp: string;

/** The reply list with its rows replaced, written to the temp dir and read back. */
function replyVariant(name: string, rows: ReadonlyArray<[string, string]>): string {
  let text = REPLY_LIST;
  for (const [from, to] of rows) {
    expect(text.includes(from), `the reply holds ${from}`).toBe(true);
    text = text.replace(from, to);
  }
  const file = path.join(tmp, `${name}.txt`);
  writeFileSync(file, text);
  return readFileSync(file, 'utf8');
}

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

function receipt(): void {
  recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command');
}

/** Drive the real poller over one frame, with agy's hook receipt in hand. */
async function autoYes(raw: string): Promise<string> {
  receipt();
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(WT, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity', raw);
}

/** The answering entry, with the receipt in hand. */
function answeringReading(raw: string) {
  receipt();
  const clean = asPollerSees(raw);
  return detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw, SCOPE);
}

const sent = (): string[] => sendPromptAnswer.mock.calls.map(([p]) => p.answer);

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cm-3881-agy-'));
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  db.close();
});

describe('[#3881] the paired fixture: what each half carries', () => {
  it('the two captures share everything above the panel', () => {
    const permission = PERMISSION.split('\n');
    const reply = REPLY_LIST.split('\n');
    expect(reply).toHaveLength(permission.length);
    expect(reply.slice(0, 24)).toEqual(permission.slice(0, 24));
  });

  it('agy\'s reader reads the approval and not the reply; the reply is #1928\'s shape', () => {
    expect(readAntigravityNumberedDialog(asPollerSees(PERMISSION).split('\n'))).not.toBeNull();
    const reply = asPollerSees(REPLY_LIST);
    expect(readAntigravityNumberedDialog(reply.split('\n'))).toBeNull();
    expect(isAntigravityUnansweredNumberedScreen(reply)).toBe(false);
    // The generic parser reads it as an answerable list — what used to be answered.
    const generic = detectPrompt(reply, buildDetectPromptOptions('antigravity'));
    expect(generic.promptData?.type).toBe('multiple_choice');
  });
});

describe('[#3881] a receipt alone does not vouch for a reply list (positive)', () => {
  it('the answering entry reads no prompt', () => {
    expect(answeringReading(REPLY_LIST).isPrompt).toBe(false);
    expect(isAntigravityGenericReadingOnScreen(asPollerSees(REPLY_LIST), detectPrompt(
      asPollerSees(REPLY_LIST),
      buildDetectPromptOptions('antigravity'),
    ))).toBe(false);
  });

  it('the real poller sends nothing', async () => {
    expect(await autoYes(REPLY_LIST)).toBe('no_prompt');
    expect(sent()).toEqual([]);
  });
});

describe('[#3881] what the screen does vouch for (negative)', () => {
  it('the live approval with the same receipt: read by agy\'s reader, answered `1`', async () => {
    expect(answeringReading(PERMISSION).isPrompt).toBe(true);
    expect(await autoYes(PERMISSION)).toBe('responded');
    expect(sent()).toEqual(['1']);
  });

  it('`/feedback` keeps its generic reading', () => {
    expect(isAntigravityFeedbackMenuScreen(asPollerSees(FEEDBACK))).toBe(true);
    expect(isAntigravityFeedbackMenuScreen(asPollerSees(REPLY_LIST))).toBe(false);
    expect(answeringReading(FEEDBACK).isPrompt).toBe(true);
  });

  it('a list whose rows read as agy\'s permission wording keeps the generic reading', () => {
    const known = replyVariant('known-rows', [
      ['1. Pin this version in .python-version', '1. Yes'],
      ['2. Upgrade to the latest release', '2. Yes, and always allow in this conversation'],
      ['3. Leave it as it is', '3. No'],
    ]);
    expect(answeringReading(known).isPrompt).toBe(true);
  });

  it('without a receipt scope (a caller that only shows the frame), the reply list reads as before', () => {
    const reply = asPollerSees(REPLY_LIST);
    expect(detectPromptOnCleanFrame(reply, 'antigravity', reply.split('\n'), REPLY_LIST)).toEqual(
      detectPrompt(reply, buildDetectPromptOptions('antigravity')),
    );
  });
});
