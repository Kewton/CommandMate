/**
 * The last send attempt per instance (Issue #3759).
 *
 * When the first message of a session did not arrive (#3746:
 * `Antigravity prompt not ready`), nothing said whether it was still to be
 * sent, already on the pane, or somewhere in between. This module keeps, per
 * (worktree, tool, instance), how the last {@link sendUserMessage} attempt
 * ended — `not-sent` / `sent` / `indeterminate` (`./send-attempt-types`) — and
 * `prompt --json` publishes it as `lastSend`.
 *
 * The record carries a digest of the message, never the message: it says which
 * message the state is about without keeping what was written.
 *
 * Nothing here resends. The sender (a person, or the supervising agent) decides,
 * and an `indeterminate` message is not to be resent before looking at the pane.
 *
 * In memory on `globalThis` (the send route and the observing route are bundled
 * apart under `next dev`), bounded; a restart forgets every record, which
 * publishes as "no record", never as a state.
 *
 * Recording must never change a send's outcome: {@link recordSendAttempt}
 * swallows its own failures.
 *
 * @module lib/session/send-attempt-state
 */

import { createHash } from 'crypto';
import { getOrInitGlobal } from '@/lib/global-state';
import { createLogger } from '@/lib/logger';
import { SESSION_STARTING_CODE } from '@/lib/session/session-start-error';
import { PLAN_REVIEW_SEND_REFUSED_CODE } from './send-attempt-types';
import type { LastSendAttempt, SendAttemptReason, SendAttemptState } from './send-attempt-types';

const logger = createLogger('session/send-attempt-state');

/** How many instances are tracked at once; the least recently sent to is forgotten first. */
const MAX_TRACKED_INSTANCES = 1024;

/** One recorded attempt. */
export interface SendAttemptRecord extends LastSendAttempt {
  reason: SendAttemptReason;
  /** SHA-256 (hex, first 16 chars) of the message body; the body itself is not kept. */
  messageDigest: string;
}

/** The instance an attempt belongs to. */
export interface SendAttemptInstance {
  worktreeId: string;
  cliToolId: string;
  /** The resolved instance id; the primary's is its tool id. */
  instanceId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __sendAttemptRecords: Map<string, SendAttemptRecord> | undefined;
}

const records = getOrInitGlobal('__sendAttemptRecords', () => new Map<string, SendAttemptRecord>());

function keyOf(instance: SendAttemptInstance): string {
  return JSON.stringify([instance.worktreeId, instance.cliToolId, instance.instanceId]);
}

/** The digest a record carries for `content`. */
export function sendMessageDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Record how a send attempt ended. Never throws: a record that cannot be made
 * leaves the send exactly as it was.
 */
export function recordSendAttempt(
  instance: SendAttemptInstance,
  attempt: { state: SendAttemptState; reason: SendAttemptReason; content: string },
  now: number = Date.now()
): void {
  try {
    const key = keyOf(instance);
    // Re-inserted, so the map's order is least recently sent to first.
    records.delete(key);
    records.set(key, {
      at: Math.floor(now),
      state: attempt.state,
      reason: attempt.reason,
      messageDigest: sendMessageDigest(attempt.content),
    });
    while (records.size > MAX_TRACKED_INSTANCES) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  } catch (error) {
    logger.warn('send-attempt-record-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** The instance's last recorded attempt, or null when none is held. */
export function getLastSendAttempt(instance: SendAttemptInstance): SendAttemptRecord | null {
  return records.get(keyOf(instance)) ?? null;
}

/** Forget every record (tests). */
export function clearSendAttempts(): void {
  records.clear();
}

/**
 * Where a failed `ICLITool.sendMessage` stopped, read from its error.
 *
 * Only failures whose wording says the body was never typed are `not-sent`;
 * every other failure is `indeterminate`, because "we do not know" must never
 * read as "safe to resend". The tools wrap these messages
 * (`Failed to send message to <tool>: …`), so they are matched anywhere in it.
 */
export function classifySendFailure(error: unknown): { state: SendAttemptState; reason: SendAttemptReason } {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === SESSION_STARTING_CODE
  ) {
    return { state: 'not-sent', reason: 'session-starting' };
  }
  // #3772: the plan review overlay refused the send before the body was typed.
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PLAN_REVIEW_SEND_REFUSED_CODE
  ) {
    return { state: 'not-sent', reason: 'plan-review' };
  }
  const message = error instanceof Error ? error.message : String(error);
  // Issue #3880: the "after the body was typed" wordings are matched FIRST. A
  // body-not-landed error quotes what the composer shows — the user's own text —
  // and a body that says `prompt not ready` must not turn "may have been typed"
  // into "was not typed". Indeterminate wins whenever its wording is present.
  // #2464 / #3366: typed, never submitted, taken back out best-effort.
  if (/Enter was not pressed, so nothing was submitted/.test(message)) {
    return { state: 'indeterminate', reason: 'body-not-landed' };
  }
  // #1501: the input line was cleared best-effort.
  if (/replaced by a TUI autocompletion/.test(message)) {
    return { state: 'indeterminate', reason: 'replaced-by-completion' };
  }
  // #1471: typed, Enter sent (more than once), never confirmed.
  if (/submit could not be confirmed/i.test(message)) {
    return { state: 'indeterminate', reason: 'submit-unconfirmed' };
  }
  // The readiness waits of every tool throw before typing anything.
  if (/prompt not ready/i.test(message)) return { state: 'not-sent', reason: 'prompt-not-ready' };
  // #1880: refused before the body, after only the clear keys (C-e / C-u).
  if (/still holds unsent text after \d+ clear passes/.test(message)) {
    return { state: 'not-sent', reason: 'composer-not-empty' };
  }
  return { state: 'indeterminate', reason: 'send-error' };
}

/** The whitespace-free form two renderings of one text share. */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Whether a composer read (`extractComposerText(...).text`) still holds the
 * message: its compacted text contains the compacted start of the message's
 * first non-blank line. Only the start, because a long body is cut by the
 * reader and wrapped by the TUI.
 */
export function composerHoldsMessage(composerText: string, content: string): boolean {
  const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
  const needle = compact(firstLine).slice(0, 32);
  return needle !== '' && compact(composerText).includes(needle);
}

/** One line for a failed send's error: what state the message is in, and who resends it. */
export function describeSendAttemptState(attempt: { state: SendAttemptState; reason: string }): string {
  if (attempt.state === 'not-sent') {
    return (
      `[send state: not-sent (${attempt.reason}): the message was not typed. ` +
      'CommandMate does not resend it; send it again once the input prompt is back ' +
      '(`commandmate prompt <worktree-id> --json` shows the screen and lastSend).]'
    );
  }
  if (attempt.state === 'indeterminate') {
    return (
      `[send state: indeterminate (${attempt.reason}): part of the message may have been typed or submitted. ` +
      'CommandMate does not resend it; do not resend before checking the pane ' +
      '(`commandmate capture <worktree-id> --pane`), or it may arrive twice.]'
    );
  }
  return `[send state: sent (${attempt.reason})]`;
}
