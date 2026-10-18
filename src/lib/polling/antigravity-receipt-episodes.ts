/**
 * When did an agy approval dialog first appear, and was it asked about in time?
 * (Issue #3767)
 *
 * `hasRecentAntigravityPermissionReceipt` measures the window to the CLOCK OF THE
 * TICK. agy draws a dialog some seconds after the hook reply, and the poller ticks
 * every 5s after a response, so a dialog drawn 5.9s after the receipt was first
 * read 8.7s after it, outside the 8s window, and no later receipt came to open
 * it. The gate here judges the window to the dialog's first appearance instead
 * (bounded by the last read that saw no dialog), which the poller makes possible
 * by bracketing its reads with {@link beginAntigravityFrameRead} /
 * {@link endAntigravityFrameRead}. See `antigravity-permission-receipts` for the
 * receipt record itself.
 *
 * @module lib/polling/antigravity-receipt-episodes
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import {
  ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
  getAntigravityPermissionReceiptAt,
  hasRecentAntigravityPermissionReceipt,
} from './antigravity-permission-receipts';

/**
 * Extra time past the window that the FIRST tick to see a dialog may be after
 * the receipt (Issue #3767). The dialog's real appearance is only known to lie
 * between the last tick that saw none and the first that saw it; that gap is a
 * poll interval (5s after a response), so the window is judged on the lower
 * bound and the first sighting is capped at window + this slack.
 */
export const ANTIGRAVITY_PERMISSION_RECEIPT_OBSERVATION_SLACK_MS = 5_000;

/**
 * Longest gap between two poller reads over which an episode is carried
 * (Issue #3767): the slowest tick (5s after a response) plus room for the
 * capture. A longer gap (capture backoff, no session, Auto-Yes off and on) means
 * nothing is known of the screen in between, so the episode is dropped and the
 * next candidate is judged from its own first sighting.
 */
const MAX_READ_GAP_MS = ANTIGRAVITY_PERMISSION_RECEIPT_OBSERVATION_SLACK_MS + 2_000;

/**
 * How long after the tick that accepted a receipt the answered dialog may stay
 * on screen before it is reported (Issue #3789): the window, the slack, and the
 * cooldown the poller waits after an answer. Until then a dialog still up is
 * agy taking its time to take the answer down, and stays `answered` (silent);
 * past it the answer did not take, or the dialog that replaced it has no
 * question of its own, and it is `outlived` — still not answered, but recorded.
 *
 * Written as the sum's value (8s + 5s + 5s, `COOLDOWN_INTERVAL_MS`), not the
 * sum: tests that mock the receipts module without the window constant would
 * fail at load. A unit test pins it to the sum.
 */
export const ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS = 18_000;

/** Beyond this, a late dialog is read as "the hook stopped arriving" (#3767). */
const RECEIPT_LAPSED_AFTER_MS = 60_000;

/** What the poller has seen of one instance's candidate dialog (Issue #3767). */
interface FrameObservation {
  /** True once the poller brackets its reads; only then does an episode persist. */
  tracking: boolean;
  /** The gate was consulted with a prompt candidate during the current read. */
  candidateSeen: boolean;
  /** Epoch ms of the first read of the current episode, null between episodes. */
  firstSeenAt: number | null;
  /** Epoch ms of the last read with no candidate before this episode, if any. */
  clearAt: number | null;
  /** Epoch ms the previous / the current poller read began. */
  prevReadAt: number | null;
  lastReadAt: number | null;
  /** Receipt (`at`) this episode was accepted on. */
  acceptedReceiptAt: number | null;
  /** Epoch ms of the read that accepted it (Issue #3789). */
  acceptedAt: number | null;
  /** Receipt (`at`) the most recent accepted episode used; one receipt, one dialog. */
  usedReceiptAt: number | null;
  /** The verdict of the current episode's latest consultation. */
  verdict: AntigravityReceiptVerdict | null;
}

/** Why the gate withheld (`ok` has none). */
export type AntigravityReceiptCause =
  /** No question from agy was ever received for this instance. */
  | 'never'
  /** The dialog was already on screen when the last question arrived. */
  | 'predates'
  /** The dialog appeared after the window closed; the last question was `ageMs` before it. */
  | 'late'
  /** The last question is long gone: the hook stopped arriving. */
  | 'lapsed'
  /** The question was already spent on an earlier dialog. */
  | 'used'
  /**
   * The dialog this question was already answered on is still up past the
   * window. Not "withheld for want of a receipt": no suppression is recorded.
   */
  | 'answered'
  /**
   * Issue #3789: the same, but still up {@link ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS}
   * after the answer — the answer did not take, or another dialog replaced it
   * without a question of its own. Withheld like `answered`, and recorded.
   */
  | 'outlived';

export interface AntigravityReceiptVerdict {
  ok: boolean;
  cause: AntigravityReceiptCause | null;
  /** Epoch ms of the latest question, kept past the window; null if none. */
  lastReceiptAt: number | null;
  /** Epoch ms the dialog was first read. */
  firstSeenAt: number;
  /** firstSeenAt - lastReceiptAt, when both exist. */
  ageMs: number | null;
}

const observations = getOrInitGlobal('__antigravityReceiptObservations', () => new Map<string, unknown>()) as Map<string, FrameObservation>;

const isTimeOrNull = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isFinite(x));

/**
 * The Map lives on globalThis and outlives a module reload, so an entry may have
 * another shape. Such an entry is dropped (no episode: the plain tick test),
 * never read as times — `undefined` would turn every comparison into NaN.
 */
function isObservation(v: unknown): v is FrameObservation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.tracking === 'boolean' &&
    typeof o.candidateSeen === 'boolean' &&
    (['firstSeenAt', 'clearAt', 'prevReadAt', 'lastReadAt', 'acceptedReceiptAt', 'acceptedAt', 'usedReceiptAt'] as const).every(k =>
      isTimeOrNull(o[k]),
    ) &&
    (o.verdict === null || typeof o.verdict === 'object')
  );
}

function existingObservation(key: string): FrameObservation | undefined {
  const o: unknown = observations.get(key);
  if (o === undefined) return undefined;
  if (isObservation(o)) return o;
  observations.delete(key);
  return undefined;
}

function observationOf(key: string): FrameObservation {
  let o = existingObservation(key);
  if (!o) {
    o = {
      tracking: false,
      candidateSeen: false,
      firstSeenAt: null,
      clearAt: null,
      prevReadAt: null,
      lastReadAt: null,
      acceptedReceiptAt: null,
      acceptedAt: null,
      usedReceiptAt: null,
      verdict: null,
    };
    observations.set(key, o);
  }
  return o;
}

/**
 * Start one poller read of an agy frame (Issue #3767). Pair with
 * {@link endAntigravityFrameRead}; the pair is what lets the gate judge the
 * window by when the dialog first appeared rather than by the tick's clock.
 */
export function beginAntigravityFrameRead(
  worktreeId: string,
  instanceId: string | undefined,
  now: number = Date.now(),
): void {
  const o = observationOf(buildCompositeKey(worktreeId, 'antigravity', instanceId));
  if (o.lastReadAt !== null && !(now - o.lastReadAt <= MAX_READ_GAP_MS)) {
    // Reads stopped for a while: the dialog now on screen may not be the one
    // the episode saw, nor did it appear right after the last clear read.
    o.firstSeenAt = null;
    o.clearAt = null;
    o.acceptedReceiptAt = null;
    o.acceptedAt = null;
    o.verdict = null;
  }
  o.tracking = true;
  o.candidateSeen = false;
  o.prevReadAt = o.lastReadAt;
  o.lastReadAt = now;
}

/**
 * End the read. A read in which the gate never saw a prompt candidate closes the
 * episode: the next candidate is a new dialog with its own first sighting.
 */
export function endAntigravityFrameRead(
  worktreeId: string,
  instanceId: string | undefined,
  now: number = Date.now(),
): void {
  const o = existingObservation(buildCompositeKey(worktreeId, 'antigravity', instanceId));
  if (!o || !o.tracking || o.candidateSeen) return;
  o.firstSeenAt = null;
  o.acceptedReceiptAt = null;
  o.acceptedAt = null;
  o.verdict = null;
  o.clearAt = now;
}

/**
 * The verdict of the current episode's latest consultation, or null when no
 * candidate dialog was read in the last tick (Issue #3767).
 */
export function getAntigravityReceiptVerdict(
  worktreeId: string,
  instanceId: string | undefined,
): AntigravityReceiptVerdict | null {
  return existingObservation(buildCompositeKey(worktreeId, 'antigravity', instanceId))?.verdict ?? null;
}

function causeFor(ageMs: number | null): AntigravityReceiptCause {
  if (ageMs === null) return 'never';
  return ageMs > RECEIPT_LAPSED_AFTER_MS ? 'lapsed' : 'late';
}

/**
 * May the prompt candidate on this instance's frame be answered, judged by when
 * the dialog first appeared (Issue #3767)?
 *
 * Replaces the tick-clock test of {@link hasRecentAntigravityPermissionReceipt}
 * for the caller that answers: agy draws the dialog some seconds after the hook
 * reply, and a 5s poll can first read it past the 8s window. The dialog is taken
 * as appearing at the later of the last tick that saw none and the question's
 * arrival. Still refused: a question that arrived after the dialog was already
 * up, one older than the window by then, one already spent on another dialog,
 * and none at all (a quotation follows no question).
 *
 * Without {@link beginAntigravityFrameRead} brackets there is no episode to
 * remember, and this is exactly the old tick test.
 */
export function judgeAntigravityPermissionReceipt(
  worktreeId: string,
  instanceId: string | undefined,
  nowOverride?: number,
): AntigravityReceiptVerdict {
  const now = nowOverride ?? Date.now();
  const key = buildCompositeKey(worktreeId, 'antigravity', instanceId);
  const o = observationOf(key);

  if (!o.tracking) {
    // No bracketed reads: no episode to remember, the plain tick test.
    const ok =
      nowOverride === undefined
        ? hasRecentAntigravityPermissionReceipt(worktreeId, 'antigravity', instanceId)
        : hasRecentAntigravityPermissionReceipt(worktreeId, 'antigravity', instanceId, undefined, nowOverride);
    return { ok, cause: ok ? null : 'never', lastReceiptAt: null, firstSeenAt: now, ageMs: null };
  }
  const lastReceiptAt = getAntigravityPermissionReceiptAt(worktreeId, 'antigravity', instanceId);

  const sameRead = o.candidateSeen;
  o.candidateSeen = true;
  if (o.firstSeenAt === null) o.firstSeenAt = now;
  const firstSeenAt = o.firstSeenAt;
  const ageMs = lastReceiptAt === null ? null : firstSeenAt - lastReceiptAt;
  const verdict = (
    cause: AntigravityReceiptCause | null,
    age: number | null = ageMs,
  ): AntigravityReceiptVerdict => {
    const v = { ok: cause === null, cause, lastReceiptAt, firstSeenAt, ageMs: age };
    o.verdict = v;
    return v;
  };

  if (lastReceiptAt === null) return verdict('never');
  if (o.acceptedReceiptAt !== null && lastReceiptAt > o.acceptedReceiptAt) {
    // A newer question while the answered dialog stayed up on every tick: the
    // dialog it asked about replaced the old one between two reads. A new
    // episode, which cannot have appeared before the previous read.
    o.firstSeenAt = now;
    o.clearAt = o.prevReadAt;
    o.acceptedReceiptAt = null;
    o.acceptedAt = null;
    return judgeAntigravityPermissionReceipt(worktreeId, instanceId, now);
  }
  if (o.acceptedReceiptAt === lastReceiptAt) {
    // The read that accepted may consult the gate twice (the tool's reader, then
    // the generic pass). A LATER tick over the same dialog is the old tick test:
    // a dialog that outlives the answer is not answered again past the window.
    // Withheld, but as `answered`: the caller records no no-hook-receipt for it.
    if (sameRead || now - lastReceiptAt <= ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS) return verdict(null);
    // Issue #3789: not forever, though. Past the grace the answer did not take
    // (or a dialog with no question of its own replaced it), and staying silent
    // would leave the session stopped with no record of why. Still withheld;
    // written as `!(… <= …)` so that a missing or NaN time reports.
    if (o.acceptedAt === null || !(now - o.acceptedAt <= ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS)) {
      return verdict('outlived');
    }
    return verdict('answered');
  }
  if (o.usedReceiptAt === lastReceiptAt) return verdict('used');
  if (lastReceiptAt > firstSeenAt) return verdict('predates');

  // The clear read bounds the appearance only when it is the read right before
  // the first sighting; otherwise the dialog may have been up since long before.
  const clearBound =
    o.clearAt !== null && firstSeenAt - o.clearAt <= MAX_READ_GAP_MS ? o.clearAt : firstSeenAt;
  const appearedAfter = Math.max(clearBound, lastReceiptAt);
  // Written as `!(… <= …)` so that a NaN withholds.
  if (
    !(appearedAfter - lastReceiptAt <= ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS) ||
    !(
      firstSeenAt - lastReceiptAt <=
      ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS + ANTIGRAVITY_PERMISSION_RECEIPT_OBSERVATION_SLACK_MS
    )
  ) {
    return verdict(causeFor(ageMs));
  }

  o.acceptedReceiptAt = lastReceiptAt;
  o.acceptedAt = now;
  o.usedReceiptAt = lastReceiptAt;
  return verdict(null);
}

