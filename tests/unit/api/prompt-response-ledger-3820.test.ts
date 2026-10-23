/**
 * POST /api/worktrees/:id/prompt-response in the Auto-Yes confirmation ledger
 * (Issue #3820, design `docs/design/auto-yes-measurement-3820.md` §2.1・§2.5・
 * §2.6・§8.1, PR 2).
 *
 * The browser's Auto-Yes says so in the body (`origin: 'auto-yes-browser'`);
 * the ledger recorded it as basis `browser`, anything else as `human`. A failure
 * (`success: false`, a 500) is a `failed` send, never an answer, and the
 * ledger throwing changes neither the body nor the status.
 *
 * Issue #3821: the route refuses the browser's origin with 409 before the
 * session is touched, so it is not recorded at all any more; the failure
 * cases below are a person's answer (no origin).
 *
 * Mocks as in `prompt-response-verification.test.ts`: tmux and the capture are
 * absent, the rest is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);

const { ledgerLog, ledgerLoggerFault } = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return { ledgerLog: logger, ledgerLoggerFault: { current: false } };
});
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === 'auto-yes-confirmation-ledger'
        ? {
            ...ledgerLog,
            info: (...args: unknown[]) => {
              if (ledgerLoggerFault.current) throw new Error('ledger logger down');
              return ledgerLog.info(...args);
            },
          }
        : actual.createLogger(name),
  };
});

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/detection/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));
vi.mock('@/lib/detection/cli-patterns', () => ({
  stripAnsi: vi.fn((s: string) => s),
  stripBoxDrawing: vi.fn((s: string) => s),
  buildDetectPromptOptions: vi.fn().mockReturnValue({ requireDefaultIndicator: false }),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { sendKeys } from '@/lib/tmux/tmux';
import { AUTO_YES_BROWSER_ORIGIN } from '@/lib/prompt-response-body-builder';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WT = 'test-wt';

const lines = (event: string): Array<Record<string, unknown>> =>
  ledgerLog.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

async function post(body: Record<string, unknown>) {
  const response = await promptResponse(
    new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: WT }) }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Taken: the capture fails, so the route sends without re-verifying (#161 fallback). */
function arrangeTaken(): void {
  vi.mocked(captureSessionOutputFresh).mockRejectedValue(new Error('tmux capture failed'));
}

/** Refused: the prompt is gone by the re-verification (`success: false`). */
function arrangeGone(): void {
  vi.mocked(captureSessionOutputFresh).mockResolvedValue('⏺ Done.\n\n❯ ');
  vi.mocked(detectPrompt).mockReturnValue({ isPrompt: false, cleanContent: '⏺ Done.\n\n❯ ' });
}

/** A 500: the send itself throws. */
function arrangeSendThrows(): void {
  arrangeTaken();
  vi.mocked(sendKeys).mockRejectedValue(new Error('tmux down'));
}

let db: Database.Database;

beforeEach(async () => {
  vi.clearAllMocks();
  ledgerLoggerFault.current = false;
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  vi.mocked(sendKeys).mockResolvedValue(undefined);
  vi.mocked(captureSessionOutputFresh).mockResolvedValue('');
  vi.mocked(detectPrompt).mockReturnValue({ isPrompt: false, cleanContent: '' });
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'Test Worktree',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
});

describe('[#3820] who answered through /prompt-response', () => {
  it('[#3821] refuses the browser Auto-Yes’s answer with 409, and records nothing', async () => {
    arrangeTaken();
    vi.mocked(sendKeys).mockClear();

    const { status, body } = await post({ answer: 'y', cliTool: 'claude', promptType: 'yes_no', origin: AUTO_YES_BROWSER_ORIGIN });

    expect(status).toBe(409);
    expect(body).toEqual(expect.objectContaining({ reason: 'browser-auto-yes-retired' }));
    expect(sendKeys).not.toHaveBeenCalled();
    expect(lines(EV.opened)).toHaveLength(0);
    expect(lines(EV.attemptSettled)).toHaveLength(0);
  });

  it('records an answer without the origin as a person’s', async () => {
    arrangeTaken();

    await post({ answer: 'y', cliTool: 'claude', promptType: 'yes_no' });

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'human', result: 'ok' })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ basis: 'human', resolvedBy: 'human-ui' })]);
  });

  it('reads any other origin as a person’s, and does not refuse it', async () => {
    arrangeTaken();

    const { status, body } = await post({ answer: 'y', cliTool: 'claude', origin: 'something-else' });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'human' })]);
  });

  it('counts success: false as a failed send, never as an answer', async () => {
    arrangeGone();

    const { body } = await post({ answer: '1', cliTool: 'claude' });

    expect(body).toEqual(expect.objectContaining({ success: false, reason: 'prompt_no_longer_active' }));
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'human', result: 'failed' })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ answeredAtClose: false, resolution: 'unresolved-after-send' })]);
  });

  it('counts a 500 as a failed send', async () => {
    arrangeSendThrows();

    const { status } = await post({ answer: 'y', cliTool: 'claude' });

    expect(status).toBe(500);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
  });

  it('records nothing for a request refused before the session (a 400)', async () => {
    await post({ cliTool: 'claude' });

    expect(lines(EV.opened)).toHaveLength(0);
  });
});

describe('[#3820] the ledger failing changes nothing the caller is told (design §8.1)', () => {
  async function responses() {
    arrangeTaken();
    const taken = await post({ answer: 'y', cliTool: 'claude' });
    arrangeGone();
    const gone = await post({ answer: '1', cliTool: 'claude' });
    arrangeSendThrows();
    const thrown = await post({ answer: 'y', cliTool: 'claude' });
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    return { taken, gone, thrown };
  }

  it('returns the same bodies and statuses when the ledger throws', async () => {
    const baseline = await responses();
    resetAutoYesConfirmationLedgerForTests();
    setAutoYesLedgerFaultForTests(new Error('ledger down'));

    expect(await responses()).toEqual(baseline);
    expect(baseline.taken.status).toBe(200);
    expect(baseline.thrown.status).toBe(500);
  });

  it('returns the same bodies and statuses when the ledger’s logger throws', async () => {
    const baseline = await responses();
    resetAutoYesConfirmationLedgerForTests();
    ledgerLoggerFault.current = true;

    expect(await responses()).toEqual(baseline);
  });
});
