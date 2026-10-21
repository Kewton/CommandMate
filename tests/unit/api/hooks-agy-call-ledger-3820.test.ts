/**
 * agy's call through the two hook routes (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §2.4・§2.6, PR 3):
 *
 *  - `POST /api/hooks/permission-request` reads `stepIdx` off agy's
 *    `PreToolUse` and records the call (`<conversationId>:<stepIdx>`) on the
 *    receipt and on the hook request's ledger line — the reply is unchanged;
 *  - `POST /api/hooks/agent-event` reads it off the relay's `post_tool_use`
 *    and ends the call: with no confirmation seen on screen, the request is
 *    marked `dialogUnobserved`;
 *  - a body without `stepIdx` (an older relay or agy) is accepted as before
 *    and records no call.
 *
 * Real SQLite and real Auto-Yes state, as in `hooks-permission-request-ledger-3820.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';

const { ledgerLog, quiet } = vi.hoisted(() => {
  const make = () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
    logger.withContext.mockReturnValue(logger);
    return logger;
  };
  return { ledgerLog: make(), quiet: make() };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn((name: string) => (name === 'auto-yes-confirmation-ledger' ? ledgerLog : quiet)),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

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

vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import {
  getAntigravityPermissionReceiptCallId,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WT = 'wt-agy-call-3820';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const PRE_TOOL_USE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/hooks/antigravity/pre-tool-use.json'), 'utf8')
) as Record<string, unknown>;

let db: Database.Database | null = null;

const lines = (event: string): Array<Record<string, unknown>> =>
  ledgerLog.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

const asReq = (req: Request) => req as unknown as NextRequest;

async function preToolUse(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/permission-request?tool=antigravity&worktreeId=${WT}&instanceId=antigravity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/** The body `scripts/hooks/cmate-agent-event.sh` posts for agy's `PostToolUse`. */
async function postToolUse(extra: Record<string, unknown>) {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const response = await POST(
    asReq(
      new Request('http://localhost/api/hooks/agent-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'antigravity',
          event: 'post_tool_use',
          worktreeId: WT,
          instanceId: 'antigravity',
          sessionId: CONVERSATION,
          detail: 'run_command',
          ...extra,
        }),
      })
    )
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  resetAntigravityPermissionReceiptsForTests();
  clearAgentStopEvents();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  upsertWorktree(db, { id: WT, name: 'feature/3820', path: WT_PATH, repositoryPath: WT_PATH, repositoryName: 'fixture' });
  setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
  clearAgentStopEvents();
  resetAntigravityPermissionReceiptsForTests();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
});

describe('[#3820 PR 3] the permission route reads agy’s stepIdx', () => {
  it('records the call on the receipt and the hook request, and replies as before', async () => {
    const { status, body } = await preToolUse(PRE_TOOL_USE);

    expect(status).toBe(200);
    expect(body).toEqual({ decision: 'allow' });
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', 'antigravity')).toBe(`${CONVERSATION}:16`);
    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ cliToolId: 'antigravity', outcome: 'allow', allowSuppressesDialog: false, callId: `${CONVERSATION}:16` }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
  });

  it.each([
    ['without stepIdx', (b: Record<string, unknown>) => (delete b.stepIdx, b)],
    ['with a string stepIdx', (b: Record<string, unknown>) => ({ ...b, stepIdx: '16' })],
  ])('records no call for a body %s, and replies the same (backward compatibility)', async (_label, edit) => {
    const { status, body } = await preToolUse(edit({ ...PRE_TOOL_USE }));

    expect(status).toBe(200);
    expect(body).toEqual({ decision: 'allow' });
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', 'antigravity')).toBeNull();
    expect(lines(EV.hookRequestClosed)).toHaveLength(1);
    expect(lines(EV.hookRequestClosed)[0]).not.toHaveProperty('callId');
  });
});

describe('[#3820 PR 3] the agent-event route ends the call', () => {
  it('marks the request dialogUnobserved when the PostToolUse comes and no dialog was seen', async () => {
    await preToolUse(PRE_TOOL_USE);
    const [request] = lines(EV.hookRequestClosed);

    const { status, body } = await postToolUse({ stepIdx: 16 });

    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
    expect(lines(EV.hookRequestDialogUnobserved)).toEqual([
      expect.objectContaining({ hookRequestId: request.hookRequestId, callId: `${CONVERSATION}:16`, dialogUnobserved: true }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
  });

  it('accepts the old body without stepIdx as before, and ends no call (backward compatibility)', async () => {
    await preToolUse(PRE_TOOL_USE);

    const { status, body } = await postToolUse({});

    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
  });

  it('ends only the call it names (another stepIdx writes nothing)', async () => {
    await preToolUse(PRE_TOOL_USE);

    await postToolUse({ stepIdx: 17 });

    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
  });

  it('answers the same when the ledger throws', async () => {
    await preToolUse(PRE_TOOL_USE);
    setAutoYesLedgerFaultForTests(new Error('ledger down'));

    const { status, body } = await postToolUse({ stepIdx: 16 });

    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
    setAutoYesLedgerFaultForTests(null);
  });
});
