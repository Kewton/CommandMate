/**
 * The `prompt_waiting` state machine (Issue #1725).
 *
 * Pinned here without a tmux session or a database: which events open the state,
 * which release it, what the generation and age bounds do to it, and the one
 * rule that is easy to get backwards — that the scraper may only report a
 * prompt gone if it ever saw it.
 *
 * The negative cases carry the weight, as in #1723's suite. A state machine
 * that always says "waiting" passes every positive assertion, so every release
 * is asserted against an open state that would visibly have answered otherwise.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  clearStructuredPromptWaiting,
  corroborateStructuredPromptWaiting,
  discardAgentEventState,
  getStructuredPromptWaiting,
  markStructuredPromptRecorded,
  recordAgentEvent,
  reportPermissionRequestPending,
  STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  buildStructuredPromptQuestion,
} from '@/lib/session/structured-prompt';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearAgentStopEvents();
});

function record(
  event: AgentEventType,
  detail: string | null = null,
  at: number = NOW,
  message: string | null = null,
): void {
  recordAgentEvent('wt-1', 'claude', 'claude', { event, at, detail, sessionId: 'sess-1', message });
}

function openDialog(at: number = NOW, message = 'Claude needs your permission to use Bash'): void {
  record('notification', 'permission_prompt', at, message);
}

function state(now: number = NOW) {
  return getStructuredPromptWaiting('wt-1', 'claude', 'claude', now);
}

describe('opening the state (Issue #1725)', () => {
  it('opens on Notification(permission_prompt), already confirmed', () => {
    openDialog();

    expect(state()).toMatchObject({
      at: NOW,
      source: 'notification',
      message: 'Claude needs your permission to use Bash',
      confirmedAt: NOW,
      scraperCorroborated: false,
    });
  });

  it('opens provisionally on a PermissionRequest nobody decided', () => {
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', NOW);

    expect(state()).toMatchObject({
      source: 'permission-request',
      toolName: 'Bash',
      confirmedAt: null,
    });
  });

  it('does not open on a Notification of any other type', () => {
    // `notification_type` is the machine key (D3). A type this server has never
    // observed is not evidence of a dialog, and `message` — English prose — is
    // never consulted at all.
    record('notification', 'idle_prompt', NOW, 'Claude is waiting for your input');
    expect(state()).toBeNull();

    record('notification', 'some_future_type', NOW, 'Claude needs your permission');
    expect(state()).toBeNull();
  });

  it('keeps the first timestamp when the notification confirms an earlier prediction', () => {
    // PermissionRequest fires before the dialog; the Notification lands ~6s
    // after it is drawn. They are one dialog, and `at` is when the human was
    // first blocked.
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', NOW);
    openDialog(NOW + 6_000);

    expect(state(NOW + 6_000)).toMatchObject({
      at: NOW,
      source: 'notification',
      toolName: 'Bash',
      confirmedAt: NOW + 6_000,
    });
  });

  it('does not downgrade a confirmed record back to a prediction', () => {
    openDialog();
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Edit', NOW + 1_000);

    expect(state(NOW + 1_000)).toMatchObject({ source: 'notification', confirmedAt: NOW });
  });

  it('is scoped to one instance', () => {
    openDialog();

    expect(getStructuredPromptWaiting('wt-1', 'claude', 'claude-2', NOW)).toBeNull();
    expect(getStructuredPromptWaiting('wt-2', 'claude', 'claude', NOW)).toBeNull();
  });
});

describe('releasing the state (Issue #1725)', () => {
  const releasing: AgentEventType[] = ['stop', 'user_prompt_submit', 'session_start', 'session_end'];

  it.each(releasing)('%s releases it', (event) => {
    openDialog();
    expect(state()).not.toBeNull();

    record(event, null, NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('Notification(idle_prompt) releases it', () => {
    // The agent reporting it is sitting at the composer waiting for input is
    // the agent saying nothing is in front of that composer.
    openDialog();

    record('notification', 'idle_prompt', NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('a Notification of an unknown type leaves it alone', () => {
    openDialog();

    record('notification', 'some_future_type', NOW + 1_000);

    expect(state(NOW + 1_000)).not.toBeNull();
  });

  it('a new generation releases it', () => {
    openDialog();

    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('an event from before the current generation cannot open it', () => {
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW);

    openDialog(NOW - 1_000);

    expect(state()).toBeNull();
  });

  it('discarding the instance state releases it', () => {
    openDialog();

    discardAgentEventState('wt-1', 'claude', 'claude');

    expect(state()).toBeNull();
  });

  it('the explicit release used by the builder releases it', () => {
    openDialog();

    clearStructuredPromptWaiting('wt-1', 'claude', 'claude');

    expect(state()).toBeNull();
  });
});

describe('the bounds on trusting it (Issue #1725)', () => {
  it('expires a confirmed record at the shared age bound', () => {
    openDialog();

    expect(state(NOW + STRUCTURED_STATE_MAX_AGE_MS - 1)).not.toBeNull();
    expect(state(NOW + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
  });

  it('expires an uncorroborated PermissionRequest far sooner', () => {
    // A prediction nothing confirmed must not keep a worker stopped: the cost
    // of it sticking is `wait --on-prompt agent` exiting 10 on a healthy
    // session.
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', NOW);

    expect(state(NOW + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS - 1)).not.toBeNull();
    expect(state(NOW + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS)).toBeNull();
  });

  it('stops expiring it early once the notification proves the dialog', () => {
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', NOW);
    openDialog(NOW + 6_000);

    expect(state(NOW + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS + 1)).not.toBeNull();
  });

  it('stops expiring it early once the scraper corroborates it', () => {
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', NOW);

    corroborateStructuredPromptWaiting('wt-1', 'claude', 'claude', NOW + 4_000);

    expect(state(NOW + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS + 1)).toMatchObject({
      confirmedAt: NOW + 4_000,
      scraperCorroborated: true,
    });
  });
});

describe('bookkeeping flags (Issue #1725)', () => {
  it('records corroboration and the history write on the live record', () => {
    openDialog();
    expect(state()).toMatchObject({ scraperCorroborated: false, recorded: false });

    corroborateStructuredPromptWaiting('wt-1', 'claude', 'claude', NOW + 1);
    markStructuredPromptRecorded('wt-1', 'claude', 'claude');

    expect(state()).toMatchObject({ scraperCorroborated: true, recorded: true });
  });

  it('is a no-op on an instance with no open dialog', () => {
    expect(() => {
      corroborateStructuredPromptWaiting('wt-1', 'claude', 'claude');
      markStructuredPromptRecorded('wt-1', 'claude', 'claude');
      clearStructuredPromptWaiting('wt-1', 'claude', 'claude');
    }).not.toThrow();
    expect(state()).toBeNull();
  });

  it('does not carry `recorded` across episodes', () => {
    openDialog();
    markStructuredPromptRecorded('wt-1', 'claude', 'claude');
    record('stop', null, NOW + 1_000);

    openDialog(NOW + 2_000);

    expect(state(NOW + 2_000)).toMatchObject({ recorded: false });
  });
});

describe('the degraded prompt payload (Issue #1725)', () => {
  const facts = {
    source: 'notification' as const,
    message: 'Claude needs your permission to use Bash',
    toolName: 'Bash',
  };

  it('is an unclassified prompt with no options', () => {
    const data = buildStructuredPromptData('wt-1', facts);

    expect(data.type).toBe(UNCLASSIFIED_PROMPT_TYPE);
    expect(data.options).toEqual([]);
    expect(data.status).toBe('pending');
    expect(data.source).toBe('notification');
    expect(data.message).toBe(facts.message);
  });

  it('tells the reader to answer by NUMBER', () => {
    // `respond <id> yes` is not resolved semantically on a numbered dialog —
    // Enter takes the highlighted default, so a "no" can be delivered as an
    // approval (Issue #1681). This string is the only guidance a `wait` caller
    // gets, so the form that works has to be in it.
    const question = buildStructuredPromptQuestion('wt-1', facts);

    expect(question).toContain('commandmate respond wt-1 <number>');
    expect(question).toContain('NUMBER');
    expect(question).toContain('Claude needs your permission to use Bash');
  });

  it('names the source and the tool so the two kinds of evidence stay apart', () => {
    expect(buildStructuredPromptQuestion('wt-1', facts)).toContain(
      'Notification(permission_prompt)',
    );
    expect(
      buildStructuredPromptQuestion('wt-1', {
        source: 'permission-request',
        message: null,
        toolName: 'Bash',
      }),
    ).toContain('PermissionRequest (no decision)');
  });

  it('omits the agent message when there was none', () => {
    const data = buildStructuredPromptData('wt-1', {
      source: 'permission-request',
      message: null,
      toolName: null,
    });

    expect(data.message).toBeUndefined();
    expect(data.question).not.toContain('Agent message');
  });

  it('writes history rows as `unclassified`, never as `pending`', () => {
    // `markPendingPromptsAsAnswered()` selects on `status = 'pending'`. A row
    // recording that the detection layer never saw this dialog must not be
    // stamped "(answered via terminal)" by that sweep — the answer, if one
    // comes, belongs to the prompt writer's own row.
    expect(buildStructuredPromptHistoryRecord('wt-1', facts).status).toBe('unclassified');
    expect(buildStructuredPromptData('wt-1', facts).status).toBe('pending');
  });
});
