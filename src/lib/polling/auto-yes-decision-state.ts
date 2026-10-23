/**
 * Auto-Yes's decision about the confirmation on screen (Issue #3821).
 *
 * Written by the poller's tick (`detectAndRespondToPrompt`), which is where the
 * decision is actually made, and read by `buildCurrentOutput`, which publishes
 * it as `autoYesDecision` next to the prompt. The answer surfaces show their
 * panel under Auto-Yes for every decision but `answering`.
 *
 * ## What a record is tied to
 *
 * A record is published only while everything it was made under still holds:
 *
 * - the GRANT — the same `AutoYesState` object (`getAutoYesState` stores a new
 *   one on every enable and on expiry, as the tick's own generation check
 *   reads it, #3706), so turning Auto-Yes off and on again or letting it expire
 *   drops the old decision even with the same screen up;
 * - the SESSION epoch (`getEnterFallbackSessionEpoch`): a relaunch drops it;
 * - the SCREEN — {@link enterFallbackScreenKey} of the prompt it was made for,
 *   compared with the prompt the payload publishes (the key both readings of
 *   one screen share; the poller and the status API read different row counts);
 * - a TICK not long ago ({@link AUTO_YES_DECISION_STALE_MS}): a live poller
 *   re-decides every tick, so a record nobody refreshed says nothing now.
 *
 * Anything else — no record, another screen, an old grant — is `none`, never
 * `answering`. A human's answer through `/prompt-response` drops the record.
 *
 * Two confirmations with the same text in a row, with no frame without a
 * prompt between them, read as one screen here: nothing on the screen tells
 * them apart. The tick re-decides on its next pass either way.
 *
 * Not the confirmation ledger (#3820): the ledger measures, never decides, and
 * a failure in it changes nothing. This record is what the tick decided.
 *
 * In-memory and on `globalThis` for the reason `auto-yes-suppression-state`
 * gives: the poller writes it and the `current-output` route reads it, and
 * under `next dev` the two are bundled apart.
 *
 * @module lib/polling/auto-yes-decision-state
 */

import { filterCompositeKeysByWorktree, type AutoYesState } from '@/lib/auto-yes-state';
import type { PromptData } from '@/types/models';
import {
  SERVER_POLLER_INACTIVE_DECISION_REASON,
  type AutoYesDecisionPublished,
  type AutoYesDecisionReason,
} from '@/types/auto-yes-decision';
import { getOrInitGlobal } from '../global-state';
import { enterFallbackScreenKey, getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback-state';

/**
 * How long a record stays current without a tick refreshing it. The poller
 * ticks every couple of seconds and refreshes the record on each tick that
 * sees the screen; one past this is from a poller that is not ticking.
 */
export const AUTO_YES_DECISION_STALE_MS = 30_000;

/** The decision of one tick, as kept in memory. */
export interface AutoYesDecisionRecord {
  state: 'answering' | 'withheld';
  /** Set for `withheld`. */
  reason: AutoYesDecisionReason | null;
  /** {@link enterFallbackScreenKey} of the prompt the decision is about. */
  screenKey: string;
  /** The grant the tick acted under (compared by identity). */
  grant: AutoYesState | null;
  /** The session epoch the tick read under. */
  epoch: number;
  /** Epoch ms of the tick. */
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesDecisions: Map<string, AutoYesDecisionRecord> | undefined;
}

const decisions = getOrInitGlobal('__autoYesDecisions', () => new Map<string, AutoYesDecisionRecord>());

/** Record what the tick decided for the prompt on screen. */
export function recordAutoYesDecision(
  compositeKey: string,
  decision: {
    state: AutoYesDecisionRecord['state'];
    reason: AutoYesDecisionReason | null;
    promptData: PromptData;
    grant: AutoYesState | null;
    epoch: number;
  },
  at: number = Date.now(),
): void {
  decisions.set(compositeKey, {
    state: decision.state,
    reason: decision.state === 'withheld' ? decision.reason : null,
    screenKey: enterFallbackScreenKey(decision.promptData),
    grant: decision.grant,
    epoch: decision.epoch,
    at,
  });
}

/** The record as kept, or null. Test seam and diagnostics. */
export function getAutoYesDecisionRecord(compositeKey: string): AutoYesDecisionRecord | null {
  return decisions.get(compositeKey) ?? null;
}

/** Drop one instance's record: no prompt on screen, a human answered, the poller stopped. */
export function forgetAutoYesDecision(compositeKey: string): void {
  decisions.delete(compositeKey);
}

/** {@link forgetAutoYesDecision} for every instance of a worktree. */
export function forgetAutoYesDecisionsByWorktree(worktreeId: string): void {
  for (const key of filterCompositeKeysByWorktree([...decisions.keys()], worktreeId)) {
    decisions.delete(key);
  }
}

/** Drop every record: server shutdown, and a test seam. */
export function clearAutoYesDecisions(): void {
  decisions.clear();
}

/** What {@link publishAutoYesDecision} reads, all of it from the same payload. */
export interface AutoYesDecisionPublishInput {
  compositeKey: string;
  /** The grant as `getAutoYesState` returns it now. */
  grant: AutoYesState | null | undefined;
  /** The screen-read prompt the payload publishes, or null. */
  promptData: PromptData | null | undefined;
  /** Whether a server poller runs for the instance (`isPollerActive`). */
  pollerActive: boolean;
  now?: number;
}

/**
 * The decision published for the payload's prompt.
 *
 * - no screen prompt, or Auto-Yes off: `none`;
 * - Auto-Yes on with no poller for the instance: `withheld`
 *   (`server-poller-inactive`) — nothing answers the screen, whatever an
 *   earlier record said;
 * - a record made under this grant, session and screen, refreshed recently:
 *   that record;
 * - otherwise `none`.
 */
export function publishAutoYesDecision(input: AutoYesDecisionPublishInput): AutoYesDecisionPublished {
  const now = input.now ?? Date.now();
  const none: AutoYesDecisionPublished = { state: 'none', reason: null, observedAt: now };
  const { compositeKey, grant, promptData } = input;
  if (promptData == null || !grant?.enabled) return none;
  if (!input.pollerActive) {
    return { state: 'withheld', reason: SERVER_POLLER_INACTIVE_DECISION_REASON, observedAt: now };
  }
  const record = decisions.get(compositeKey);
  if (
    record === undefined ||
    record.grant !== grant ||
    record.epoch !== getEnterFallbackSessionEpoch(compositeKey) ||
    record.screenKey !== enterFallbackScreenKey(promptData) ||
    now - record.at > AUTO_YES_DECISION_STALE_MS
  ) {
    return none;
  }
  return { state: record.state, reason: record.reason, observedAt: now };
}
