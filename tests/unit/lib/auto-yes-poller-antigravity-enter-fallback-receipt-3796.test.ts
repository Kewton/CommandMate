/**
 * Issue #3796 review E, the Enter fallback's side: the Enter that comes back
 * whole marks only the agy episode it was sent for. A send that came back after
 * a stop → enable, when the successor had accepted a dialog on a newer
 * receipt, started that dialog's grace, and it was later reported as an answer
 * of ours that outlived it.
 *
 * The real `detectAndRespondToPrompt` and receipt state, one call per tick, as
 * in auto-yes-poller-antigravity-window-3796. The tool's dialog gate and the
 * Enter fallback's own screen judgement are stood in for (refused, eligible):
 * no live agy capture draws a screen they refuse, and they are not under test.
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

vi.mock('@/lib/prompt-answer-sender', () => ({ sendPromptAnswer: vi.fn(async () => {}) }));
const sendSpecialKeys = vi.fn(async (_session: string, _keys: string[]) => {});
vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKeys: (session: string, keys: string[]) => sendSpecialKeys(session, keys),
}));

let freshPane = '';
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  captureSessionOutputFresh: vi.fn(async () => freshPane),
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
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/polling/auto-yes-dialog-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return {
    ...actual,
    evaluateAutoYesDialogGate: () => ({ allowed: false, dialog: null, mode: 'enforce', gated: true }),
  };
});
vi.mock('@/lib/polling/auto-yes-enter-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-enter-fallback')>();
  return {
    ...actual,
    judgeEnterFallback: () => ({ eligible: true, refusalReason: 'unsupported_dialog_layout', composerState: 'no_composer' }),
  };
});

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
  startAutoYesPolling,
  stopAutoYesPolling,
  type AutoYesPollerState,
  type AutoYesTickGeneration,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS } from '@/lib/polling/antigravity-receipt-episodes';
import { buildCompositeKey, clearAllAutoYesStates, getAutoYesState, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { getEnterFallbackSessionEpoch } from '@/lib/polling/auto-yes-enter-fallback-state';

const WORKTREE_ID = 'wt-3796-enter';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-10-17T10:00:00.000Z').getTime();
const WITHHELD_LOG = 'antigravity-autoyes-withheld-no-hook-receipt';
const KEY = buildCompositeKey(WORKTREE_ID, 'antigravity', 'antigravity');
const IDLE = 'idle-after-deny';
const DIALOG = 'dialog-bash-wrapped';

const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));
const withheldLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_LOG) as Array<[string, Record<string, unknown>]>;

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

/** One tick at `T0 + ms` over the named fixture, on `state` (a fresh one by default). */
async function tickAt(
  ms: number,
  name: string,
  state: AutoYesPollerState = pollerState(),
  generation?: AutoYesTickGeneration,
): Promise<string> {
  vi.setSystemTime(T0 + ms);
  const raw = frame(name);
  freshPane = raw;
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'antigravity', clean, clean.split('\n'), 'antigravity', raw, generation);
}

function receiptAt(ms: number): void {
  vi.setSystemTime(T0 + ms);
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity', 'run_command', Date.now());
}

/**
 * The poller's two ticks over the dialog, at 5s (seen once) and 6s (the Enter,
 * whose await runs `during`). With `restart`, Auto-Yes is stopped and enabled
 * again inside that await.
 */
async function enterSentAt6s(restart: boolean, during: () => Promise<void>): Promise<string> {
  vi.setSystemTime(T0 + 5_000);
  setAutoYesEnabled(WORKTREE_ID, 'antigravity', true, undefined, undefined, 'antigravity');
  expect(startAutoYesPolling(WORKTREE_ID, 'antigravity', 'antigravity').started).toBe(true);
  const state = globalThis.__autoYesPollerStates!.get(KEY)!;
  const generation: AutoYesTickGeneration = {
    compositeKey: KEY,
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    pollerState: state,
    grant: getAutoYesState(WORKTREE_ID, 'antigravity', 'antigravity')!,
    sessionEpoch: getEnterFallbackSessionEpoch(KEY),
    startedAt: Date.now(),
  };
  try {
    expect(await tickAt(5_000, DIALOG, state, generation)).toBe('no_answer');
    sendSpecialKeys.mockImplementationOnce(async () => {
      if (restart) {
        stopAutoYesPolling(KEY);
        expect(startAutoYesPolling(WORKTREE_ID, 'antigravity', 'antigravity').started).toBe(true);
      }
      await during();
    });
    return await tickAt(6_000, DIALOG, state, generation);
  } finally {
    stopAutoYesPolling(KEY);
  }
}

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
  clearAllAutoYesStates();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  clearAllPollerStates();
  db.close();
});

describe('[#3796 review E] an Enter that comes back whole marks only the episode it was sent for', () => {
  it('negative: stop → enable during the Enter, the successor accepts a newer receipt, the old Enter comes back whole — that episode\'s answer time is left alone', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    await enterSentAt6s(true, async () => {
      expect(await tickAt(7_000, IDLE)).toBe('no_prompt');
      receiptAt(8_000);
      // Seen once by the successor (its Enter waits for a second look):
      // accepted on the 8s receipt, nothing sent.
      expect(await tickAt(10_000, DIALOG)).toBe('no_answer');
    });
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);

    for (const ms of [17_000, 22_000, 27_000, 32_000, 37_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    // Before the review fix the old Enter's return started this dialog's grace
    // at 10s, and from 28s it read as an answer of ours that outlived it.
    expect(withheldLines()).toHaveLength(0);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('positive: the same generation\'s Enter still starts its grace', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await enterSentAt6s(false, async () => {})).toBe('responded');
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    for (const ms of [11_000, 16_000, 21_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(withheldLines()).toHaveLength(0);
    expect(await tickAt(6_000 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(withheldLines()).toHaveLength(1);
    expect(withheldLines()[0][1].hint).toContain('画面に残っている');
  });
});
