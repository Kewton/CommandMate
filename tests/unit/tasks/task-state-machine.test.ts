/**
 * TaskStatus state machine (Issue #1548, Phase 3-1).
 *
 * The expected transitions are written out below as a literal table, not
 * derived from the implementation. A test that computes its expectation the way
 * the code does passes for any consistent set of rules, including wrong ones.
 *
 * Every cell of TASK_STATUSES × TASK_EVENTS is asserted — the rejections as
 * explicitly as the acceptances, since "this event does nothing here" is a rule
 * that can regress just as quietly as "this event moves the task there". A
 * completeness check below fails if the table stops covering the full product,
 * so adding a status or an event cannot leave silently untested cells.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { ACTIVE_TASK_STATUSES, TASK_STATUSES, TERMINAL_TASK_STATUSES, type TaskStatus } from '@/lib/db';
// Past the barrel, as tests/unit/db/tasks-db.test.ts does: the resolution set a
// verification run discovers its own task with is deliberately not re-exported.
import { VERIFIABLE_TASK_STATUSES } from '@/lib/db/tasks-db';
import {
  transitionTask,
  TASK_EVENTS,
  type TaskEvent,
} from '@/lib/tasks/task-state-machine';

/** `null` = the event does not apply and the task must not move. */
type Row = Record<TaskEvent, TaskStatus | null>;

/** Every event rejected; rows below override only what they accept. */
function rejectAll(): Row {
  return {
    message_sent: null,
    send_failed: null,
    prompt_detected: null,
    prompt_answered_auto: null,
    prompt_answered_human: null,
    agent_idle: null,
    verify_started: null,
    verify_passed: null,
    verify_failed: null,
    verify_not_started: null,
    cancel: null,
  };
}

const EXPECTED: Record<TaskStatus, Row> = {
  pending: {
    ...rejectAll(),
    message_sent: 'running',
    // Issue #1637: a first send that never landed closes the task instead of
    // failing it, so the orphan cannot be resolved as a later run's contract.
    // See the dedicated describe block at the bottom of this file.
    send_failed: 'cancelled',
    cancel: 'cancelled',
  },
  running: {
    ...rejectAll(),
    prompt_detected: 'waiting_input',
    // Held, not advanced: going quiet is not a verdict.
    agent_idle: 'running',
    verify_started: 'verifying',
    send_failed: 'failed',
    cancel: 'cancelled',
  },
  waiting_input: {
    ...rejectAll(),
    prompt_answered_auto: 'running',
    prompt_answered_human: 'running',
    agent_idle: 'running',
    verify_started: 'verifying',
    cancel: 'cancelled',
  },
  verifying: {
    ...rejectAll(),
    verify_passed: 'succeeded',
    verify_failed: 'failed',
    verify_not_started: 'not_started',
    cancel: 'cancelled',
  },
  failed: {
    ...rejectAll(),
    // The fix loop: re-instructing reopens the same task.
    message_sent: 'running',
    verify_started: 'verifying',
    cancel: 'cancelled',
  },
  not_started: {
    ...rejectAll(),
    message_sent: 'running',
    verify_started: 'verifying',
    cancel: 'cancelled',
  },
  succeeded: rejectAll(),
  cancelled: rejectAll(),
};

describe('transitionTask — the table is complete', () => {
  it('covers every status and every event exactly once', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...TASK_STATUSES].sort());
    for (const status of TASK_STATUSES) {
      expect(Object.keys(EXPECTED[status]).sort()).toEqual([...TASK_EVENTS].sort());
    }
    expect(TASK_STATUSES.length * TASK_EVENTS.length).toBe(8 * 11);
  });

  it('asserts more than "everything is rejected"', () => {
    // Guards the rejectAll() spread: an EXPECTED table that lost its overrides
    // would still match a transitionTask() that always returned null.
    const accepted = TASK_STATUSES.flatMap((status) =>
      TASK_EVENTS.filter((event) => EXPECTED[status][event] !== null)
    );
    // pending 3, running 5, waiting_input 5, verifying 4, failed 3, not_started 3.
    expect(accepted.length).toBe(23);
  });
});

describe('transitionTask — accepted transitions', () => {
  for (const status of TASK_STATUSES) {
    for (const event of TASK_EVENTS) {
      const expected = EXPECTED[status][event];
      if (expected === null) continue;

      it(`${status} + ${event} -> ${expected}`, () => {
        expect(transitionTask(status, event)).toBe(expected);
      });
    }
  }
});

describe('transitionTask — rejected transitions', () => {
  for (const status of TASK_STATUSES) {
    for (const event of TASK_EVENTS) {
      if (EXPECTED[status][event] !== null) continue;

      it(`${status} + ${event} is refused`, () => {
        expect(transitionTask(status, event)).toBeNull();
      });
    }
  }
});

describe('transitionTask — the invariants behind the table', () => {
  it('refuses every event once a task is succeeded or cancelled', () => {
    for (const status of ['succeeded', 'cancelled'] as const) {
      for (const event of TASK_EVENTS) {
        expect(transitionTask(status, event)).toBeNull();
      }
    }
  });

  it('lets cancel close any task that is not already closed', () => {
    const cancellable = TASK_STATUSES.filter(
      (status) => status !== 'succeeded' && status !== 'cancelled'
    );
    expect(cancellable.length).toBe(6);
    for (const status of cancellable) {
      expect(transitionTask(status, 'cancel')).toBe('cancelled');
    }
  });

  it('produces a verdict only out of verifying', () => {
    const verdicts = ['verify_passed', 'verify_failed', 'verify_not_started'] as const;
    for (const status of TASK_STATUSES) {
      for (const event of verdicts) {
        if (status === 'verifying') {
          expect(transitionTask(status, event)).not.toBeNull();
        } else {
          expect(transitionTask(status, event)).toBeNull();
        }
      }
    }
  });

  it('never reaches succeeded except by verify_passed', () => {
    for (const status of TASK_STATUSES) {
      for (const event of TASK_EVENTS) {
        if (transitionTask(status, event) === 'succeeded') {
          expect(event).toBe('verify_passed');
          expect(status).toBe('verifying');
        }
      }
    }
  });

  it('is a function of (status, event) alone', () => {
    // No hidden state: the same pair answers the same way however often it is
    // asked, which is what lets a rejected event be retried safely.
    for (const status of TASK_STATUSES) {
      for (const event of TASK_EVENTS) {
        const first = transitionTask(status, event);
        expect(transitionTask(status, event)).toBe(first);
        expect(transitionTask(status, event)).toBe(first);
      }
    }
  });
});

/**
 * Issue #1637: a `--contract` send that never reached the agent leaves a task
 * row behind, and that row used to be the one a later verification run picked
 * up when it had to discover its own contract.
 *
 * The PM decision recorded on the Issue is: keep the row (audit trail), close
 * it as soon as the send fails, and keep it out of subsequent scope resolution.
 * The three assertions below are that decision, split into its parts, plus the
 * counter-case that must NOT change — `failed` stays re-openable, because that
 * is what lets an agent retry after a red gate (#1620).
 *
 * These are properties of the *pair* (state machine, resolution sets), so they
 * are asserted against VERIFIABLE_TASK_STATUSES rather than against the literal
 * `'cancelled'`: widening that set later must fail here rather than silently
 * reopen the path this closes.
 */
describe('send_failed — orphan contract tasks (Issue #1637)', () => {
  const firstSendFailed = transitionTask('pending', 'send_failed');
  const laterSendFailed = transitionTask('running', 'send_failed');

  it('closes the task instead of leaving it pending', () => {
    expect(firstSendFailed).not.toBeNull();
    expect(TERMINAL_TASK_STATUSES).toContain(firstSendFailed as TaskStatus);
  });

  it('keeps the orphan out of the set a verification run resolves from', () => {
    // The bug: `getVerifiableTask` takes the most recently updated row in this
    // set, so an orphan outranked the real (already `succeeded`) task and the
    // run was judged against the orphan's older scope snapshot — #1623 exit 20.
    expect(VERIFIABLE_TASK_STATUSES).not.toContain(firstSendFailed as TaskStatus);
    expect(ACTIVE_TASK_STATUSES).not.toContain(firstSendFailed as TaskStatus);
  });

  it('leaves the row addressable rather than deleting it', () => {
    // Nothing here removes rows; what the state machine has to guarantee is
    // that the closed status is genuinely final, so the audit entry cannot be
    // walked back by a later event.
    for (const event of TASK_EVENTS) {
      expect(transitionTask(firstSendFailed as TaskStatus, event)).toBeNull();
    }
  });

  it('still fails — and reopens — a send that failed after work had started', () => {
    // A follow-up message to an agent that is already working is a different
    // situation: real work exists, so the task must stay re-judgeable.
    expect(laterSendFailed).toBe('failed');
    expect(VERIFIABLE_TASK_STATUSES).toContain(laterSendFailed as TaskStatus);
    expect(transitionTask('failed', 'verify_started')).toBe('verifying');
    expect(transitionTask('failed', 'message_sent')).toBe('running');
  });

  it('distinguishes the two by origin, not by event', () => {
    // Guards against "collapse both back to one status" refactors.
    expect(firstSendFailed).not.toBe(laterSendFailed);
  });
});
