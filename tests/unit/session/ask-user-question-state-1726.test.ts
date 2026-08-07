/**
 * The lifetime of an in-flight `AskUserQuestion` (Issue #1726).
 *
 * A record that outlives its screen is the specific harm this file exists to
 * prevent: `respond` would then check an answer against the options of a
 * question that was answered minutes ago, and refuse a number the *current*
 * dialog offers — or, worse, resolve a label to a number that now means
 * something else. So every release is asserted against a record that would
 * visibly have survived otherwise, and the one event that must NOT release is
 * asserted the same way.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  clearAskUserQuestion,
  discardAgentEventState,
  getAskUserQuestion,
  isDuplicateAgentEvent,
  recordAgentEvent,
  recordAskUserQuestion,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { agentEventToSessionStatus, HOOK_STATUS_REASON } from '@/lib/session/status-mapping';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';

const NOW = 1_800_000_000_000;

const SPEC: AskUserQuestionSpec = {
  promptId: 'prompt-1',
  questions: [
    {
      question: 'Which task would you like to start with?',
      header: 'First task',
      multiSelect: false,
      choices: [
        { label: 'Clear desk', description: null },
        { label: 'Sort papers', description: null },
      ],
    },
  ],
};

beforeEach(() => {
  clearAgentStopEvents();
});

function record(event: AgentEventType, detail: string | null = null, at: number = NOW): void {
  recordAgentEvent('wt-1', 'claude', 'claude', { event, at, detail, sessionId: 'sess-1' });
}

/** The invocation as the route delivers it: the event, then the payload. */
function invoke(at: number = NOW): void {
  record('pre_tool_use', 'AskUserQuestion', at);
  recordAskUserQuestion('wt-1', 'claude', 'claude', SPEC, at);
}

function state(now: number = NOW) {
  return getAskUserQuestion('wt-1', 'claude', 'claude', now);
}

describe('recording the call (Issue #1726)', () => {
  it('keeps the questions the agent sent', () => {
    invoke();

    expect(state()).toMatchObject({ at: NOW, spec: SPEC });
  });

  it('is scoped to one instance', () => {
    invoke();

    expect(getAskUserQuestion('wt-1', 'claude', 'claude-2', NOW)).toBeNull();
    expect(getAskUserQuestion('wt-2', 'claude', 'claude', NOW)).toBeNull();
  });

  it('survives its own PreToolUse event, which is the whole point', () => {
    // The event is what releases a *previous* question, and the route records
    // the payload immediately after it. If `pre_tool_use` released, the call
    // would erase itself on arrival.
    invoke();

    expect(state()).not.toBeNull();
  });

  it('the second delivery of the same call is a harmless overwrite', () => {
    // `AskUserQuestion` raises a `PermissionRequest` carrying the same
    // `tool_input`, so the same call is reported twice on every session.
    invoke();
    recordAskUserQuestion('wt-1', 'claude', 'claude', SPEC, NOW + 500);

    expect(state(NOW + 500)).toMatchObject({ at: NOW + 500, spec: SPEC });
  });
});

describe('releasing the call (Issue #1726)', () => {
  const releasing: Array<[AgentEventType, string | null]> = [
    ['stop', null],
    ['user_prompt_submit', null],
    ['session_start', 'startup'],
    ['session_end', 'clear'],
    ['notification', 'idle_prompt'],
  ];

  it.each(releasing)('%s releases it', (event, detail) => {
    invoke();
    expect(state()).not.toBeNull();

    record(event, detail, NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('Stop releases it too, as the backstop for a lost PostToolUse', () => {
    // §5.6: answering the picker resumed the turn and delivered a `Stop`
    // (received 23 → 24). Hooks are fail-open, so a `PostToolUse` that never
    // arrives must not leave the question in place for the age bound.
    invoke();

    record('stop', null, NOW + 60_000);

    expect(state(NOW + 60_000)).toBeNull();
  });

  it('PostToolUse releases it — the precise signal, measured for this Issue', () => {
    // The #1721 spike recorded `PostToolUse` as never observed, and Issue
    // #1726's text proposed it. Measured directly on a live v2.1.223 session on
    // 2026-08-06: PreToolUse 15:36:04.112 -> PostToolUse 15:36:28.643 (the human
    // answered) -> Stop 15:36:29.992. It fires, and it is what "the call is
    // over" means — `Stop` can be minutes later if the agent keeps working.
    invoke();

    record('post_tool_use', 'AskUserQuestion', NOW + 30_000);

    expect(state(NOW + 30_000)).toBeNull();
  });

  it('a PreToolUse for another tool releases it', () => {
    // Only reachable when the operator's own settings.json registers a wider
    // matcher — the two files are concatenated (#1722) — but a stale question is
    // exactly what puts wrong options in front of `respond`.
    invoke();

    record('pre_tool_use', 'Bash', NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('a new generation releases it', () => {
    invoke();

    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW + 1_000);

    expect(state(NOW + 1_000)).toBeNull();
  });

  it('a call from before the current generation is not this session’s', () => {
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW);

    recordAskUserQuestion('wt-1', 'claude', 'claude', SPEC, NOW - 1_000);

    expect(state()).toBeNull();
  });

  it('discarding the instance state releases it', () => {
    invoke();

    discardAgentEventState('wt-1', 'claude', 'claude');

    expect(state()).toBeNull();
  });

  it('the explicit release releases it', () => {
    invoke();

    clearAskUserQuestion('wt-1', 'claude', 'claude');

    expect(state()).toBeNull();
  });

  it('expires at the shared age bound', () => {
    invoke();

    expect(state(NOW + STRUCTURED_STATE_MAX_AGE_MS - 1)).not.toBeNull();
    expect(state(NOW + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
  });
});

describe('what must NOT release it mid-call (Issue #1726)', () => {
  it('survives the Notification the picker itself produces', () => {
    // Measured on a live v2.1.223 session on 2026-08-06, driven through the
    // server: PreToolUse at 15:29:18.099, then Notification(permission_prompt)
    // at 15:29:24.128 with the picker still on screen — the ~6 s delay §5.5
    // documents for the notification, landing INSIDE the window §5.6 described
    // as silent. A rule that released here switched the whole feature off six
    // seconds after it turned on, on every real session.
    invoke();

    record('notification', 'permission_prompt', NOW + 6_000);

    expect(state(NOW + 6_000)).toMatchObject({ spec: SPEC });
  });

  it('survives a notification type nothing is known about', () => {
    invoke();

    record('notification', 'some_future_type', NOW + 1_000);

    expect(state(NOW + 1_000)).not.toBeNull();
  });

  it('nothing else arrives between the question and the answer', () => {
    // §5.6 measured no further events across the selection screen, "Review your
    // answers" and "Ready to submit your answers?". This is that measurement
    // stated as a test: the record has to survive an arbitrarily long human
    // pause with no event at all.
    invoke();

    expect(state(NOW + 10 * 60_000)).toMatchObject({ spec: SPEC });
  });

  it('a repeated report of the same call does not reset it either', () => {
    invoke();
    record('pre_tool_use', 'AskUserQuestion', NOW + 1_000);
    recordAskUserQuestion('wt-1', 'claude', 'claude', SPEC, NOW + 1_000);

    expect(state(NOW + 1_000)).not.toBeNull();
  });
});

describe('the status this event implies (Issue #1726)', () => {
  it('PostToolUse is running too — a tool ending is not a turn ending', () => {
    expect(agentEventToSessionStatus('post_tool_use', 'AskUserQuestion')).toEqual({
      status: 'running',
      reason: HOOK_STATUS_REASON.POST_TOOL_USE,
    });
  });

  it('is running — a turn in progress, never waiting', () => {
    // Asserting `waiting` from the invocation would keep asserting it long after
    // a human answered in the terminal, because no event marks that. Whether the
    // picker is up stays the scraper's question.
    expect(agentEventToSessionStatus('pre_tool_use', 'AskUserQuestion')).toEqual({
      status: 'running',
      reason: HOOK_STATUS_REASON.PRE_TOOL_USE,
    });
  });

  it('does not let an AskUserQuestion erase its own turn’s running verdict', () => {
    // The concrete regression: `user_prompt_submit` says running, then the
    // invocation arrives and becomes the newest event. If it answered "no
    // verdict", a scraper that reads the picker as ready/no_recent_output — the
    // #1708 failure exactly — would let `commandmate wait` exit 0 with a dialog
    // on screen.
    expect(agentEventToSessionStatus('pre_tool_use', 'AskUserQuestion')?.status).toBe(
      agentEventToSessionStatus('user_prompt_submit', null)?.status,
    );
  });
});

describe('deduplication across tools (Issue #1726)', () => {
  it('does not collapse two different tool calls in the same second', () => {
    // The dedup key now carries the subtype. Without it, a `Bash` PreToolUse
    // followed by the `AskUserQuestion` one — ordinary inside the 3 s window —
    // would read as one delivery and the question would be dropped.
    expect(
      isDuplicateAgentEvent('wt-1', 'claude', 'claude', 'pre_tool_use', 'sess-1', NOW, 'Bash'),
    ).toBe(false);
    expect(
      isDuplicateAgentEvent(
        'wt-1',
        'claude',
        'claude',
        'pre_tool_use',
        'sess-1',
        NOW + 10,
        'AskUserQuestion',
      ),
    ).toBe(false);
  });

  it('still collapses two deliveries of the same call', () => {
    // The injected settings and a hand-configured hook from #1549 both fire.
    expect(
      isDuplicateAgentEvent('wt-1', 'claude', 'claude', 'stop', 'sess-1', NOW),
    ).toBe(false);
    expect(
      isDuplicateAgentEvent('wt-1', 'claude', 'claude', 'stop', 'sess-1', NOW + 10),
    ).toBe(true);
  });
});
