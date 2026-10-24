/**
 * One reading of a frame for the waiting episodes (Issue #3798, design §2.2 /
 * 規則 1 / I9).
 *
 * Three observers read a frame and tell the episode store about it: the status
 * probe (`worktree-status-helper`), the response poller and the Auto-Yes poller.
 * They used to read it three ways — the Auto-Yes poller through the agy receipt
 * window, which turns a real confirmation outside the window into "no prompt" —
 * and a wait one of them saw as a person's screen another saw as nothing. Here
 * is the one reading they share: whether the frame waits, what kind of wait it
 * is, and whether only a person can end it (`humanHeld`), from the detector's
 * verdict WITHOUT the receipt scope.
 *
 * `humanHeld` (規則 1) is all of: the detector says `waiting`, the same
 * verdict's prompt reading says there is no prompt, and the agent reported no
 * structured wait. So a copilot `ask_user` with four or more options (a prompt
 * the detector reads, `isPrompt: true`) and an opencode permission strip the
 * agent reported a decision for (a structured wait) are not a person's screen;
 * a survey, a picker or a trust screen is.
 *
 * Detection layer: reads the detector and the waiting taxonomy, and nothing in
 * `polling/` or the session stores.
 *
 * @module lib/detection/waiting-screen-reading
 */

import type { PromptData } from '@/types/models';
import { detectSessionStatus, type SessionStatus, type StatusDetectionResult } from './status-detector';
import { STATUS_REASON } from './status-reason';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { deriveWaitingKind, type WaitingKind } from '@/lib/session/waiting-kind';

/** What a frame says about waiting (design §2.2). */
export type ScreenReading =
  | {
      kind: 'waiting';
      waitingKind: WaitingKind | null;
      /** Only a person ends this wait: no prompt the detector reads, no structured wait. */
      humanHeld: boolean;
      /** The prompt on the frame, for its screen key; null when none is read. */
      promptData: PromptData | null;
      /** The structured wait's own start, when the agent reported one. */
      structuredSince: number | null;
    }
  | { kind: 'not-waiting' }
  /** The frame could not be read: a capture that failed, or a frame no rule classifies. */
  | { kind: 'unknown' }
  /** The session is not running. */
  | { kind: 'gone' };

/** The part of the detector's verdict a reading is made from. */
export interface WaitingVerdict {
  status: SessionStatus;
  reason: string;
  hasActivePrompt: boolean;
  promptDetection: { isPrompt: boolean; promptData?: PromptData };
}

/**
 * The reasons that mean "no rule could read this frame" — the set
 * `session/status-evidence`'s `isUnclassifiedFrame` names. Restated rather than
 * imported because that module sits above this layer (it reads the agent's
 * event store).
 */
const UNCLASSIFIED_REASONS: ReadonlySet<string> = new Set<string>([
  STATUS_REASON.NO_RECENT_OUTPUT,
  STATUS_REASON.UNKNOWN_FRAME,
  STATUS_REASON.DEFAULT,
]);

/**
 * A reading from a verdict the caller has already made, with the caller's own
 * composed answer to "is it waiting" (the status probe folds the structured
 * layer and a launch in progress into it). `humanHeld` is decided here and
 * nowhere else.
 */
export function waitingReadingFromVerdict(input: {
  verdict: WaitingVerdict;
  waiting: boolean;
  waitingKind: WaitingKind | null;
  structuredWaiting: boolean;
  structuredSince: number | null;
}): ScreenReading {
  if (!input.waiting) return { kind: 'not-waiting' };
  const { verdict } = input;
  return {
    kind: 'waiting',
    waitingKind: input.waitingKind,
    humanHeld: verdict.status === 'waiting' && verdict.promptDetection.isPrompt === false && !input.structuredWaiting,
    promptData: verdict.promptDetection.promptData ?? null,
    structuredSince: input.structuredSince,
  };
}

/**
 * The reading of a prompt an observer has already read off the frame (the
 * response poller's saved prompt). A prompt is never a person's screen.
 */
export function promptWaitingReading(promptData: PromptData | null): ScreenReading {
  return { kind: 'waiting', waitingKind: 'prompt', humanHeld: false, promptData, structuredSince: null };
}

/**
 * Read one captured frame (design §2.2). The detector is asked without the
 * receipt scope (I9); the structured wait, and whether the app answers it over
 * the agent's API, are the caller's to look up — the status probe's reading of
 * the same frame gives the same kind only when both are passed.
 *
 * `verdict` is the detector's answer on this same frame when the caller has
 * already asked for it (to look the structured wait up with), so the frame is
 * not judged twice.
 */
export function readWaitingScreen(input: {
  cliToolId: CLIToolType;
  output: string;
  lastOutputTimestamp?: Date;
  structuredWaiting: boolean;
  structuredSince: number | null;
  /**
   * The structured wait is one the app answers over the agent's API
   * (`isApiAnswerableStructuredWait`, Issue #3184): a `prompt`, as the status
   * probe publishes it. The caller's to decide, like the structured wait.
   */
  apiAnswerable?: boolean;
  verdict?: StatusDetectionResult;
}): ScreenReading {
  const verdict = input.verdict ?? detectSessionStatus(input.output, input.cliToolId, input.lastOutputTimestamp);
  if (verdict.status === 'running' && UNCLASSIFIED_REASONS.has(verdict.reason)) return { kind: 'unknown' };
  const waiting = verdict.status === 'waiting' || verdict.hasActivePrompt || input.structuredWaiting;
  return waitingReadingFromVerdict({
    verdict,
    waiting,
    waitingKind: deriveWaitingKind({
      waiting,
      hasActivePrompt: verdict.hasActivePrompt,
      scraperStatus: verdict.status,
      scraperReason: verdict.reason,
      apiAnswerable: input.apiAnswerable === true,
    }),
    structuredWaiting: input.structuredWaiting,
    structuredSince: input.structuredSince,
  });
}
