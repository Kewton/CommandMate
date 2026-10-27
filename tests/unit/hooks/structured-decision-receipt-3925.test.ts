/**
 * `answerStructuredDecision` hands back the source's receipt as it came, so a
 * caller can tell "not delivered" from "outcome unknown" (Issue #3925,
 * consistency review 2).
 *
 * `delivered` folds a missing receipt into `false`, and `/prompt-response`'s
 * structured stage read only that: a verdict the source gave no receipt for
 * settled the person's manual answer `not-sent` and released the hold of an
 * earlier send of unknown outcome, where `/respond` only abandons it. The
 * `receipt` field carries the receipt or null; `delivered` is unchanged.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
  };
});

/** When set, the next delivery returns no receipt instead of the real one. */
const delivery = vi.hoisted(() => ({ noReceipt: false }));
vi.mock('@/lib/hooks/sources/pending-decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/pending-decisions')>();
  return {
    ...actual,
    answerPendingDecisionWithReceipt: vi.fn(async (...args: Parameters<typeof actual.answerPendingDecisionWithReceipt>) => {
      if (delivery.noReceipt) return { body: {}, delivery: null };
      return actual.answerPendingDecisionWithReceipt(...args);
    }),
  };
});

import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  replyOpencodePermission,
} from '@/lib/hooks/sources/opencode/client';
import { answerStructuredDecision } from '@/lib/hooks/structured-decision-response';
import { rememberOpencodePort, resetOpencodePortAssignments } from '@/lib/hooks/sources/opencode/ports';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const PERMISSION_ID = 'per_0000000000000000000000000';
const TARGET = { worktreeId: 'wt-receipt', cliToolId: 'opencode', instanceId: 'opencode' } as const;

function pendingPermission(): Record<string, unknown> {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'permission-asked.json'), 'utf8'));
  return { ...asked.properties, id: PERMISSION_ID };
}

function answer() {
  return answerStructuredDecision({ ...TARGET, answer: '1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  delivery.noReceipt = false;
  resetOpencodePortAssignments();
  resetPendingDecisions();
  clearAgentStopEvents();
  rememberOpencodePort(TARGET, 4242, '/tmp/wt');
  vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([]);
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission()]);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
});

afterEach(() => {
  resetOpencodePortAssignments();
});

describe('the answered outcome carries the receipt', () => {
  it('no receipt: `receipt` is null, `delivered` stays false', async () => {
    delivery.noReceipt = true;

    const outcome = await answer();

    expect(outcome).toMatchObject({ kind: 'answered', decisionId: PERMISSION_ID, delivered: false, receipt: null });
  });

  it('negative: a delivered verdict carries its receipt, `delivered` true as before', async () => {
    const outcome = await answer();

    expect(outcome).toMatchObject({ kind: 'answered', delivered: true, receipt: { delivered: true } });
  });

  it('negative: a verdict the source says did not arrive carries a receipt, not null', async () => {
    vi.mocked(replyOpencodePermission).mockResolvedValue(false);

    const outcome = await answer();

    expect(outcome).toMatchObject({ kind: 'answered', delivered: false, receipt: { delivered: false } });
  });
});
