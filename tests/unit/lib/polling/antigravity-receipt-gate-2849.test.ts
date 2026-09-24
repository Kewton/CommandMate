/**
 * Auto-Yes's entry answers an agy dialog only when agy asked CommandMate about a
 * tool call a moment before it (Issue #2849).
 *
 * #2845 / #2851 taught the screen side that a dialog QUOTED in agy's reply is not
 * an open one. This is the second, independent guard: agy asks `PreToolUse`
 * before it draws any approval dialog, so a dialog that is really on the pane
 * follows a request the hook route recorded, and a quotation follows none. The
 * reading is gated only for a caller that passes `receiptScope` — the caller
 * that ANSWERS the frame — and on BOTH exits `detectPromptOnCleanFrame` has for
 * agy: the tool's own reader, and the generic `detectPrompt` at the end.
 *
 * Frames are the ones `antigravity-quoted-dialog-autoyes.test.ts` (#2851) uses:
 * the real `dialog-*.txt` captures for an open dialog, and `idle-after-deny.txt`
 * with a real dialog's rows quoted above its composer for the quotation.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@/lib/logger` is pulled in transitively by `cli-patterns` while the hoisted
// vi.mock factory runs, so the mock is built inside vi.hoisted().
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// Module boundary mocks: the seams `response-checker` reaches for at import
// time. Nothing here is under test.
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  createMessage: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectAntigravityNumberedDialogPrompt } from '@/lib/detection/tools/antigravity/dialog';
import {
  ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import {
  detectPromptOnCleanFrame,
  detectPromptWithOptions,
  type AntigravityReceiptScope,
} from '@/lib/polling/response-checker';

const DIR_2364 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');

const FOOTER = /↑\/↓ Navigate/;
const WT = 'wt-2849';
const PRIMARY: AntigravityReceiptScope = { worktreeId: WT };

/** The rows a fixture holds, ANSI intact; the file's closing newline is not a row. */
function rowsOf(name: string): string[] {
  const rows = readFileSync(path.join(DIR_2364, name), 'utf8').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

const plain = (row: string): string => stripAnsi(row).trim();

/**
 * `idle-after-deny.txt` with rows of `source` quoted, two columns in, directly
 * above the input box — the construction `antigravity-quoted-dialog.test.ts`
 * (#2845) and `antigravity-quoted-dialog-autoyes.test.ts` (#2851) share.
 */
function quoteAboveComposer(source: string, from: RegExp, to: RegExp): string {
  const base = 'idle-after-deny.txt';
  const baseRows = rowsOf(base);
  const sourceRows = rowsOf(source);

  const first = sourceRows.findIndex(row => from.test(plain(row)));
  const last = sourceRows.findIndex((row, i) => i >= first && to.test(plain(row)));
  if (first < 0 || last < 0) throw new Error(`${source} no longer holds the rows ${from} … ${to}`);
  const quoted = sourceRows.slice(first, last + 1).map(row => (row === '' ? row : `  ${row}`));

  let composerAt = -1;
  baseRows.forEach((row, i) => {
    if (/^>$/.test(plain(row))) composerAt = i;
  });
  const topRuleAt = composerAt - 1;
  if (composerAt < 0 || !/^─{3,}$/.test(plain(baseRows[topRuleAt]))) {
    throw new Error(`${base} no longer ends in a rule / bare \`>\` / rule input box`);
  }

  const rows = [...baseRows.slice(0, topRuleAt), ...quoted, ...baseRows.slice(topRuleAt)];
  for (let excess = quoted.length; excess > 0; excess--) {
    if (rows[rows.length - 1] !== '') throw new Error(`${base} has no blank padding left to give up`);
    rows.pop();
  }
  return `${rows.join('\n')}\n`;
}

/** The frame exactly as the Auto-Yes poller's `captureAndCleanOutput` hands it over. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/** The entry the way `detectAndRespondToPrompt` reaches it, plus the receipt scope. */
const read = (raw: string, scope?: AntigravityReceiptScope) =>
  detectPromptOnCleanFrame(asPollerSees(raw), 'antigravity', undefined, raw, scope);

const capture = (name: string): string => readFileSync(path.join(DIR_2364, name), 'utf8');

/** A dialog agy's own reader reads: the first exit of the entry. */
const READER_DIALOGS = readdirSync(DIR_2364).filter(
  name => /^dialog-.*\.txt$/.test(name) && name !== 'dialog-feedback-category.txt',
);

/**
 * A dialog agy's reader declines and only the generic pass reads: the second exit.
 * (`/feedback` is a built-in command, not a tool call, so agy would never have
 * asked about it — it is here for the shape of its frame, which is the only real
 * capture that reaches the entry's tail as a prompt.)
 */
const GENERIC_PASS_DIALOG = 'dialog-feedback-category.txt';

const QUOTED_BASH = quoteAboveComposer('dialog-bash-oneline.txt', /^Do you want to proceed\?$/, FOOTER);

beforeEach(() => {
  resetAntigravityPermissionReceiptsForTests();
  mockLogger.debug.mockClear();
});

afterEach(() => {
  resetAntigravityPermissionReceiptsForTests();
});

describe('[#2849] the frames really reach the two exits', () => {
  it.each(READER_DIALOGS)('%s is read by agy\'s own reader', name => {
    expect(detectAntigravityNumberedDialogPrompt(asPollerSees(capture(name)))?.isPrompt).toBe(true);
  });

  it(`${GENERIC_PASS_DIALOG} is declined by agy's reader and read by the generic pass`, () => {
    const raw = capture(GENERIC_PASS_DIALOG);

    expect(detectAntigravityNumberedDialogPrompt(asPollerSees(raw))).toBeNull();
    expect(read(raw).isPrompt).toBe(true);
  });

  it('covers every dialog capture the directory holds', () => {
    expect([...READER_DIALOGS, GENERIC_PASS_DIALOG].sort()).toEqual(
      readdirSync(DIR_2364).filter(name => /^dialog-.*\.txt$/.test(name)).sort(),
    );
  });
});

describe.each([...READER_DIALOGS, GENERIC_PASS_DIALOG])('[#2849] %s', name => {
  const raw = capture(name);

  it('is a prompt with no scope, receipt or not: a caller that only shows the frame is not gated', () => {
    expect(read(raw).isPrompt).toBe(true);
    expect(read(raw).promptData?.type).toBe('multiple_choice');
  });

  it('is no prompt for a caller that answers it, when agy asked about no tool call', () => {
    const result = read(raw, PRIMARY);

    expect(result.isPrompt).toBe(false);
    expect(result.promptData).toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith('antigravity-dialog-no-recent-receipt', {
      worktreeId: WT,
      instanceId: 'antigravity',
    });
  });

  it('is a prompt when agy asked about a tool call a moment ago', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command');

    const result = read(raw, PRIMARY);

    expect(result.isPrompt).toBe(true);
    expect(result.promptData?.type).toBe('multiple_choice');
  });

  it('is no prompt when the only question was longer ago than the window', () => {
    recordAntigravityPermissionReceipt(
      WT,
      'antigravity',
      'antigravity',
      'run_command',
      Date.now() - ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS - 1_000,
    );

    expect(read(raw, PRIMARY).isPrompt).toBe(false);
  });

  it("is no prompt when the question was another instance's", () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-2', 'run_command');

    expect(read(raw, PRIMARY).isPrompt).toBe(false);
    expect(read(raw, { worktreeId: WT, instanceId: 'antigravity-2' }).isPrompt).toBe(true);
  });

  it("is no prompt when the question was another worktree's", () => {
    recordAntigravityPermissionReceipt('wt-other', 'antigravity', 'antigravity', 'run_command');

    expect(read(raw, PRIMARY).isPrompt).toBe(false);
  });

  it('is still shown by the response poller, which passes no scope', () => {
    // Its stored `prompt` row and the notification are for a human to answer, and
    // must survive a machine whose hook never reached us.
    expect(detectPromptWithOptions(raw, 'antigravity').isPrompt).toBe(true);
  });
});

describe('[#2849] a dialog quoted in a reply', () => {
  it('is no prompt without a receipt (the screen guard alone)', () => {
    expect(read(QUOTED_BASH, PRIMARY).isPrompt).toBe(false);
    expect(read(QUOTED_BASH).isPrompt).toBe(false);
  });

  it('stays no prompt WITH a receipt: an unrelated tool call within the window does not vouch for it', () => {
    // The receipt gate is a second guard, never a way past the first.
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command');

    expect(read(QUOTED_BASH, PRIMARY).isPrompt).toBe(false);
    expect(read(QUOTED_BASH, PRIMARY).promptData).toBeUndefined();
  });
});

describe('[#2849] what is not gated', () => {
  it('a frame that is no prompt stays the same no-prompt reading, receipt or not', () => {
    const idle = capture('idle-after-deny.txt');

    expect(read(idle, PRIMARY)).toEqual(read(idle));
    expect(read(idle, PRIMARY).isPrompt).toBe(false);
    expect(mockLogger.debug.mock.calls.map(call => call[0])).not.toContain('antigravity-dialog-no-recent-receipt');
  });

  it('another tool is not judged by agy\'s receipts, scope or not', () => {
    const frame = 'Do you want to continue? (y/n)';

    const without = detectPromptOnCleanFrame(frame, 'claude');
    const withScope = detectPromptOnCleanFrame(frame, 'claude', undefined, undefined, PRIMARY);

    expect(without.isPrompt).toBe(true);
    expect(withScope).toEqual(without);
  });
});
