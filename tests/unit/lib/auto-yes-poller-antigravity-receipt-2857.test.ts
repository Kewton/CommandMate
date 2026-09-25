/**
 * Auto-Yes answers an agy dialog only when agy asked CommandMate about a tool
 * call a moment before it, and says so when it does not (Issue #2857).
 *
 * #2849 built the receipt gate into `detectPromptOnCleanFrame` and left it off:
 * it works only for a caller that passes `receiptScope`, and the Auto-Yes poller
 * — the one caller that ANSWERS a frame — did not. So a dialog agy had never
 * asked about (a reply quoting one, a menu the user opened themselves) was still
 * answered, and the gate was covered only by direct calls to the reader.
 *
 * ## Why this drives the poller and not the reader
 *
 * `antigravity-receipt-gate-2849.test.ts` already proves the reader withholds
 * with a scope and does not without one. What was missing is the WIRING, so the
 * assertions here are about `sendPromptAnswer` — the keystrokes the agent
 * actually receives — reached through the real `detectAndRespondToPrompt`, the
 * same shape as `auto-yes-poller-2368.test.ts`.
 *
 * The other half is the line the poller writes when it holds back: with the gate
 * on, a machine whose `~/.gemini/config/hooks.json` points at another server
 * (#2622) never gets a receipt, and every real dialog would otherwise wait for a
 * human with nothing in the log to say why.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The one logger every module gets, so the poller's `info` lines can be read.
// `withContext` is part of the logger contract and the detection layer uses it: a
// mock missing it throws inside the poller's catch and every assertion here would
// read `'error'` instead of the verdict under test.
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

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WORKTREE_ID = 'wt-2857';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-09-24T10:00:00.000Z').getTime();
const WITHHELD_LOG = 'antigravity-autoyes-withheld-no-hook-receipt';

const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/**
 * The frame exactly as `captureAndCleanOutput` hands it to
 * `detectAndRespondToPrompt`: ANSI and box drawing removed, nothing else.
 */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

function pollerState(instanceId = 'antigravity'): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** Drive the real poller over one fixture, the way `pollAutoYes` does. */
async function respondTo(
  name: string,
  instanceId = 'antigravity',
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const clean = asPollerSees(frame(name));
  return detectAndRespondToPrompt(
    WORKTREE_ID,
    pollerState(instanceId),
    'antigravity',
    clean,
    clean.split('\n'),
    instanceId,
  );
}

/** agy asked CommandMate about a tool call for this instance, right now. */
const receiptFor = (instanceId = 'antigravity'): void =>
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', instanceId, 'run_command', Date.now());

/** Every answer `sendPromptAnswer` was asked to type, in order. */
const answersSent = (): string[] => sendPromptAnswer.mock.calls.map(([p]) => p.answer);

/** The withheld-for-want-of-receipt lines written so far, as `[name, fields]`. */
const withheldLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_LOG) as Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  clearAllPollerStates();
  db.close();
});

describe('[#2857] Auto-Yes answers an agy dialog only after agy asked about a tool call', () => {
  it('leaves an approval dialog alone when no receipt was recorded', async () => {
    expect(await respondTo('dialog-bash-wrapped')).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('answers the same dialog as before when a receipt was recorded a moment ago', async () => {
    receiptFor();

    expect(await respondTo('dialog-bash-wrapped')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('stops answering once the receipt is older than the 8 second window', async () => {
    receiptFor();
    vi.setSystemTime(T0 + 8_000);
    expect(await respondTo('dialog-bash-wrapped')).toBe('responded');

    sendPromptAnswer.mockClear();
    vi.setSystemTime(T0 + 8_001);
    expect(await respondTo('dialog-bash-wrapped')).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('answers the file-creation dialog on the same terms', async () => {
    expect(await respondTo('dialog-create-file')).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();

    receiptFor();
    expect(await respondTo('dialog-create-file')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('leaves the `/feedback` category menu alone: it is no tool call, so no hook is ever asked', async () => {
    // A menu the user opened themselves. Nothing precedes it, so a receipt that
    // is not there is the right reading — not a hook that failed to reach us.
    expect(await respondTo('dialog-feedback-category')).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('reads the receipt of THIS instance: another instance of the tool does not open the gate', async () => {
    receiptFor('antigravity');

    expect(await respondTo('dialog-bash-wrapped', 'antigravity-2')).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();

    receiptFor('antigravity-2');
    expect(await respondTo('dialog-bash-wrapped', 'antigravity-2')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });
});

describe('[#2857] the info line for a dialog withheld for want of a receipt', () => {
  it('names the instance, the window and the file to check', async () => {
    await respondTo('dialog-bash-wrapped');

    expect(withheldLines()).toEqual([
      [
        WITHHELD_LOG,
        {
          worktreeId: WORKTREE_ID,
          instanceId: 'antigravity',
          windowMs: 8000,
          hint: expect.stringContaining('~/.gemini/config/hooks.json'),
        },
      ],
    ]);
    expect(withheldLines()[0][1].hint).toContain('#2622');
  });

  it('is written at most once per 60 seconds for one instance, however often the pane is read', async () => {
    await respondTo('dialog-bash-wrapped');
    expect(withheldLines()).toHaveLength(1);

    // The poller reads the same static pane every 2 seconds.
    for (const elapsed of [2_000, 4_000, 30_000, 59_999]) {
      vi.setSystemTime(T0 + elapsed);
      await respondTo('dialog-bash-wrapped');
    }
    expect(withheldLines()).toHaveLength(1);

    vi.setSystemTime(T0 + 60_000);
    await respondTo('dialog-bash-wrapped');
    expect(withheldLines()).toHaveLength(2);

    // The limit restarts from the line just written, not from the first one.
    vi.setSystemTime(T0 + 119_999);
    await respondTo('dialog-bash-wrapped');
    expect(withheldLines()).toHaveLength(2);

    vi.setSystemTime(T0 + 120_000);
    await respondTo('dialog-bash-wrapped');
    expect(withheldLines()).toHaveLength(3);
  });

  it('is limited per instance: a second instance is not silenced by the first', async () => {
    await respondTo('dialog-bash-wrapped', 'antigravity');
    await respondTo('dialog-bash-wrapped', 'antigravity-2');
    await respondTo('dialog-bash-wrapped', 'antigravity-2');

    expect(withheldLines().map(([, fields]) => fields.instanceId)).toEqual(['antigravity', 'antigravity-2']);
  });

  it('is not written when a receipt let the dialog through', async () => {
    receiptFor();

    expect(await respondTo('dialog-bash-wrapped')).toBe('responded');
    expect(withheldLines()).toHaveLength(0);
  });

  it('is not written for a pane with no dialog on it: nothing was withheld', async () => {
    expect(await respondTo('idle-after-deny')).toBe('no_prompt');
    expect(await respondTo('boot-idle')).toBe('no_prompt');

    expect(withheldLines()).toHaveLength(0);
  });

  it('is not written for a dialog only QUOTED in a reply: the screen reading declines it before any receipt is asked', async () => {
    // `idle-after-deny.txt` (a live composer) with a real dialog's rows quoted
    // two columns in above the input box, the way #2851's fixtures are built.
    const rows = frame('idle-after-deny').split('\n');
    const composerAt = rows.findIndex(row => /^>$/.test(stripAnsi(row).trim()));
    const dialog = frame('dialog-bash-oneline')
      .split('\n')
      .filter(row => row !== '')
      .map(row => `  ${row}`);
    const quoted = [...rows.slice(0, composerAt - 1), ...dialog, ...rows.slice(composerAt - 1)];
    const clean = asPollerSees(quoted.join('\n'));

    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'antigravity',
      clean,
      clean.split('\n'),
      'antigravity',
      quoted.join('\n'),
    );

    expect(result).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(withheldLines()).toHaveLength(0);
  });
});
