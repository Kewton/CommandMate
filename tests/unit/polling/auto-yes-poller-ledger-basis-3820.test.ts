/**
 * The evidence level the ledger records for an agy answer (Issue #3820, review
 * P2-3): a dialog agy's own reader read, let through on a hook receipt, is `L3`
 * with `receiptAccepted` — not the `L4` agy's `legacy` dialog gate
 * (`gated: false`) would give it.
 *
 * Drives the real `detectAndRespondToPrompt` over the live agy captures of
 * #2364, with a receipt recorded first, the way
 * `auto-yes-poller-antigravity-receipt-window-3767.test.ts` does.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
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
      getTool: (tool: string) => ({ getSessionName: (id: string) => `cm-${id}-${tool}`, name: tool }),
    }),
  },
}));

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
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-3820-basis';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-10-21T10:00:00.000Z').getTime();

const asPollerSees = (name: string): string =>
  stripBoxDrawing(stripAnsi(readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8')));

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

async function respond(cliToolId: CLIToolType, clean: string): Promise<string> {
  return detectAndRespondToPrompt(WORKTREE_ID, pollerState(cliToolId), cliToolId, clean, clean.split('\n'), cliToolId);
}

const settled = (): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls
    .filter(([name]) => name === EV.attemptSettled)
    .map(([, fields]) => fields as Record<string, unknown>);

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
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#3820] agy: read by its own reader and let through on a receipt is L3 (review P2-3)', () => {
  it.each(['dialog-bash-wrapped', 'dialog-bash-oneline', 'dialog-create-file'])(
    'records %s answered on a receipt as L3 with receiptAccepted',
    async (name) => {
      recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity', 'run_command', Date.now());
      vi.setSystemTime(T0 + 1_000);
      expect(await respond('antigravity', asPollerSees(name))).toBe('responded');

      expect(settled()).toEqual([
        expect.objectContaining({ cliToolId: 'antigravity', result: 'ok', basis: 'L3', receiptAccepted: true }),
      ]);
    },
  );

  it('keeps L4 for a yes/no prompt of another tool, which the dialog gate does not judge (negative control)', async () => {
    expect(await respond('codex', 'Do you want to proceed? (y/n)')).toBe('responded');

    expect(settled()).toEqual([expect.objectContaining({ result: 'ok', basis: 'L4' })]);
    expect(settled()[0]).not.toHaveProperty('receiptAccepted');
  });
});
