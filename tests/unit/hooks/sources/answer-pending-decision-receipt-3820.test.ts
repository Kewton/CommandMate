/**
 * `answerPendingDecision`'s `onReceipt` (Issue #3820 PR 2, review item 4).
 *
 * The helper catches a `decide` that throws and hands back the empty body, so a
 * receiver route never hears of the failure; `onReceipt` hands it the receipt
 * the helper already keeps, for the route's ledger. What is pinned: the body is
 * the same with or without the option, the receipt says what the helper's own
 * receipt says, and a callback that throws costs nothing.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import {
  answerPendingDecision,
  listOpenDecisions,
  resetPendingDecisions,
} from '@/lib/hooks/sources/pending-decisions';
import type { AgentEventSource, PendingDecision } from '@/lib/hooks/sources/types';

const REF = { worktreeId: 'wt-receipt-3820', cliToolId: 'claude', instanceId: 'claude' } as const;
const DECISION: PendingDecision = {
  kind: 'permission',
  id: 'prompt-3820',
  conversationId: 'ses-1',
  subject: { kind: 'permission', toolName: 'Bash', toolInput: { command: 'ls' } },
  raw: {},
  askedAt: 0,
};
const broken: AgentEventSource = {
  ...claudeAgentEventSource,
  decide: async () => {
    throw new Error('connection refused');
  },
};

afterEach(() => {
  resetPendingDecisions();
});

describe('[#3820] answerPendingDecision hands the receipt to onReceipt', () => {
  it('says delivered for a body the push source wrote, and the body is unchanged', async () => {
    const onReceipt = vi.fn();
    const withOption = await answerPendingDecision(claudeAgentEventSource, REF, DECISION, { kind: 'allowOnce' }, { onReceipt });
    const without = await answerPendingDecision(claudeAgentEventSource, REF, DECISION, { kind: 'allowOnce' });

    expect(withOption).toEqual(without);
    expect(onReceipt).toHaveBeenCalledWith({ delivered: true, reason: 'response-body' });
  });

  it('says not delivered when decide threw, beside the same empty body', async () => {
    const onReceipt = vi.fn();

    expect(await answerPendingDecision(broken, REF, DECISION, { kind: 'allowOnce' }, { onReceipt })).toEqual({});
    expect(onReceipt).toHaveBeenCalledWith({ delivered: false, reason: 'decide-threw:connection refused' });
    expect(listOpenDecisions(REF)).toEqual([]);
  });

  it('returns the body when onReceipt throws', async () => {
    const body = await answerPendingDecision(claudeAgentEventSource, REF, DECISION, { kind: 'allowOnce' }, {
      onReceipt: () => {
        throw new Error('ledger down');
      },
    });

    expect(body).toEqual(await answerPendingDecision(claudeAgentEventSource, REF, DECISION, { kind: 'allowOnce' }));
  });
});
