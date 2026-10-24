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
import type { LedgerAttemptHandle } from './auto-yes-confirmation-ledger';
import { approvalTargetWithOptionRowsAligned } from '../prompt-observation/appearance';
import { promptScreenKey } from '../detection/prompt-screen-key';

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
  /**
   * Issue #3796: epoch ms the tick that found the session again began — the
   * session wait's tick, run on schedule or brought forward by the session's
   * creation (`onTmuxSessionCreated`). The push gate reads it to end a hold
   * that was counting on a later session-wait tick. Optional like the above.
   */
  sessionAppearedAt?: number;
  /**
   * Issue #3796: epoch ms the last session-wait tick began, whatever it then
   * found (no session again, a failed capture, a session). The push gate reads
   * it so that a tick it was counting on still counts once it has run, even when
   * the tick then scheduled an ordinary one and `sessionWaitTickAt` went away.
   */
  sessionWaitTickRanAt?: number;
  /** Last answered prompt key for duplicate prevention (Issue #306) */
  lastAnsweredPromptKey: string | null;
  /** Timestamp when lastAnsweredPromptKey was set (for retry expiry) */
  lastAnsweredAt: number | null;
  /**
   * Issue #3791 (review N1): the duplicate guard actually held back the prompt
   * on screen on the last tick that read it — see `reserveDuplicateRetry` —
   * or a tick is sending that prompt's retry (review N3, `isDuplicateRetryOf`). The
   * push gate reads it (off `globalThis`) to hold that wait until the guard's
   * retry. Optional so hand-built states need not name it.
   */
  duplicateRetryReservation?: DuplicateRetryReservation | null;
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
  /**
   * Issue #3798 (design §2.2, PR 3): the waiting episode the poller's last
   * answer went to, and the confirmation it answered. Written in the
   * synchronous step the send returns to, together with the observation that
   * opens (or keeps) that episode. A frame with nothing left to answer then
   * closes that episode — and only that one: an episode it did not answer, or
   * one opened after the answer, has another id. Optional so hand-built states
   * need not name it.
   */
  lastAnswer?: AutoYesLastAnswer | null;
}

/** What {@link AutoYesPollerState.lastAnswer} records (Issue #3798). */
export interface AutoYesLastAnswer {
  /** The waiting episode the answer went to. */
  episodeId: string;
  /** {@link partialAnswerScreenKey} of the confirmation answered. */
  screenKey: string;
  /** Epoch ms the answer was observed (the send had returned). */
  at: number;
}

/**
 * The Auto-Yes poller's last answer for one instance (Issue #3798), for the
 * other observers of the same waiting episode (the response poller). Read off
 * `globalThis` (`__autoYesPollerStates`) as the push gate reads the poller's
 * answer time, so a reader need not import the poller.
 */
export function getAutoYesLastAnswer(compositeKey: string): AutoYesLastAnswer | null {
  return globalThis.__autoYesPollerStates?.get(compositeKey)?.lastAnswer ?? null;
}

/**
 * Issue #3791 (review N1): the duplicate guard (#306) held back the prompt on
 * screen, and the poller will answer it again once the guard expires.
 */
export interface DuplicateRetryReservation {
  /** The guard's key (`lastAnsweredPromptKey`) the prompt matched. */
  promptKey: string;
  /** The answer the guard counts from (`lastAnsweredAt` then). */
  answeredAt: number;
  /** Epoch ms of the latest tick that held the prompt back. */
  observedAt: number;
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
  /**
   * Issue #3880: recorded for a person's send ({@link beginManualSendAttempt}).
   * Past agy's receipt window it is kept while the dialog stays up (the tick's
   * gated reading no longer sees it; `logIfWithheldForWantOfReceipt`).
   */
  byPerson?: true;
}

/**
 * The screen key of a person's send made with no prompt read off the screen
 * (Issue #3880: the capture before it failed). A hold at it covers whatever
 * confirmation the next tick reads, and takes that confirmation's key there
 * ({@link identifyPartialAnswerScreen}); from then on it is released like any
 * other — the screen changing, the session relaunched, a person's answer going
 * through — and before then by a frame with no prompt on it.
 */
export const UNIDENTIFIED_SCREEN_KEY = '\u0000unidentified-screen';

/** Whether a hold (or a send) at `heldScreenKey` covers the confirmation at `screenKey`. */
export function partialAnswerCovers(heldScreenKey: string, screenKey: string): boolean {
  return heldScreenKey === screenKey || heldScreenKey === UNIDENTIFIED_SCREEN_KEY;
}

/** Issue #3798: moved to `detection/prompt-screen-key`, where the waiting episodes read it too. */
export { promptScreenKey as partialAnswerScreenKey } from '../detection/prompt-screen-key';

/**
 * Which confirmation the ledger counts a prompt as (Issue #3820): the
 * {@link partialAnswerScreenKey} reading where the option rows can be told,
 * and otherwise one that still keeps the body. That key's fallback takes the
 * marks and indent off every row — for a partial answer, two bodies reading as
 * one screen holds the prompt for a human, the safe side — but for counting it
 * makes two confirmations whose commands differ by a `>` or an indent one.
 * Here only the rows that ARE the options the reader read — the row's number
 * and label match one of `promptData.options` — lose their gutter (where the
 * cursor sits); every other row, a numbered line of the body included, stays
 * byte for byte. The match takes the separator as the readers do: `1.`, `1)`
 * or a bare `1` followed by any run of spaces (`❯ 1  Yes`).
 */
export function ledgerScreenKey(promptData: PromptData): string {
  if (promptData.type !== 'multiple_choice') return promptScreenKey(promptData);
  const target = promptData.approvalTarget ?? '';
  const aligned = approvalTargetWithOptionRowsAligned(
    target,
    promptData.options.map((o) => o.label),
    (read, named) => read.startsWith(named),
  );
  if (aligned !== null) return promptScreenKey(promptData);
  const options = promptData.options.map((o) => `${o.number}.${o.label}`).join('\n');
  return [generatePromptKey(promptData), options, withOptionRowGuttersAligned(target, promptData.options)].join(
    '\u0000',
  );
}

/**
 * `approvalTarget` with only the cursor taken out of its option rows, or null
 * when the prompt has none (Issue #3821, the identity of the confirmation an
 * Auto-Yes decision is about). The reading {@link ledgerScreenKey} keeps: the
 * rows the block reader adopted as the options are aligned
 * (`approvalTargetWithOptionRowsAligned`), else only the rows that ARE the
 * prompt's options lose their gutter; the body — its indent, a `>`, a blank
 * row — stays byte for byte, so two commands that differ there are two
 * confirmations (#3817), and a moved cursor is the same one.
 */
export function approvalTargetWithoutCursor(promptData: PromptData): string | null {
  const target = promptData.approvalTarget;
  if (typeof target !== 'string') return null;
  if (promptData.type !== 'multiple_choice') return target;
  return (
    approvalTargetWithOptionRowsAligned(
      target,
      promptData.options.map((o) => o.label),
      (read, named) => read.startsWith(named),
    ) ?? withOptionRowGuttersAligned(target, promptData.options)
  );
}

/** A row's leading cursor marks and indentation. */
const LEADING_MARKS_PATTERN = /^[\s\u276F\u203A>\u25B6\u25BA\u25CF\u25CB\u25C9\u2192]+/u;

/** A row's option number and the text after its separator (`1.`, `1)` or `1`, then spaces). */
const OPTION_ROW_PATTERN = /^(\d+)(?:[.)]\s*|\s+)(.*)$/u;

const collapseSpaces = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Rows that match one of `options` lose their leading marks and indent; the rest stay. */
function withOptionRowGuttersAligned(
  text: string,
  options: ReadonlyArray<{ number: number; label: string }>,
): string {
  return text
    .split('\n')
    .map((line) => {
      const row = OPTION_ROW_PATTERN.exec(line.replace(LEADING_MARKS_PATTERN, ''));
      if (row === null) return line;
      const rest = collapseSpaces(row[2]);
      const isOption = options.some((option) => {
        const label = collapseSpaces(option.label);
        return option.number === Number(row[1]) && label !== '' && rest.startsWith(label);
      });
      return isOption ? line.replace(LEADING_MARKS_PATTERN, '') : line;
    })
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

const NO_ATTEMPTS: ReadonlySet<AutoYesSendAttempt> = new Set();

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
 * @param spare - Issue #3880: sends that are not expired (a person's, at agy's
 *   dialog the ungated reading still shows)
 * @param screenKey - Given when the memory is dropped because ANOTHER prompt is
 *   on screen (re-instruction 3): only the sends at the forgotten memory's
 *   screen are expired. A send at the screen now shown (Y, carried here by a
 *   move while still in flight) stays — it keeps the successor off Y, and its
 *   stop is still remembered when it comes back. Omitted (the prompt left the
 *   screen), every send under the key is expired.
 */
export function forgetPartialAnswer(
  compositeKey: string,
  screenKey?: string,
  spare: ReadonlySet<AutoYesSendAttempt> = NO_ATTEMPTS,
): void {
  partialAnswers.delete(compositeKey);
  for (const attempt of [...sendAttempts]) {
    if (attempt.recordKey !== compositeKey) continue;
    if (screenKey !== undefined && attempt.screenKey !== screenKey) continue;
    if (spare.has(attempt)) continue;
    expireSendAttempt(attempt);
  }
}

/**
 * A person's sends still in flight under this key, to this session epoch
 * (Issue #3880): agy's gated reading seeing no prompt does not say the screen
 * they type at is gone, so the tick checks the ungated reading before it
 * expires them ({@link forgetPartialAnswer}'s `spare`).
 */
export function personSendsInFlight(compositeKey: string, epoch: number): AutoYesSendAttempt[] {
  return [...sendAttempts].filter(
    (attempt) => attempt.byPerson === true && attempt.recordKey === compositeKey && attempt.recordEpoch === epoch,
  );
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

/**
 * A person's answer went through, or was refused before any key (Issue #3880):
 * the answer Auto-Yes held at that confirmation is theirs now, so the hold is
 * dropped — only one recorded before the person's answer began (`before`, its
 * {@link nextSendOrder}). A hold recorded since, by a send begun after theirs
 * (another person's from another screen, a tick's), is about what that send
 * did and stays. Only the record: a send still in flight records what it did
 * when it comes back. Not called when a person's own send may have left keys
 * on the pane, nor at the START of their answer.
 */
export function releasePartialAnswerToHuman(compositeKey: string, before: number): void {
  const recorded = partialAnswers.get(compositeKey);
  if (recorded !== undefined && recorded.seq < before) partialAnswers.delete(compositeKey);
}

/**
 * The hold's screen, now that a tick read the confirmation on screen (Issue
 * #3880): a hold at {@link UNIDENTIFIED_SCREEN_KEY} takes `screenKey`.
 */
export function identifyPartialAnswerScreen(compositeKey: string, screenKey: string): void {
  const recorded = partialAnswers.get(compositeKey);
  if (recorded?.screenKey === UNIDENTIFIED_SCREEN_KEY) partialAnswers.set(compositeKey, { ...recorded, screenKey });
}

/**
 * Put back a person's hold the tick dropped because its gated reading saw no
 * prompt, while agy's dialog it is about is still up past the receipt window
 * (Issue #3880). Only into the same session, and over nothing newer.
 */
export function keepPartialAnswerByPerson(compositeKey: string, partial: PartialAutoYesAnswer, screenKey: string): void {
  if (getEnterFallbackSessionEpoch(compositeKey) !== partial.epoch) return;
  const recorded = partialAnswers.get(compositeKey);
  if (recorded !== undefined && recorded.seq > partial.seq) return;
  partialAnswers.set(compositeKey, { ...partial, screenKey });
}

/**
 * A place in the order sends are registered in (Issue #3880): a person's
 * answer takes one as it begins, so the hold it releases when it ends is only
 * one recorded by a send registered before it began. What its own send
 * records is ordered by that send's registration instead
 * ({@link beginManualSendAttempt}).
 */
export function nextSendOrder(): number {
  return ++sendAttemptSeq.last;
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
  /**
   * Issue #3880: a person's send (`/prompt-response`), registered right before
   * its first key, its `seq` taken then; its `screenKey` may be
   * {@link UNIDENTIFIED_SCREEN_KEY}.
   */
  readonly byPerson?: true;
  /**
   * Issue #3820: the confirmation and the attempt this send is recorded under
   * in the ledger, taken before the first await like the object itself — a
   * result that comes back after the confirmation closed still goes to it.
   * Null when the ledger had no confirmation (or failed).
   */
  readonly ledger: LedgerAttemptHandle | null;
}

/** The sends in flight. globalThis for hot reload (#153), like the Map above. */
const sendAttempts = getOrInitGlobal('__autoYesSendAttempts', () => new Set<AutoYesSendAttempt>());
const sendAttemptSeq = getOrInitGlobal('__autoYesSendAttemptSeq', () => ({ last: 0 }));

/**
 * Register a send about to start (the poller, before `sendPromptAnswer`).
 *
 * @param ledger - Issue #3820: the ledger's handle for this send, if any
 */
export function beginSendAttempt(
  compositeKey: string,
  screenKey: string,
  epoch: number,
  ledger: LedgerAttemptHandle | null = null,
): AutoYesSendAttempt {
  const attempt: AutoYesSendAttempt = {
    seq: ++sendAttemptSeq.last,
    screenKey,
    recordKey: compositeKey,
    recordEpoch: epoch,
    moved: false,
    state: 'pending',
    ledger,
  };
  sendAttempts.add(attempt);
  return attempt;
}

/**
 * Register a person's send about to start (Issue #3880): the screen it types
 * at and the session epoch it goes to, fixed now, and its place among the
 * sends taken now too, as Auto-Yes's own is — not when the answer began: an
 * answer that waited before its first key (the re-verification of the screen)
 * may send after one begun later, and then its keys are the newer ones.
 * Settled with {@link settleSendAttempt} like Auto-Yes's own, so it records a
 * hold only for the session the keys went to, never over a hold of a send
 * registered after it, and not at all once the screen it typed at was seen gone.
 */
export function beginManualSendAttempt(compositeKey: string, screenKey: string): AutoYesSendAttempt {
  const attempt: AutoYesSendAttempt = {
    seq: ++sendAttemptSeq.last,
    screenKey,
    recordKey: compositeKey,
    recordEpoch: getEnterFallbackSessionEpoch(compositeKey),
    moved: false,
    state: 'pending',
    byPerson: true,
    ledger: null,
  };
  sendAttempts.add(attempt);
  return attempt;
}

/**
 * The send came back. `keysSent` — it was stopped with keys already on the
 * pane, or (Issue #3880) a tmux call of it ended without an exit status and
 * its keys may be there — records the partial answer under the attempt's key
 * as it is now, when that key's session is still the one the keys went to;
 * otherwise (sent in full, stopped before any key, or failed with nothing
 * sent) only the attempt itself is removed. A second call, or a call on an
 * expired attempt, does nothing.
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
    ...(attempt.byPerson ? { byPerson: true as const } : {}),
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
      partialAnswerCovers(attempt.screenKey, screenKey)
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

