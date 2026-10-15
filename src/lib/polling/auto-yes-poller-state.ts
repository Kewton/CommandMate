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
 */
export interface PartialAutoYesAnswer {
  /** {@link partialAnswerScreenKey} of the prompt the keys were typed at. */
  screenKey: string;
  /** The session epoch the keys went to; another epoch's process never saw them. */
  epoch: number;
  /** Epoch ms of the stop. */
  at: number;
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
}

/** compositeKey -> the answer stopped part-way. globalThis for hot reload (#153). */
const partialAnswers = getOrInitGlobal('__autoYesPartialAnswers', () => new Map<string, PartialAutoYesAnswer>());

/** Remember that an answer to `promptKey` was stopped with keys already on the pane. */
export function rememberPartialAnswer(compositeKey: string, partial: PartialAutoYesAnswer): void {
  partialAnswers.set(compositeKey, partial);
}

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

/** Forget it: the prompt left the screen, another prompt came up, or the session ended. */
export function forgetPartialAnswer(compositeKey: string): void {
  partialAnswers.delete(compositeKey);
}

/** {@link forgetPartialAnswer} for every instance of a worktree. */
export function forgetPartialAnswersByWorktree(worktreeId: string): void {
  for (const key of filterCompositeKeysByWorktree([...partialAnswers.keys()], worktreeId)) {
    partialAnswers.delete(key);
  }
}

/** Forget every one: server shutdown, and a test seam. */
export function clearPartialAnswers(): void {
  partialAnswers.clear();
}
