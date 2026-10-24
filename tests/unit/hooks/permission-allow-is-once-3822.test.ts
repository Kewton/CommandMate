/**
 * Issue #3822: the hook's `allow` approves this call only — it never saves a
 * rule or changes the mode.
 *
 * Auto-Yes answers the screen's "allow this call once" row only
 * (`polling/auto-yes-option-effect`). The `PermissionRequest` hook path must not
 * be the way round that: `resolvePermissionRequest`'s `allow` is turned into
 * the `allowOnce` verdict for an approval CommandMate holds (opencode,
 * OpenCode V2 — `allowAlways` is what their `Always allow` would be), and
 * Claude's response body carries `behavior: 'allow'` and nothing else (no
 * `updatedPermissions`, no `addRules`).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
}));

import { adjudicatePendingPermission } from '@/lib/hooks/permission-adjudication';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { clearPermissionDecisions } from '@/lib/hooks/permission-decision-state';
import { recordDecisionDelivery, resetPendingDecisions } from '@/lib/hooks/sources/pending-decisions';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { encodeClaudeVerdict } from '@/lib/hooks/sources/claude/source';
import type { AgentEventSource, PendingDecision, Verdict } from '@/lib/hooks/sources/types';
import { resetAutoYesConfirmationLedgerForTests } from '@/lib/polling/auto-yes-confirmation-ledger';

const TARGET = { worktreeId: 'wt-hook-3822', cliToolId: 'opencode', instanceId: 'opencode' } as const;

function pending(): PendingDecision {
  return {
    kind: 'permission',
    id: 'per_3822',
    conversationId: 'ses_1',
    subject: { kind: 'permission', toolName: 'bash', toolInput: {} },
    raw: {},
    askedAt: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  resetPendingDecisions();
  clearPermissionDecisions();
});

describe('[#3822] the hook allow is this call only', () => {
  it('an allow from the decision service is delivered as allowOnce, never allowAlways', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
    const verdicts: Verdict[] = [];
    const source = {
      ...opencodeAgentEventSource,
      decide: async (ref, decision, verdict) => {
        verdicts.push(verdict);
        recordDecisionDelivery(ref, decision.id, { delivered: true, reason: 'delivered' });
      },
    } as AgentEventSource;

    await adjudicatePendingPermission(source, TARGET, pending(), null);

    expect(verdicts).toEqual([{ kind: 'allowOnce' }]);
  });

  it("claude's allow body names the behaviour only (no saved rule, no mode)", () => {
    expect(encodeClaudeVerdict({ kind: 'allowOnce' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it("negative: claude's allowAlways is not spelled at all (no-decision)", () => {
    const body = encodeClaudeVerdict({ kind: 'allowAlways' });
    expect(JSON.stringify(body)).not.toContain('allow');
  });
});
