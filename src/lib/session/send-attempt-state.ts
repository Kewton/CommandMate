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
import { PASTE_NOT_STARTED_CODE, PLAN_REVIEW_SEND_REFUSED_CODE } from './send-attempt-types';
import type { LastSendAttempt, SendAttemptReason, SendAttemptState } from './send-attempt-types';

const logger = createLogger('session/send-attempt-state');

/** How many instances are tracked at once; the least recently sent to is forgotten first. */
const MAX_TRACKED_INSTANCES = 1024;

/** One recorded attempt. */
export interface SendAttemptRecord extends LastSendAttempt {
  reason: SendAttemptReason;
  /** SHA-256 (hex, first 16 chars) of the message body; the body itself is not kept. */
  messageDigest: string;
  /**
   * Issue #4048: the digest of the body actually typed, when the sender typed
   * something other than the message (an image reference appended). The
   * composer and the first-prompt receipt only know that body; the attempt is
   * matched by either digest. Absent when they are the same.
   */
  typedDigest?: string;
  /**
   * Issue #4048: the instance input generation the attempt ran under, when it
   * ran under the input lock. A record of a newer generation is never replaced
   * by an older one's late outcome.
   */
  inputGeneration?: number;
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
 *
 * Issue #4048: `typedContent` is the body the sender actually typed when it
 * differs from `content`; `inputGeneration` is the input lock generation the
 * attempt ran under. An attempt of an older generation than the held record's
 * is not recorded — the session was replaced and a newer send already said
 * how it went.
 */
export function recordSendAttempt(
  instance: SendAttemptInstance,
  attempt: {
    state: SendAttemptState;
    reason: SendAttemptReason;
    content: string;
    typedContent?: string;
    inputGeneration?: number;
  },
  now: number = Date.now()
): void {
  try {
    const key = keyOf(instance);
    const held = records.get(key);
    if (
      attempt.inputGeneration !== undefined &&
      held?.inputGeneration !== undefined &&
      held.inputGeneration > attempt.inputGeneration
    ) {
      logger.info('send-attempt-record-skipped-stale-generation', {
        generation: attempt.inputGeneration,
        heldGeneration: held.inputGeneration,
      });
      return;
    }
    const messageDigest = sendMessageDigest(attempt.content);
    const typedDigest =
      attempt.typedContent === undefined ? undefined : sendMessageDigest(attempt.typedContent);
    // Re-inserted, so the map's order is least recently sent to first.
    records.delete(key);
    records.set(key, {
      at: Math.floor(now),
      state: attempt.state,
      reason: attempt.reason,
      messageDigest,
      ...(typedDigest !== undefined && typedDigest !== messageDigest ? { typedDigest } : {}),
      ...(attempt.inputGeneration !== undefined ? { inputGeneration: attempt.inputGeneration } : {}),
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

/**
 * Turn the instance's last `sent` record `indeterminate` (Issue #4035): the
 * next send found that body still in the composer, so it never reached the
 * agent. Any other record is left as it is. Never throws.
 *
 * `messageDigest` (Issue #4048) is the digest of the body that was found (the
 * body typed, so it is matched against the record's `typedDigest` too): a
 * record of another attempt — a later send, or one whose body differs — is
 * left as it is. Omitted, the last `sent` record is demoted as before.
 */
export function markLastSendDiscarded(
  instance: SendAttemptInstance,
  now: number = Date.now(),
  messageDigest?: string
): void {
  try {
    const key = keyOf(instance);
    const record = records.get(key);
    if (record === undefined || record.state !== 'sent') return;
    if (
      messageDigest !== undefined &&
      record.messageDigest !== messageDigest &&
      record.typedDigest !== messageDigest
    ) {
      return;
    }
    records.set(key, { ...record, at: Math.floor(now), state: 'indeterminate', reason: 'found-in-composer' });
  } catch (error) {
    logger.warn('send-attempt-record-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Forget every record (tests). */
export function clearSendAttempts(): void {
  records.clear();
}

/**
 * The wordings of a failed tmux call that can carry the message body: `tmux.ts`
 * wraps the child_process error (`Command failed: tmux …argv…`) as
 * `Failed to send keys to tmux session: …` and the like (Issue #3880).
 */
const TMUX_TRANSPORT_FAILURE =
  /Command failed: tmux |Failed to send (?:special )?keys? to tmux session|Failed to send special key:|Failed to paste message into tmux session/;

/** How many `cause` links {@link carriesCode} follows: a tool's wrap is one. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Whether `error`, or an error it wraps (`cause`), carries `code`
 * (Issue #4031). The tools wrap the sender's error as
 * `Failed to send message to <tool>: …` with it as `cause`, so a code set
 * before the wrap is read here, not lost.
 */
function carriesCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  // #4040: opencode's keyboard fallback refused before any key (its cause says
  // why — a code like `paste-not-started` included), but the server dispatch
  // before it ended `unknown`: the message may already be there, so the attempt
  // as a whole stays unknown, never "safe to resend". Read FIRST, before any
  // code the cause carries.
  if (
    error instanceof Error &&
    /an earlier server dispatch may have delivered the message \(Issue #4040\)/.test(error.message)
  ) {
    return { state: 'indeterminate', reason: 'send-error' };
  }
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
  // Issue #4031: `load-buffer` failed, so `paste-buffer` never ran — read by
  // code through the tool's wrap, never by wording (a `paste-buffer` failure,
  // whose body may be on the pane, shares the transport wording below).
  if (carriesCode(error, PASTE_NOT_STARTED_CODE)) {
    return { state: 'not-sent', reason: 'paste-not-started' };
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
  // #4035: Enter sent, the composer did not show the body, and the agent did
  // not report the session's first prompt.
  if (/did not report the prompt within \d+ms \(Issue #4035\)/.test(message)) {
    return { state: 'indeterminate', reason: 'prompt-unreported' };
  }
  // #1471: typed, Enter sent (more than once), never confirmed.
  if (/submit could not be confirmed/i.test(message)) {
    return { state: 'indeterminate', reason: 'submit-unconfirmed' };
  }
  // Issue #3880 (N2): a failed tmux call quotes its argv — and the argv of a
  // literal send IS the body (`Command failed: tmux send-keys -t =s: -l -- <body>`).
  // Whether any of the body reached the pane is unknown, and the body's own words
  // (`Explain prompt not ready.`) must not be read as a readiness refusal below.
  // #3945: the re-read under the input lock failed before any key; it quotes the
  // capture's own error (`Command failed: tmux capture-pane …`, no body), so it
  // is matched before the transport wordings below.
  if (/Could not re-read session \S+ before typing \(.*\); nothing was typed \(Issue #3945\)/s.test(message)) {
    return { state: 'not-sent', reason: 'recheck-failed' };
  }
  if (TMUX_TRANSPORT_FAILURE.test(message)) return { state: 'indeterminate', reason: 'send-error' };
  // The readiness waits of every tool throw before typing anything.
  if (/prompt not ready/i.test(message)) return { state: 'not-sent', reason: 'prompt-not-ready' };
  // #3945: refused under (or before getting) the instance input lock, before any key.
  if (/input lock not acquired, nothing was typed/.test(message)) {
    return /was replaced while this send waited/.test(message)
      ? { state: 'not-sent', reason: 'session-replaced' }
      : { state: 'not-sent', reason: 'input-lock-timeout' };
  }
  if (/\(re-checked under the input lock\); nothing was typed/.test(message)) {
    return { state: 'not-sent', reason: 'prompt-waiting' };
  }
  if (/input lock lost, nothing was typed/.test(message)) return { state: 'not-sent', reason: 'input-lock-lost' };
  // #1880: refused before the body, after only the clear keys (C-e / C-u, or C-e / BSpace
  // for a codex composer holding only a paste placeholder, #3937).
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
