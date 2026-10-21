/**
 * POST /api/hooks/permission-request in the Auto-Yes confirmation ledger
 * (Issue #3820, design `docs/design/auto-yes-measurement-3820.md` §2.3・§3.4・§5・
 * §8.1, PR 2).
 *
 * Real SQLite and real Auto-Yes state, as in `hooks-permission-request.test.ts`.
 * The ledger's lines are read off its own logger; every other module's logger
 * is quiet. What is pinned:
 *
 *  - claude / codex / copilot: an allow is one hook request and one
 *    confirmation (`L1`, `resolved-by-reply`, `resolvedBy: 'auto'`), and the
 *    `chat_messages` row is written as before;
 *  - agy: an allow writes **no** `chat_messages` row (the intended change of
 *    design §5) and is a hook request only (`allowSuppressesDialog: false`);
 *  - an abstention is closed when it replies and holds no waiting time;
 *  - `permission_mode` is observed;
 *  - the ledger and its logger throwing change neither the body nor the status.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';

const { ledgerLog, quiet, ledgerLoggerFault } = vi.hoisted(() => {
  const make = () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
    logger.withContext.mockReturnValue(logger);
    return logger;
  };
  return { ledgerLog: make(), quiet: make(), ledgerLoggerFault: { current: false } };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn((name: string) => {
    if (name !== 'auto-yes-confirmation-ledger') return quiet;
    return {
      ...ledgerLog,
      info: (...args: unknown[]) => {
        if (ledgerLoggerFault.current) throw new Error('ledger logger down');
        return ledgerLog.info(...args);
      },
    };
  }),
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

/** The contract policy is a task lookup behind a TTL cache; drive it directly. */
const policyRef = vi.hoisted(() => ({ current: null as AutoYesPolicy | null }));
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => policyRef.current,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

/** The delivery, replaceable so the route's catch-all can be reached. */
const deliveryFault = vi.hoisted(() => ({ current: null as Error | null }));
vi.mock('@/lib/hooks/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources')>();
  return {
    ...actual,
    answerPendingDecision: (...args: Parameters<typeof actual.answerPendingDecision>) => {
      if (deliveryFault.current) throw deliveryFault.current;
      return actual.answerPendingDecision(...args);
    },
  };
});

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');
const WT = 'wt-ledger-3820';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

let db: Database.Database | null = null;

const lines = (event: string): Array<Record<string, unknown>> =>
  ledgerLog.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

function fixture(path: string): Record<string, unknown> {
  const base = JSON.parse(readFileSync(join(FIXTURES, path), 'utf8')) as Record<string, unknown>;
  return 'cwd' in base ? { ...base, cwd: WT_PATH } : base;
}

const PAYLOADS: Record<string, () => Record<string, unknown>> = {
  claude: () => ({ ...fixture('claude/permission-request.json'), tool_input: { command: 'echo hello' } }),
  codex: () => fixture('codex/permission-request.json'),
  copilot: () => fixture('copilot/pre-tool-use.json'),
  antigravity: () => ({
    ...fixture('antigravity/pre-tool-use.json'),
    toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } },
  }),
};

async function post(tool: CLIToolType, body: unknown = PAYLOADS[tool](), worktreeId = WT) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    new Request(`http://localhost/api/hooks/permission-request?tool=${tool}&worktreeId=${worktreeId}&instanceId=${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  ledgerLoggerFault.current = false;
  deliveryFault.current = null;
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  clearPolicySuppressions();
  policyRef.current = null;
  upsertWorktree(db, {
    id: WT,
    name: 'feature/3820',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
});

describe('[#3820] an allow on a tool whose allow draws no dialog', () => {
  it.each(['claude', 'codex', 'copilot'] as const)(
    '%s: one hook request, one confirmation answered by the reply, and the history row as before',
    async (tool) => {
      setAutoYesEnabled(WT, tool, true, ONE_HOUR_MS);

      await post(tool);

      const [request] = lines(EV.hookRequestClosed);
      expect(lines(EV.hookRequestClosed)).toHaveLength(1);
      expect(request).toEqual(expect.objectContaining({ cliToolId: tool, outcome: 'allow', allowSuppressesDialog: true }));
      expect(lines(EV.opened)).toEqual([
        expect.objectContaining({ source: 'hook', hookRequestId: request.hookRequestId, worktreeId: WT }),
      ]);
      expect(lines(EV.closed)).toEqual([
        expect.objectContaining({ basis: 'L1', resolution: 'resolved-by-reply', resolvedBy: 'auto', answeredAtClose: true }),
      ]);
      expect(getMessages(db!, WT)).toHaveLength(1);
      expect(getMessages(db!, WT)[0].promptData).toEqual(expect.objectContaining({ answeredBy: 'auto', status: 'answered' }));
    }
  );
});

describe('[#3820] an allow on agy (design §5)', () => {
  it('writes no history row: the dialog agy draws anyway is answered — and recorded — on the screen', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { body } = await post('antigravity');

    expect(body).toEqual({ decision: 'allow' });
    expect(getMessages(db!, WT)).toHaveLength(0);
  });

  it('is a hook request only, which says its allow did not answer a confirmation', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    await post('antigravity');

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ cliToolId: 'antigravity', outcome: 'allow', allowSuppressesDialog: false }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('tells the two apart in the decided log line as well', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    await post('antigravity');
    await post('claude');

    const decided = quiet.info.mock.calls.filter(([name]) => name === 'permission-request-decided').map(([, d]) => d);
    expect(decided).toEqual([
      expect.objectContaining({ tool: 'antigravity', allowSuppressesDialog: false }),
      expect.objectContaining({ tool: 'claude', allowSuppressesDialog: true }),
    ]);
  });
});

describe('[#3820] an abstention', () => {
  it.each([
    ['policy-suppressed', () => (policyRef.current = { mode: 'off', allowPromptTypes: [], denyPatterns: [] }), true],
    ['auto-yes-disabled', () => {}, false],
  ] as const)('%s: closed when it replies, with no waiting time and no confirmation', async (reason, arrange, enable) => {
    if (enable) setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    arrange();

    const { body } = await post('claude');

    expect(body).toEqual({});
    expect(lines(EV.hookRequestClosed)).toEqual([expect.objectContaining({ outcome: 'abstained', abstainReason: reason })]);
    expect(lines(EV.opened)).toHaveLength(0);
    expect(lines(EV.withholdStarted)).toHaveLength(0);
    expect(getMessages(db!, WT)).toHaveLength(0);
  });

  it('ask-user-question: closed as such', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    await post('claude', fixture('claude/permission-request-ask-user-question.json'));

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'ask-user-question' }),
    ]);
  });

  it('worktree-unresolved: closed, with the same abstention body as before', async () => {
    const { status, body } = await post('claude', undefined, 'wt-gone');

    expect({ status, body }).toEqual({ status: 200, body: {} });
    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'worktree-unresolved' }),
    ]);
  });

  it('the catch-all: the request is closed as the abstention the agent was sent', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    deliveryFault.current = new Error('delivery threw');

    const { status, body } = await post('claude');

    expect({ status, body }).toEqual({ status: 200, body: {} });
    expect(lines(EV.hookRequestClosed)).toEqual([expect.objectContaining({ outcome: 'abstained', abstainReason: 'error' })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ answeredAtClose: false, resolution: 'unresolved-after-send' })]);
  });
});

describe('[#3820] the CLI mode a PermissionRequest states (design §3.4)', () => {
  it('writes the first mode and a change, and nothing for a tool whose payload has none', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    await post('claude');
    await post('claude');
    await post('claude', { ...PAYLOADS.claude(), permission_mode: 'acceptEdits' });
    await post('antigravity');

    expect(lines(EV.cliModeObserved)).toEqual([
      expect.objectContaining({ cliToolId: 'claude', worktreeId: WT, instanceId: 'claude', mode: 'default', change: 'first' }),
      expect.objectContaining({ cliToolId: 'claude', mode: 'acceptEdits', change: 'changed' }),
    ]);
  });
});

describe('[#3820] the ledger failing changes nothing the agent is told (design §8.1)', () => {
  async function responses() {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);
    const allowClaude = await post('claude');
    const allowAgy = await post('antigravity');
    const unresolved = await post('claude', undefined, 'wt-gone');
    policyRef.current = { mode: 'off', allowPromptTypes: [], denyPatterns: [] };
    const abstain = await post('claude');
    policyRef.current = null;
    return { allowClaude, allowAgy, unresolved, abstain, rows: getMessages(db!, WT).length };
  }

  it('returns the same bodies and statuses when the ledger throws', async () => {
    const baseline = await responses();
    db!.prepare('DELETE FROM chat_messages').run();
    resetAutoYesConfirmationLedgerForTests();
    setAutoYesLedgerFaultForTests(new Error('ledger down'));

    expect(await responses()).toEqual(baseline);
    expect(baseline.allowClaude).toEqual({
      status: 200,
      body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    });
  });

  it('returns the same bodies and statuses when the ledger’s logger throws', async () => {
    const baseline = await responses();
    db!.prepare('DELETE FROM chat_messages').run();
    resetAutoYesConfirmationLedgerForTests();
    ledgerLoggerFault.current = true;

    expect(await responses()).toEqual(baseline);
  });
});
