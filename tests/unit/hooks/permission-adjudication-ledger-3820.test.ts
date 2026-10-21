/**
 * `adjudicatePendingPermission` in the Auto-Yes confirmation ledger (Issue #3820,
 * design `docs/design/auto-yes-measurement-3820.md` §2.3・§2.4・§8.1, PR 2).
 *
 * An approval CommandMate holds (opencode) is one confirmation keyed by its
 * decision id: a delivered allow is an `ok` send, an undelivered one is
 * `failed` and never an answer, and **no hook request** is made — that id is
 * the hook route's alone (N2). The adjudicator itself is mocked: what is under
 * test is the record, and that the record cannot change what is returned.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
}));

import { adjudicatePendingPermission } from '@/lib/hooks/permission-adjudication';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { clearPermissionDecisions } from '@/lib/hooks/permission-decision-state';
import { recordDecisionDelivery, resetPendingDecisions } from '@/lib/hooks/sources/pending-decisions';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import type { AgentEventSource, PendingDecision } from '@/lib/hooks/sources/types';
import {
  noteLedgerApiDecisionReplied,
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const TARGET = { worktreeId: 'wt-api-3820', cliToolId: 'opencode', instanceId: 'opencode' } as const;

/** opencode's declared capabilities, delivering (or not) the way the test says. */
function source(delivered: boolean): AgentEventSource {
  return {
    ...opencodeAgentEventSource,
    decide: async (ref, decision) => {
      recordDecisionDelivery(ref, decision.id, { delivered, reason: delivered ? 'delivered' : 'refused' });
    },
  } as AgentEventSource;
}

function pending(id = 'per_3820'): PendingDecision {
  return {
    kind: 'permission',
    id,
    conversationId: 'ses_1',
    subject: { kind: 'permission', toolName: 'bash', toolInput: {} },
    raw: {},
    askedAt: Date.now(),
  };
}

const lines = (event: string): Array<Record<string, unknown>> =>
  ledgerLog.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  ledgerLoggerFault.current = false;
  resetAutoYesConfirmationLedgerForTests();
  resetPendingDecisions();
  clearPermissionDecisions();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
});

afterEach(() => {
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
});

describe('[#3820] an opencode approval in the ledger', () => {
  it('is one confirmation and no hook request: a delivered allow is answered by the reply', async () => {
    await adjudicatePendingPermission(source(true), TARGET, pending(), null);

    expect(lines(EV.hookRequestClosed)).toHaveLength(0);
    expect(lines(EV.opened)).toEqual([expect.objectContaining({ source: 'api', cliToolId: 'opencode', worktreeId: TARGET.worktreeId })]);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'L1', result: 'ok' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: true, resolution: 'resolved-by-reply', resolvedBy: 'auto' }),
    ]);
  });

  it('counts an undelivered allow as a failed send and not as an answer', async () => {
    await adjudicatePendingPermission(source(false), TARGET, pending(), null);

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.closed)).toHaveLength(0);
    noteLedgerApiDecisionReplied(TARGET, 'per_3820');
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: false, attempts: expect.objectContaining({ ok: 0, failed: 1 }) }),
    ]);
  });

  it('withholds an approval a policy suppressed, and a later allow on the same id continues it', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValueOnce({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
    });
    await adjudicatePendingPermission(source(true), TARGET, pending(), null, 'event');
    await adjudicatePendingPermission(source(true), TARGET, pending(), null, 'policy-recheck');

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'deny-pattern', source: 'api' })]);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'answered' })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-by-reply', intervals: 1 })]);
  });

  it('calls the adjudicator without a hook request id', async () => {
    await adjudicatePendingPermission(source(true), TARGET, pending(), null);

    expect(vi.mocked(resolvePermissionRequest).mock.calls[0]).toHaveLength(2);
  });
});

describe('[#3820] the ledger failing changes nothing the adjudication returns (design §8.1)', () => {
  async function outcomes() {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
    const delivered = await adjudicatePendingPermission(source(true), TARGET, pending('per_a'), null);
    const refused = await adjudicatePendingPermission(source(false), TARGET, pending('per_b'), null);
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: null, reason: 'policy-suppressed', suppressedBy: 'mode-off' });
    const abstained = await adjudicatePendingPermission(source(true), TARGET, pending('per_c'), null);
    return { delivered, refused, abstained };
  }

  it('returns the same outcome when the ledger throws', async () => {
    const baseline = await outcomes();
    resetAutoYesConfirmationLedgerForTests();
    setAutoYesLedgerFaultForTests(new Error('ledger down'));

    expect(await outcomes()).toEqual(baseline);
    expect(baseline.delivered).toEqual(expect.objectContaining({ delivered: true, settled: true }));
  });

  it('returns the same outcome when the ledger’s logger throws', async () => {
    const baseline = await outcomes();
    resetAutoYesConfirmationLedgerForTests();
    ledgerLoggerFault.current = true;

    expect(await outcomes()).toEqual(baseline);
  });
});
