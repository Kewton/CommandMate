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
 * - the CONFIRMATION ({@link matchesConfirmation}): the question and the
 *   options ({@link enterFallbackScreenKey}), AND what is being approved — the
 *   rows of `approvalTarget` nearest the question, which the poller and the
 *   status API both read whatever their row counts (one reading's rows are a
 *   tail of the other's) — AND, for agy, the hook call the receipt was accepted
 *   for. Two approvals that differ only in their target (agy's file creation
 *   names the file only there) are two confirmations; one whose target or call
 *   cannot be confirmed reads `none`;
 * - a TICK not long ago ({@link AUTO_YES_DECISION_STALE_MS}): a live poller
 *   re-decides every tick, so a record nobody refreshed says nothing now.
 *
 * Anything else — no record, another confirmation, an old grant — is `none`,
 * never `answering`. A human's answer through `/prompt-response` drops the
 * record (`./auto-yes-manual-answer`).
 *
 * Two confirmations identical in every part above, in a row, with no frame
 * without a prompt between them, read as one here: nothing on the screen tells
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
  /** {@link approvalTargetRows} of the prompt the decision is about. */
  targetRows: readonly string[];
  /** agy: the hook call the receipt on screen was accepted for, when known. */
  callId: string | null;
  /** The grant the tick acted under (compared by identity). */
  grant: AutoYesState | null;
  /** The session epoch the tick read under. */
  epoch: number;
  /** Epoch ms of the tick. */
  at: number;
}

/** What identifies a confirmation, as {@link matchesConfirmation} compares it. */
export interface AutoYesConfirmationIdentity {
  promptData: PromptData;
  /** agy: the accepted hook call (`getAntigravityAcceptedReceiptCallId`), else null / absent. */
  callId?: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesDecisions: Map<string, AutoYesDecisionRecord> | undefined;
}

const decisions = getOrInitGlobal('__autoYesDecisions', () => new Map<string, AutoYesDecisionRecord>());

/** A selection cursor at the start of a row (`>` agy, `❯` claude, `›` codex). */
const CURSOR_GLYPH = /^[>❯›]\s*/;

/**
 * The non-empty rows of `approvalTarget`, trimmed, without a leading cursor
 * glyph (the cursor moving is the same confirmation). The rows nearest the
 * question come last, and those are the ones every reading of the screen
 * keeps: a reading of fewer rows cuts the target from the top.
 */
export function approvalTargetRows(promptData: PromptData): string[] {
  const target = promptData.approvalTarget;
  if (typeof target !== 'string') return [];
  return target
    .split('\n')
    .map((row) => row.trim().replace(CURSOR_GLYPH, '').trim())
    .filter((row) => row !== '');
}

/** Is the shorter of the two a tail of the longer? Both empty matches; one empty does not. */
function sameTargetTail(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const offset = longer.length - shorter.length;
  return shorter.every((row, i) => row === longer[offset + i]);
}

/**
 * Is `record` about the confirmation `identity` describes? Question and
 * options equal, the approval targets one a tail of the other, and — when the
 * record was tied to an agy call — the same call known now.
 */
export function matchesConfirmation(record: AutoYesDecisionRecord, identity: AutoYesConfirmationIdentity): boolean {
  if (record.screenKey !== enterFallbackScreenKey(identity.promptData)) return false;
  if (!sameTargetTail(record.targetRows, approvalTargetRows(identity.promptData))) return false;
  if (record.callId !== null && record.callId !== (identity.callId ?? null)) return false;
  return true;
}

/** Record what the tick decided for the prompt on screen. */
export function recordAutoYesDecision(
  compositeKey: string,
  decision: {
    state: AutoYesDecisionRecord['state'];
    reason: AutoYesDecisionReason | null;
    promptData: PromptData;
    callId?: string | null;
    grant: AutoYesState | null;
    epoch: number;
  },
  at: number = Date.now(),
): void {
  decisions.set(compositeKey, {
    state: decision.state,
    reason: decision.state === 'withheld' ? decision.reason : null,
    screenKey: enterFallbackScreenKey(decision.promptData),
    targetRows: approvalTargetRows(decision.promptData),
    callId: decision.callId ?? null,
    grant: decision.grant,
    epoch: decision.epoch,
    at,
  });
}

/**
 * Issue #3821 (review 2): the duplicate guard (#306) says "answered less than
 * `DUPLICATE_RETRY_EXPIRY_MS` ago", comparing only the type and the question.
 * That is not evidence the confirmation on screen is the one answered, so the
 * `answering` record is only kept — its time moved on — when it is the one
 * this tick's send made: about this very confirmation, under the same grant
 * and session. Otherwise the record is dropped (`none`).
 *
 * @returns Whether `answering` still stands
 */
export function reaffirmAutoYesAnswering(
  compositeKey: string,
  tick: AutoYesConfirmationIdentity & { grant: AutoYesState | null; epoch: number },
  at: number = Date.now(),
): boolean {
  const record = decisions.get(compositeKey);
  if (
    record === undefined ||
    record.state !== 'answering' ||
    record.grant !== tick.grant ||
    record.epoch !== tick.epoch ||
    !matchesConfirmation(record, tick)
  ) {
    decisions.delete(compositeKey);
    return false;
  }
  decisions.set(compositeKey, { ...record, at });
  return true;
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
  /** agy: the hook call the receipt is accepted for now, else null / absent. */
  callId?: string | null;
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
 * - a record made under this grant and session, about this confirmation
 *   ({@link matchesConfirmation}), refreshed recently: that record;
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
    !matchesConfirmation(record, { promptData, callId: input.callId }) ||
    now - record.at > AUTO_YES_DECISION_STALE_MS
  ) {
    return none;
  }
  return { state: record.state, reason: record.reason, observedAt: now };
}
