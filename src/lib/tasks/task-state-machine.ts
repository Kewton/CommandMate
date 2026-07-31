/**
 * TaskStatus state machine (Issue #1548, Phase 3-1).
 *
 * Pure and side-effect free: given a status and an event, it answers what the
 * status becomes, or `null` when the event does not apply. Phase 2-1 let each
 * firing point decide the next status for itself, which meant the rules lived in
 * six places and agreed with each other only by coincidence. They live here now,
 * and `applyTaskEvent` is the only thing allowed to act on the answer.
 *
 * This is a different layer from `SessionStatus`. SessionStatus is derived from
 * screen-scraped terminal output — low level, volatile, recomputed every poll.
 * TaskStatus is durable and only moves because something *happened*. A
 * SessionStatus reading is at most one of the events that can cause a move; it
 * never writes TaskStatus itself.
 *
 * Rejection is not an error. A prompt detected while a verification run is in
 * flight is an ordinary race, not a bug, so `transitionTask` returns `null` and
 * the caller records the attempt and moves on. Throwing would turn a race into
 * a crashed poller.
 *
 * @module lib/tasks/task-state-machine
 */

import type { TaskStatus } from '@/lib/db';

/**
 * Something that happened to a task.
 *
 * `send_failed` is not in the Issue #1548 event table. It is here because the
 * behaviour it covers already shipped in Phase 2-1: `commandmate send
 * --contract` reports `failed` when the message could not be delivered
 * (`src/cli/commands/send.ts`), so that a task nothing is working on does not
 * sit in `pending` forever. With the direct status writes closed off, dropping
 * it would have deleted that behaviour rather than migrating it.
 *
 * `prompt_answered_auto` and `prompt_answered_human` share a target status and
 * differ only in who answered — which is the whole point, since Phase 4 Eval
 * counts human interventions.
 */
export type TaskEvent =
  | 'message_sent'
  | 'send_failed'
  | 'prompt_detected'
  | 'prompt_answered_auto'
  | 'prompt_answered_human'
  | 'agent_idle'
  | 'verify_started'
  | 'verify_passed'
  | 'verify_failed'
  | 'verify_not_started'
  | 'cancel';

export const TASK_EVENTS = [
  'message_sent',
  'send_failed',
  'prompt_detected',
  'prompt_answered_auto',
  'prompt_answered_human',
  'agent_idle',
  'verify_started',
  'verify_passed',
  'verify_failed',
  'verify_not_started',
  'cancel',
] as const satisfies readonly TaskEvent[];

/**
 * The status `current` becomes when `event` happens, or `null` if it does not
 * apply.
 *
 * Both switches are exhaustive by `satisfies never`, so adding a TaskStatus or a
 * TaskEvent fails the build here instead of silently defaulting to "rejected" —
 * a new event that quietly transitions nothing is indistinguishable from one
 * that is wired up wrong.
 */
export function transitionTask(current: TaskStatus, event: TaskEvent): TaskStatus | null {
  switch (current) {
    case 'pending':
      // Nothing has been sent yet, so nothing about the agent's behaviour can
      // be true of this task.
      switch (event) {
        case 'message_sent':
          return 'running';
        case 'send_failed':
          return 'failed';
        case 'cancel':
          return 'cancelled';
        case 'prompt_detected':
        case 'prompt_answered_auto':
        case 'prompt_answered_human':
        case 'agent_idle':
        case 'verify_started':
        case 'verify_passed':
        case 'verify_failed':
        case 'verify_not_started':
          return null;
        default:
          return assertNever(event);
      }

    case 'running':
      switch (event) {
        case 'prompt_detected':
          return 'waiting_input';
        // The agent going quiet without a verification run is not a verdict.
        // The status is held and only the event is recorded, so "it stopped
        // producing output" stays visible without being mistaken for "done".
        case 'agent_idle':
          return 'running';
        case 'verify_started':
          return 'verifying';
        case 'send_failed':
          return 'failed';
        case 'cancel':
          return 'cancelled';
        case 'message_sent':
        case 'prompt_answered_auto':
        case 'prompt_answered_human':
        case 'verify_passed':
        case 'verify_failed':
        case 'verify_not_started':
          return null;
        default:
          return assertNever(event);
      }

    case 'waiting_input':
      switch (event) {
        case 'prompt_answered_auto':
        case 'prompt_answered_human':
          return 'running';
        case 'agent_idle':
          return 'running';
        case 'verify_started':
          return 'verifying';
        case 'cancel':
          return 'cancelled';
        case 'message_sent':
        case 'send_failed':
        case 'prompt_detected':
        case 'verify_passed':
        case 'verify_failed':
        case 'verify_not_started':
          return null;
        default:
          return assertNever(event);
      }

    case 'verifying':
      // A run is in flight. Only that run's verdict — or an explicit cancel —
      // moves the task, so a prompt or a send racing the gates cannot overwrite
      // the outcome the gates are about to produce.
      switch (event) {
        case 'verify_passed':
          return 'succeeded';
        case 'verify_failed':
          return 'failed';
        case 'verify_not_started':
          return 'not_started';
        case 'cancel':
          return 'cancelled';
        case 'message_sent':
        case 'send_failed':
        case 'prompt_detected':
        case 'prompt_answered_auto':
        case 'prompt_answered_human':
        case 'agent_idle':
        case 'verify_started':
          return null;
        default:
          return assertNever(event);
      }

    case 'failed':
    case 'not_started':
      // Not the end of the story. Re-instructing an agent whose work did not
      // pass reopens the same task, and the number of times that happens is the
      // fix-loop count Phase 4 Eval reports. Re-running the gates alone reopens
      // it too — a task can fail on a flaky gate and pass on the retry.
      switch (event) {
        case 'message_sent':
          return 'running';
        case 'verify_started':
          return 'verifying';
        case 'cancel':
          return 'cancelled';
        case 'send_failed':
        case 'prompt_detected':
        case 'prompt_answered_auto':
        case 'prompt_answered_human':
        case 'agent_idle':
        case 'verify_passed':
        case 'verify_failed':
        case 'verify_not_started':
          return null;
        default:
          return assertNever(event);
      }

    case 'succeeded':
    case 'cancelled':
      // Closed for good. `succeeded` in particular is a verdict a verification
      // run produced; letting any later event walk it back would make "this
      // task passed" a claim with no fixed meaning.
      return null;

    default:
      return assertNever(current);
  }
}

/** Compile-time exhaustiveness guard; unreachable at runtime. */
function assertNever(value: never): null {
  const _exhaustive: never = value;
  void _exhaustive;
  return null;
}
