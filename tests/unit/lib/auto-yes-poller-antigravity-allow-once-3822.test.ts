/**
 * Issue #3822: past agy's receipt window, a permission dialog with no single
 * "allow this call once" row (`allow-once-unidentified`) is the base rules'
 * withholding, not the contract's. The receipt-log's withheld line must not
 * send the operator to the contract for it — with or without a contract —
 * while a contract's own verdict keeps its hint (the control).
 *
 * The frame is agy's live `Run this command?` capture
 * (`strict-respond-3812/permission-run-command.txt`) with its `1. Yes, run
 * command` row given the wording of its own row 2 (`Yes, and always allow in
 * this conversation …`), written to a temp dir and read back: every allow row
 * then saves a rule. Same harness as auto-yes-poller-antigravity-lookup-failed-3822.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Issue #2865: the poller answers only a session created in the worktree's own
// directory. Ownership itself is covered by tests/unit/tmux/session-ownership.test.ts.
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let taskLookupFailure: Error | null = null;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getActiveTaskForInstance: (...args: Parameters<typeof actual.getActiveTaskForInstance>) => {
      if (taskLookupFailure) throw taskLookupFailure;
      return actual.getActiveTaskForInstance(...args);
    },
  };
});

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
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';

const WORKTREE_ID = 'wt-3822-agy-once';
const T0 = new Date('2026-10-24T10:00:00.000Z').getTime();
const WITHHELD_BY_POLICY_LOG = 'antigravity-autoyes-withheld-by-policy';
const FIXTURES = path.resolve(__dirname, '../../fixtures');

const LIVE_DIALOG = readFileSync(path.join(FIXTURES, 'strict-respond-3812/permission-run-command.txt'), 'utf8');
const IDLE = readFileSync(path.join(FIXTURES, 'antigravity-live-2364/idle-after-deny.txt'), 'utf8');

let tmp: string | null = null;

/** The live dialog with row 1 worded as its row 2: no allow-once row is left. */
function dialogWithoutAllowOnce(): string {
  const once = '> 1. Yes, run command';
  const persistent = "> 1. Yes, and always allow in this conversation for commands that start with 'pwd'";
  expect(LIVE_DIALOG).toContain(once);
  tmp ??= mkdtempSync(path.join(os.tmpdir(), 'auto-yes-agy-allow-once-3822-'));
  const file = path.join(tmp, 'permission-run-command-no-allow-once.txt');
  writeFileSync(file, LIVE_DIALOG.replace(once, persistent));
  return readFileSync(file, 'utf8');
}

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

/** One poller tick at `T0 + ms` over `raw`. */
async function tickAt(ms: number, raw: string): Promise<string> {
  vi.setSystemTime(T0 + ms);
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity');
}

function receiptAt(ms: number): void {
  vi.setSystemTime(T0 + ms);
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity', 'run_command', Date.now());
}

const suppression = () => getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity');
const withheldByPolicyLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_BY_POLICY_LOG) as Array<[string, Record<string, unknown>]>;

function seedContract(autoYes: string): void {
  createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml',
    ),
    status: 'running',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  taskLookupFailure = null;
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
  clearAutoYesPolicyCache();
  db.close();
  if (tmp !== null) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('[#3822] past the receipt window, the base rules\' withholding is not sent to the contract', () => {
  it.each([
    ['no contract', ''],
    ["mode: 'off'", "autoYes:\n  mode: 'off'\n"],
  ])('%s: allow-once-unidentified is kept, and the hint names the dialog, not the contract', async (_label, autoYes) => {
    if (autoYes) seedContract(autoYes);
    const dialog = dialogWithoutAllowOnce();
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, dialog)).toBe('no_answer');
    expect(suppression()).toMatchObject({ reason: 'allow-once-unidentified' });
    for (const ms of [10_000, 15_000]) {
      expect(await tickAt(ms, dialog)).toBe('no_prompt');
      expect(suppression()).toMatchObject({ reason: 'allow-once-unidentified', at: T0 + ms });
    }
    const line = withheldByPolicyLines().at(-1)?.[1];
    expect(line).toMatchObject({ reason: 'allow-once-unidentified' });
    expect(line?.hint).toContain('今回だけ許可');
    expect(line?.hint).toContain('契約の判定ではない');
    expect(line?.hint).not.toContain('契約の autoYes を確認');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it("control: the live dialog under mode: 'off' keeps the contract's hint", async () => {
    seedContract("autoYes:\n  mode: 'off'\n");
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, LIVE_DIALOG)).toBe('no_answer');
    expect(await tickAt(10_000, LIVE_DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'mode-off' });
    expect(withheldByPolicyLines().at(-1)?.[1].hint).toContain('契約の autoYes を確認');
  });
});
