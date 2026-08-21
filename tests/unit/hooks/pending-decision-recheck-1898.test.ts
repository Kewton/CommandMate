/**
 * Re-judging an approval the session is already blocked on (Issue #1898-2).
 *
 * Measured on an isolated server: with a permission dialog up, `commandmate
 * auto-yes <id> --enable --instance opencode` left the session `waiting` for
 * more than thirty seconds with no adjudication in the log at all. The reason
 * is structural rather than a missed call — the request had been abstained on
 * when it arrived, the Auto-Yes poller only reads the *screen*, and the only
 * re-read of what the agent is holding (`resyncPending`) ran on re-connect.
 *
 * What the fix must not do is re-judge a hook source. Its "pending" list is the
 * requests in flight right now, each held open by a route that is about to
 * answer it; a second verdict into that slot is a second answer to a question
 * already answered. `AgentSourceCapabilities.resync` is the declared value that
 * tells the two apart, and the mutation case below is what proves it is read.
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

vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
  PERMISSION_DECISION_SLOW_MS: 500,
}));

import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  replyOpencodePermission,
} from '@/lib/hooks/sources/opencode/client';
import {
  MAX_RECHECKED_DECISIONS,
  recheckPendingDecisions,
} from '@/lib/hooks/pending-decision-recheck';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import {
  clearPermissionDecisions,
  getLastPermissionDecision,
} from '@/lib/hooks/permission-decision-state';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import {
  openDecisionSlot,
  resetPendingDecisions,
} from '@/lib/hooks/sources/pending-decisions';
import type { PendingDecision } from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const PERMISSION_ID = 'per_0000000000000000000000000';

/** The bare object `GET /permission` answers with — not the SSE envelope. */
function pendingPermission(id: string = PERMISSION_ID): Record<string, unknown> {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'permission-asked.json'), 'utf8'));
  return { ...asked.properties, id };
}

const TARGET = { worktreeId: 'wt-recheck', cliToolId: 'opencode', instanceId: 'opencode' } as const;

/** The dialog the structured layer is publishing, or null. */
function waiting() {
  return getStructuredPromptWaiting('wt-recheck', 'opencode', 'opencode');
}

/** Put the session in the state the Issue describes: a dialog up, nobody answering. */
function openDialog(): void {
  recordAgentEvent('wt-recheck', 'opencode', 'opencode', {
    event: 'notification',
    at: Date.now(),
    detail: 'permission_prompt',
    sessionId: 'ses_0000000000000000000000000',
    decisionId: PERMISSION_ID,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodePortAssignments();
  resetPendingDecisions();
  clearAgentStopEvents();
  clearPermissionDecisions();
  rememberOpencodePort(TARGET, 4242, '/tmp/wt');
  vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([]);
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
});

afterEach(() => {
  resetOpencodePortAssignments();
});

describe('a pull source whose approval is still pending', () => {
  it('answers it and retires the dialog', async () => {
    openDialog();
    expect(waiting()).not.toBeNull();
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission()]);

    const result = await recheckPendingDecisions(TARGET);

    expect(result).toEqual({ examined: 1, delivered: 1, skipped: 0, reason: null });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      4242,
      PERMISSION_ID,
      'once',
      undefined
    );
    // The whole point: the operator ran `auto-yes --enable` on a stuck worker
    // and the worker is moving again by the time the command returns.
    expect(waiting()).toBeNull();
    expect(getLastPermissionDecision('wt-recheck', 'opencode', 'opencode')).toMatchObject({
      decisionId: PERMISSION_ID,
      behavior: 'allow',
      delivered: true,
      trigger: 'policy-recheck',
    });
  });

  it('leaves the dialog open when the policy still declines', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({
      behavior: null,
      reason: 'policy-suppressed',
    });
    openDialog();
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission()]);

    const result = await recheckPendingDecisions(TARGET);

    expect(result).toMatchObject({ examined: 1, delivered: 0 });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expect(waiting()).not.toBeNull();
  });

  it('reports nothing to do rather than pretending it acted', async () => {
    expect(await recheckPendingDecisions(TARGET)).toEqual({
      examined: 0,
      delivered: 0,
      skipped: 0,
      reason: 'no-pending',
    });
  });

  it('bounds what it takes from the agent and says what it dropped', async () => {
    // DR4-009: the list comes off a process CommandMate did not start. A cap
    // that truncates silently reads as "everything was covered".
    const many = Array.from({ length: MAX_RECHECKED_DECISIONS + 3 }, (_unused, index) =>
      pendingPermission(`per_${index}`)
    );
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue(many);

    const result = await recheckPendingDecisions(TARGET);

    expect(result).toMatchObject({ examined: MAX_RECHECKED_DECISIONS, skipped: 3, reason: null });
  });

  it('never throws when the agent cannot be reached', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await recheckPendingDecisions(TARGET)).toMatchObject({ reason: 'unreachable' });
  });

  it('does not re-judge a question', async () => {
    // Auto-Yes decides whether to approve. It has no opinion about which of a
    // question's choices to send, and inventing one would answer for the human.
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([
      JSON.parse(readFileSync(join(FIXTURES, 'question-asked.json'), 'utf8')).properties,
    ]);
    expect(await recheckPendingDecisions(TARGET)).toMatchObject({ reason: 'no-pending' });
  });
});

describe('a push source', () => {
  it('is not re-judged at all — its `resync` capability says there is nothing to re-read', async () => {
    // A hook's pending list is the requests a route is holding open right now.
    // Re-judging one delivers a second verdict into a slot about to be closed.
    const decision: PendingDecision = {
      kind: 'permission',
      id: 'prompt-1',
      conversationId: 'ses-1',
      subject: { kind: 'permission', toolName: 'Bash', toolInput: { command: 'ls' } },
      raw: {},
      askedAt: 0,
    };
    const ref = { worktreeId: 'wt-recheck', cliToolId: 'claude', instanceId: 'claude' } as const;
    openDecisionSlot(ref, decision);

    expect(claudeAgentEventSource.capabilities.resync).toBe('none');
    expect(await recheckPendingDecisions(ref)).toEqual({
      examined: 0,
      delivered: 0,
      skipped: 0,
      reason: 'resync-unsupported',
    });
    expect(vi.mocked(resolvePermissionRequest)).not.toHaveBeenCalled();
  });

  it('mutation: declaring opencode `resync: none` stops the re-check dead', async () => {
    // §4 D3's acceptance shape — flip the declared value, the behaviour must
    // vanish. Green with this flipped would mean the capability is decorative.
    const declared = opencodeAgentEventSource.capabilities;
    Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
      value: { ...declared, resync: 'none' },
      configurable: true,
    });
    try {
      openDialog();
      vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission()]);
      expect(await recheckPendingDecisions(TARGET)).toMatchObject({
        reason: 'resync-unsupported',
      });
      expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
      expect(waiting()).not.toBeNull();
    } finally {
      Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
        value: declared,
        configurable: true,
      });
    }
  });
});
