/**
 * Auto-Yes poller state and its once-per-frame WARN (Issue #3411).
 *
 * Moved out of auto-yes-poller.ts unchanged; the poller re-exports
 * `AutoYesPollerState`. Must not import auto-yes-poller.ts (cycle).
 */

import type { CLIToolType } from '../cli-tools/types';
import type { PromptData } from '@/types/models';
import { generatePromptKey } from '../detection/prompt-key';
import { createLogger } from '@/lib/logger';
import { filterCompositeKeysByWorktree } from '../auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import { getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback-state';

const logger = createLogger('auto-yes-poller');

/** Poller state for a worktree/agent (Issue #138, #525, #896) */
export interface AutoYesPollerState {
  /** setTimeout ID */
  timerId: ReturnType<typeof setTimeout> | null;
  /** CLI tool ID being polled */
  cliToolId: CLIToolType;
  /** Agent instance ID being polled (Issue #896; equals cliToolId for the primary instance) */
  instanceId: string;
  /** Consecutive error count */
  consecutiveErrors: number;
  /** Current polling interval (with backoff applied) */
  currentInterval: number;
  /** Last server-side response timestamp */
  lastServerResponseTimestamp: number | null;
  /**
   * Issue #3791: epoch ms the pending tick is due at, set only while that tick
   * is the session wait's (`MAX_BACKOFF_MS` after a capture found no session).
   * That is the one tick past `AUTO_YES_ANSWER_GRACE_MS` that still answers: a
   * session started meanwhile gets its first prompt answered on it. The push
   * gate reads it (off `globalThis`) to hold a wait until then. An error
   * backoff does not set it — a poller failing in a row is the case a human
   * should hear about at the usual time. Optional so hand-built states need not
   * name it.
   */
  sessionWaitTickAt?: number;
  /** Last answered prompt key for duplicate prevention (Issue #306) */
  lastAnsweredPromptKey: string | null;
  /** Timestamp when lastAnsweredPromptKey was set (for retry expiry) */
  lastAnsweredAt: number | null;
  /** Baseline output length for stop condition delta check (Issue #314 fix) */
  stopCheckBaselineLength: number;
  /**
   * Issue #2995: key of the frame the last "Auto-Yes did not answer" WARN was
   * printed for. Optional so hand-built states (tests) need not name it.
   */
  lastSkipWarnKey?: string | null;
  /**
   * Issue #3329: the last poll found no session to answer for. Logged once on
   * each change, not on every poll. Optional so hand-built states need not name it.
   */
  waitingForSession?: boolean;
  /**
   * Issue #3397: `promptFrameKey` of the screen Auto-Yes last sent its Enter
   * to. Kept until an Enter goes to another screen — not cleared by a tick with
   * no prompt — so the same screen coming back is never sent a second Enter
   * (a repaint between two ticks would otherwise look like a new screen).
   */
  enterFallbackSentKey?: string | null;
  /**
   * Issue #3397: `promptFrameKey` of the screen the previous tick found
   * eligible for the Enter. The Enter goes only to a screen seen eligible on two
   * ticks in a row, so a frame caught mid-repaint (#2457's reply before its
   * footer was redrawn reads `no_composer`) never gets one.
   */
  enterFallbackCandidateKey?: string | null;
  /**
   * Issue #3397: the session epoch (`getEnterFallbackSessionEpoch`) the two keys
   * above belong to. `beginAgentSession` moves it on when a new process is
   * created for this instance without the poller being stopped (a relaunch);
   * the keys of the previous process's screens are then dropped, so the new
   * process's identical dialog is not taken for the one that had its Enter.
   */
  enterFallbackEpoch?: number;
}

/**
 * Issue #2995: what makes two ticks "the same prompt" for `warnOncePerFrame`.
 *
 * `generatePromptKey` alone is type + question, and the question the detector
 * extracts from an agent's reply is often a fixed line above the list, so two
 * different lists would share it. The option rows (and where the cursor sits)
 * plus `approvalTarget` -- the current prompt's own panel, which leaves out
 * scrollback and footers that change while the prompt does not -- separate them.
 * Not the whole pane: a status bar that ticks every second would defeat it.
 */
export function promptFrameKey(promptData: PromptData): string {
  const options =
    promptData.type === 'multiple_choice'
      ? promptData.options.map((o) => `${o.isDefault ? '>' : ''}${o.number}.${o.label}`).join('\n')
      : '';
  return [generatePromptKey(promptData), options, promptData.approvalTarget ?? ''].join('\u0000');
}

/**
 * Issue #2995: print a "did not answer" line as WARN once per frame.
 *
 * The poller re-reads a static pane every 2s, so a frame Auto-Yes leaves alone
 * (a reply quoting `1. Yes / 2. No`, a launch dialog, a policy-withheld prompt,
 * a foreign session) would otherwise print the same WARN on every tick. The
 * first one stays WARN -- it is what tells a silently stalled worker apart --
 * and repeats for the same frame drop to `debug`. The frame is identified by
 * the event, `promptFrameKey()` and the event's own detail; a different
 * prompt, a different reason, or a tick with no prompt / an answer sent (both
 * clear the key) makes the next line WARN again.
 * `recordPolicySuppression()` is not throttled: `capture --json` and `wait`
 * read the latest record, not the log.
 */
export function warnOncePerFrame(
  pollerState: AutoYesPollerState,
  frameKey: string,
  event: string,
  fields: Record<string, unknown>,
): void {
  const key = `${event}\u0000${frameKey}`;
  if (pollerState.lastSkipWarnKey === key) {
    logger.debug(event, { ...fields, repeated: true });
    return;
  }
  pollerState.lastSkipWarnKey = key;
  logger.warn(event, fields);
}

// =============================================================================
// Answers stopped part-way (Issue #3706)
// =============================================================================

/**
 * An Auto-Yes answer whose send was stopped after some of its keys reached the
 * pane (Issue #3706): a `y` typed with its Enter withheld, a cursor moved with
 * its Enter withheld. Keyed by composite key and NOT kept on the poller state,
 * because the typical stop is a disable → enable, which replaces the poller.
 * A worktree ID move carries it to the new key with the session it belongs to
 * (Issue #3713, {@link movePartialAnswers}).
 */
export interface PartialAutoYesAnswer {
  /** {@link partialAnswerScreenKey} of the prompt the keys were typed at. */
  screenKey: string;
  /** The session epoch the keys went to; another epoch's process never saw them. */
  epoch: number;
  /** Epoch ms of the stop. */
  at: number;
  /**
   * {@link AutoYesSendAttempt.seq} of the send that recorded it (Issue #3713):
   * a send begun earlier that comes back later does not overwrite it.
   */
  seq: number;
}

/**
 * Which prompt a stopped answer is about (Issue #3706): the type, the question,
 * the option labels and `approvalTarget` — what {@link promptFrameKey} tells
 * apart — but NOT where the cursor is. The keys that were sent may have moved
 * the cursor themselves (a `Down` whose Enter was withheld), and that must not
 * make the same list read as a new one; a different list or a different command
 * under the same question is a new prompt and is answered.
 */
export function partialAnswerScreenKey(promptData: PromptData): string {
  const options =
    promptData.type === 'multiple_choice'
      ? promptData.options.map((o) => `${o.number}.${o.label}`).join('\n')
      : promptData.options.join('\n');
  return [generatePromptKey(promptData), options, withoutCursorMarks(promptData.approvalTarget ?? '')].join(
    '\u0000',
  );
}

/**
 * `approvalTarget` with the cursor taken out: the generic parser copies the
 * option panel into it, `❯` row included, so a moved cursor would otherwise
 * read as another prompt. Leading indentation goes too — the cursor row is the
 * one indented differently.
 */
function withoutCursorMarks(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s\u276F\u203A>\u25B6\u25BA\u25CF\u25CB\u25C9\u2192]+/u, ''))
    .join('\n');
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesPartialAnswers: Map<string, PartialAutoYesAnswer> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesSendAttempts: Set<AutoYesSendAttempt> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesSendAttemptSeq: { last: number } | undefined;
}

/** compositeKey -> the answer stopped part-way. globalThis for hot reload (#153). */
const partialAnswers = getOrInitGlobal('__autoYesPartialAnswers', () => new Map<string, PartialAutoYesAnswer>());

/**
 * The answer stopped part-way that still applies: same session epoch, and the
 * caller checks the prompt. Null when none, or when it was about another session.
 */
export function getPartialAnswer(compositeKey: string, epoch: number): PartialAutoYesAnswer | null {
  const partial = partialAnswers.get(compositeKey);
  if (!partial) return null;
  if (partial.epoch !== epoch) {
    partialAnswers.delete(compositeKey);
    return null;
  }
  return partial;
}

/**
 * Forget it: the prompt left the screen, another prompt came up, or the session ended.
 *
 * The sends still in flight that record under this key — moved here or not —
 * are expired too (Issue #3713, re-instruction 2): they were registered before
 * the screen they were typing at was seen gone, so their stop, coming back
 * later, must not bring the memory back and leave the next confirmation of the
 * same command unanswered. A send registered after this call is a new attempt
 * and records as before. Expiring is the mark: it drops the attempt from the
 * registry, so no per-key "forgotten up to seq" state has to outlive it.
 *
 * @param screenKey - Given when the memory is dropped because ANOTHER prompt is
 *   on screen (re-instruction 3): only the sends at the forgotten memory's
 *   screen are expired. A send at the screen now shown (Y, carried here by a
 *   move while still in flight) stays — it keeps the successor off Y, and its
 *   stop is still remembered when it comes back. Omitted (the prompt left the
 *   screen), every send under the key is expired.
 */
export function forgetPartialAnswer(compositeKey: string, screenKey?: string): void {
  partialAnswers.delete(compositeKey);
  for (const attempt of [...sendAttempts]) {
    if (attempt.recordKey !== compositeKey) continue;
    if (screenKey !== undefined && attempt.screenKey !== screenKey) continue;
    expireSendAttempt(attempt);
  }
}

/**
 * {@link forgetPartialAnswer} for every instance of a worktree, and the sends
 * still in flight there are expired (Issue #3713): a slow tick that comes back
 * after the worktree's sessions went away records nothing. For the worktree
 * being deleted only; disabling every agent keeps both (`stopAutoYesPollingByWorktree`'s
 * `keepPartialAnswers`).
 */
export function forgetPartialAnswersByWorktree(worktreeId: string): void {
  for (const key of filterCompositeKeysByWorktree([...partialAnswers.keys()], worktreeId)) {
    partialAnswers.delete(key);
  }
  const inWorktree = new Set(
    filterCompositeKeysByWorktree(
      [...sendAttempts].map((attempt) => attempt.recordKey),
      worktreeId,
    ),
  );
  for (const attempt of [...sendAttempts]) {
    if (inWorktree.has(attempt.recordKey)) expireSendAttempt(attempt);
  }
}

/** Forget every one, and expire every send in flight: server shutdown, and a test seam. */
export function clearPartialAnswers(): void {
  partialAnswers.clear();
  for (const attempt of [...sendAttempts]) expireSendAttempt(attempt);
}

// =============================================================================
// Sends in flight, and a worktree ID move (Issue #3713)
// =============================================================================

/**
 * One Auto-Yes send, registered by the poller BEFORE its first await
 * (`sendPromptAnswer`), and settled by the same tick without an await between
 * the send coming back and the settling (Issue #3713).
 *
 * It exists so a worktree ID move can carry a send that has not come back yet.
 * The tick keeps this object, not a key: when it comes back stopped with keys
 * on the pane it records the partial answer under `recordKey` as it is THEN —
 * the new key if the session moved meanwhile — and never looks a key up. A later
 * send under the old key is another object, so it is never carried by an
 * earlier move.
 */
export interface AutoYesSendAttempt {
  /**
   * Order of registration in this process. A send that comes back stopped does
   * not overwrite a partial answer recorded by a send registered after it — the
   * successor's view of the screen is the newer one (re-instruction 1, P2-2).
   * A counter rather than a timestamp: two sends can start in the same ms.
   */
  readonly seq: number;
  /** {@link partialAnswerScreenKey} of the prompt being answered. */
  readonly screenKey: string;
  /** The composite key the outcome is recorded under; a move re-points it. */
  recordKey: string;
  /** The session epoch of `recordKey` the keys go to; a move re-reads it. */
  recordEpoch: number;
  /** Set once a worktree ID move carried it to another key. */
  moved: boolean;
  /** `pending` until the tick settles it; `expired` when its session's state was dropped. */
  state: 'pending' | 'settled' | 'expired';
}

/** The sends in flight. globalThis for hot reload (#153), like the Map above. */
const sendAttempts = getOrInitGlobal('__autoYesSendAttempts', () => new Set<AutoYesSendAttempt>());
const sendAttemptSeq = getOrInitGlobal('__autoYesSendAttemptSeq', () => ({ last: 0 }));

/** Register a send about to start (the poller, before `sendPromptAnswer`). */
export function beginSendAttempt(compositeKey: string, screenKey: string, epoch: number): AutoYesSendAttempt {
  const attempt: AutoYesSendAttempt = {
    seq: ++sendAttemptSeq.last,
    screenKey,
    recordKey: compositeKey,
    recordEpoch: epoch,
    moved: false,
    state: 'pending',
  };
  sendAttempts.add(attempt);
  return attempt;
}

/**
 * The send came back. `keysSent` — it was stopped with keys already on the
 * pane — records the partial answer under the attempt's key as it is now, when
 * that key's session is still the one the keys went to; otherwise (sent in
 * full, stopped before any key, or failed) only the attempt itself is removed.
 * A second call, or a call on an expired attempt, does nothing.
 */
export function settleSendAttempt(attempt: AutoYesSendAttempt, keysSent: boolean, at: number = Date.now()): void {
  if (attempt.state !== 'pending') return;
  attempt.state = 'settled';
  sendAttempts.delete(attempt);
  if (!keysSent) return;
  // A relaunch since (`beginAgentSession`): the process the keys went to is gone.
  if (getEnterFallbackSessionEpoch(attempt.recordKey) !== attempt.recordEpoch) return;
  // A send registered later (the successor's, after a move) already recorded
  // the same session's newer screen: that is what is in the input now.
  const recorded = partialAnswers.get(attempt.recordKey);
  if (recorded !== undefined && recorded.epoch === attempt.recordEpoch && recorded.seq > attempt.seq) return;
  partialAnswers.set(attempt.recordKey, {
    screenKey: attempt.screenKey,
    epoch: attempt.recordEpoch,
    at,
    seq: attempt.seq,
  });
}

function expireSendAttempt(attempt: AutoYesSendAttempt): void {
  if (attempt.state === 'pending') attempt.state = 'expired';
  sendAttempts.delete(attempt);
}

/**
 * Is a send that a worktree ID move carried to `compositeKey` still in flight
 * at this screen of this session (Issue #3713)? Its keys may already be on the
 * pane, so the poller under the new key does not type at the same prompt until
 * it comes back. Sends that were not moved are not counted: the paths without a
 * move stay as they were.
 */
export function hasMovedSendInFlight(compositeKey: string, epoch: number, screenKey: string): boolean {
  for (const attempt of sendAttempts) {
    if (
      attempt.moved &&
      attempt.recordKey === compositeKey &&
      attempt.recordEpoch === epoch &&
      attempt.screenKey === screenKey
    ) {
      return true;
    }
  }
  return false;
}

/** One instance's session that a worktree ID move actually renamed. */
export interface PartialAnswerMove {
  oldKey: string;
  newKey: string;
  /**
   * The session epoch of `oldKey` read BEFORE the first rename's await. A
   * session begun under `oldKey` since then is not the one that moved.
   */
  sourceEpoch: number;
}

/**
 * Carry the partial answers and the sends in flight of the sessions a worktree
 * ID move renamed to their new keys (Issue #3713). Synchronous: the caller runs
 * it right after the renames, before any poller restarts.
 *
 * Only what belongs to the session that moved goes: the source's epoch must
 * still be `sourceEpoch`, and so must the record's. Every source is read before
 * any destination is written, so a swap (A↔B) or a chain (A→B, B→C) moves each
 * record once, with its own session. At a destination, what was recorded for
 * the session that used to have that name is dropped — its process is not the
 * one now there. The epochs themselves (and the Enter fallback's record) are not
 * moved: a record takes the destination key's current epoch.
 *
 * @param moves - Only the renames that succeeded in both stages
 * @returns The new keys that received a partial answer or a send in flight
 */
export function movePartialAnswers(moves: ReadonlyArray<PartialAnswerMove>): string[] {
  const carried = moves
    .filter((move) => move.oldKey !== move.newKey)
    .map((move) => {
      const current = getEnterFallbackSessionEpoch(move.oldKey) === move.sourceEpoch;
      const partial = partialAnswers.get(move.oldKey);
      return {
        move,
        partial: current && partial !== undefined && partial.epoch === move.sourceEpoch ? partial : null,
        attempts: current
          ? [...sendAttempts].filter(
              (attempt) => attempt.recordKey === move.oldKey && attempt.recordEpoch === move.sourceEpoch,
            )
          : [],
      };
    });
  const carriedAttempts = new Set(carried.flatMap((entry) => entry.attempts));

  // Detach every source first — only what is carried: a record the epochs
  // left out (a session begun under the old key while the renames ran) stays.
  for (const { move, partial } of carried) {
    if (partial !== null && partialAnswers.get(move.oldKey) === partial) partialAnswers.delete(move.oldKey);
  }
  // The destinations' previous sessions' records.
  for (const { move } of carried) {
    partialAnswers.delete(move.newKey);
    for (const attempt of [...sendAttempts]) {
      if (attempt.recordKey === move.newKey && !carriedAttempts.has(attempt)) expireSendAttempt(attempt);
    }
  }
  // Then arrive.
  const received: string[] = [];
  for (const { move, partial, attempts } of carried) {
    const epoch = getEnterFallbackSessionEpoch(move.newKey);
    if (partial !== null) partialAnswers.set(move.newKey, { ...partial, epoch });
    for (const attempt of attempts) {
      attempt.recordKey = move.newKey;
      attempt.recordEpoch = epoch;
      attempt.moved = true;
    }
    if (partial !== null || attempts.length > 0) received.push(move.newKey);
  }
  return received;
}

