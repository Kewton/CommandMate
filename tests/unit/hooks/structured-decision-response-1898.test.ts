/**
 * `commandmate respond` answering an approval by decision id (Issue #1898-3).
 *
 * Measured on an isolated server: `wait` reported the dialog (exit 10) with a
 * sentence telling the operator to run `respond`, and `respond` then answered
 * `prompt_no_longer_active` — exit 99 — because the route re-captures the pane,
 * runs `detectPrompt`, and opencode's approval dialog parses as nothing. The
 * only remaining way to answer was to press a key in the tmux pane by hand.
 *
 * Two properties are asserted here and both are load-bearing:
 *
 *  - **the number really is the verdict.** `respond <id> 1` must POST `once`,
 *    not send a `1` at a pane. The known trap is the opposite one — a
 *    non-numeric `respond` degrades into Enter and takes whatever is
 *    highlighted (#1681) — and this path exists so that neither happens.
 *  - **the id is never the caller's.** It is read back from the source for the
 *    (worktree, tool, instance) the request already resolved to, so a
 *    cross-instance decision id cannot be expressed at all (DR4-003 / S6).
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

import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  replyOpencodePermission,
} from '@/lib/hooks/sources/opencode/client';
import {
  answerStructuredDecision,
  resolveStructuredDecisionOption,
  STRUCTURED_REJECT_MESSAGE,
} from '@/lib/hooks/structured-decision-response';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { STRUCTURED_DECISION_OPTIONS } from '@/lib/session/structured-prompt';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const PERMISSION_ID = 'per_0000000000000000000000000';
const OTHER_PORT = 4343;

function pendingPermission(id: string = PERMISSION_ID): Record<string, unknown> {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'permission-asked.json'), 'utf8'));
  return { ...asked.properties, id };
}

const TARGET = { worktreeId: 'wt-respond', cliToolId: 'opencode', instanceId: 'opencode' } as const;

function openDialog(): void {
  recordAgentEvent('wt-respond', 'opencode', 'opencode', {
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
  rememberOpencodePort(TARGET, 4242, '/tmp/wt');
  vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([]);
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission()]);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
});

afterEach(() => {
  resetOpencodePortAssignments();
});

describe('the answer vocabulary', () => {
  it('maps every published option number, label and wire word', () => {
    // The list `wait` prints on its exit-10 output and the list `respond`
    // accepts are the same list. Pinned together so they cannot drift.
    for (const option of STRUCTURED_DECISION_OPTIONS) {
      expect(resolveStructuredDecisionOption(String(option.number))).toEqual(option);
      expect(resolveStructuredDecisionOption(option.label)).toEqual(option);
      expect(resolveStructuredDecisionOption(option.label.toUpperCase())).toEqual(option);
      expect(resolveStructuredDecisionOption(option.reply)).toEqual(option);
    }
  });

  it('resolves `yes` to the NARROWEST allow, never to `always`', () => {
    // A wrong allow executes a command, so an ambiguous approval takes the
    // option that does not also grant every future one.
    expect(resolveStructuredDecisionOption('yes')).toMatchObject({ number: 1, reply: 'once' });
    expect(resolveStructuredDecisionOption('no')).toMatchObject({ number: 3, reply: 'reject' });
  });

  it('answers null for anything it cannot name', () => {
    for (const answer of ['', '  ', '4', '0', 'maybe', 'allow once please']) {
      expect(resolveStructuredDecisionOption(answer)).toBeNull();
    }
  });
});

describe('answering the pending approval', () => {
  it('POSTs `once` for `respond <id> 1` — no key is sent anywhere', async () => {
    openDialog();

    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      answer: '1',
    });

    expect(outcome).toMatchObject({
      kind: 'answered',
      decisionId: PERMISSION_ID,
      delivered: true,
      option: { number: 1, label: 'Allow once', reply: 'once' },
    });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      4242,
      PERMISSION_ID,
      'once',
      undefined
    );
    // Answered means answered: the dialog stops being published immediately
    // rather than when the agent's own `permission.replied` catches up.
    expect(getStructuredPromptWaiting('wt-respond', 'opencode', 'opencode')).toBeNull();
  });

  it('POSTs `always` for 2 and `reject` — with a reason — for 3', async () => {
    await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      answer: '2',
    });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      4242,
      PERMISSION_ID,
      'always',
      undefined
    );

    await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      answer: 'Reject',
    });
    // The message reaches the agent verbatim and lands in the tool part's
    // `state.error`, which is the only way it learns WHY it was refused.
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      4242,
      PERMISSION_ID,
      'reject',
      STRUCTURED_REJECT_MESSAGE
    );
  });

  it('refuses an answer that names no verdict, before anything is sent', async () => {
    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      answer: '9',
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'answer_out_of_range' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('refuses `--default` rather than guessing which option is highlighted', async () => {
    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      useDefault: true,
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unresolvable_answer' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('reports an undelivered verdict instead of claiming success', async () => {
    vi.mocked(replyOpencodePermission).mockResolvedValue(false);
    openDialog();

    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      answer: '1',
    });

    expect(outcome).toMatchObject({ kind: 'answered', delivered: false });
    // Still blocked. `respond` turns this into a non-zero exit that says so.
    expect(getStructuredPromptWaiting('wt-respond', 'opencode', 'opencode')).not.toBeNull();
  });
});

describe('when the structured path must stand aside', () => {
  it('declines for a source with no decision identity, leaving the keystroke path', async () => {
    // Every hook tool. `respond` must go on behaving exactly as it did.
    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'claude',
      answer: '1',
    });
    expect(outcome).toEqual({ kind: 'not-applicable', reason: 'no-decision-identity' });
  });

  it('declines when the agent is holding nothing', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
    expect(
      await answerStructuredDecision({
        worktreeId: 'wt-respond',
        cliToolId: 'opencode',
        answer: '1',
      })
    ).toEqual({ kind: 'not-applicable', reason: 'no-pending-decision' });
  });

  it('declines when the agent cannot be reached', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(
      await answerStructuredDecision({
        worktreeId: 'wt-respond',
        cliToolId: 'opencode',
        answer: '1',
      })
    ).toEqual({ kind: 'not-applicable', reason: 'source-unreachable' });
  });

  it('mutation: declaring `eventIdentity: null` puts respond back on keystrokes', async () => {
    const declared = opencodeAgentEventSource.capabilities;
    Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
      value: { ...declared, eventIdentity: null },
      configurable: true,
    });
    try {
      expect(
        await answerStructuredDecision({
          worktreeId: 'wt-respond',
          cliToolId: 'opencode',
          answer: '1',
        })
      ).toEqual({ kind: 'not-applicable', reason: 'no-decision-identity' });
      expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
        value: declared,
        configurable: true,
      });
    }
  });
});

describe('the decision scope (DR4-003 / S6)', () => {
  it('answers only what the resolved instance is holding', async () => {
    // `wt-respond`/`opencode-2` runs on its own port and holds its own
    // approval. Answering the primary instance must not reach it — and on this
    // tool a cross-instance reply would be POSTed to a different server.
    const other = { worktreeId: 'wt-respond', cliToolId: 'opencode', instanceId: 'opencode-2' } as const;
    rememberOpencodePort(other, OTHER_PORT, '/tmp/wt');
    vi.mocked(fetchOpencodePendingPermissions).mockImplementation(async (port: number) =>
      port === OTHER_PORT ? [pendingPermission('per_other_instance')] : [pendingPermission()]
    );

    await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      answer: '1',
    });

    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      4242,
      PERMISSION_ID,
      'once',
      undefined
    );
  });

  it('gives a caller no way to name a decision at all', async () => {
    // The strongest form of the scope rule: there is no input to smuggle an id
    // through. The only free-text field is the answer, and an id put there
    // names no verdict — so it is refused rather than looked up anywhere.
    const outcome = await answerStructuredDecision({
      worktreeId: 'wt-respond',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      answer: 'per_someone_elses_dialog',
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'answer_out_of_range' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });
});
