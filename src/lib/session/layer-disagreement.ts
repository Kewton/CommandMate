/**
 * The screen says "a dialog is open", the agent's own hooks say "the turn is
 * over" — record it (Issue #2843).
 *
 * A tool's dialogs are read off the pane (`lib/detection/tools/*`), and the pane
 * is free text: every few weeks a new wording, a new screen or a quoted
 * paragraph was misread as a dialog, and each time the report came from a user
 * who saw a card that should not have been there. The hook layer is an
 * independent witness that already runs on every poll: the agent fires `Stop`
 * when a turn ends, and a dialog that belongs to a turn (an approval, a
 * question) only ever appears inside one. So a screen `waiting` whose newest
 * hook event is `stop` is either a dialog the user opened themselves (`/model`,
 * `/experimental` …) or a misreading.
 *
 * This module does NOT change any verdict. `mergeStructuredStatus` deliberately
 * lets the screen's `waiting` win (Claude emits nothing while its picker is up,
 * #1708), and overturning that is a separate decision that needs the numbers
 * this module produces. What it does is leave one log line per turn, with the
 * frame's tail, so the next misreading arrives as a fixture candidate instead
 * of as a bug report.
 *
 * Which tools qualify is decided by what their hooks deliver, not by name: the
 * rule needs BOTH ends of a turn. A tool whose hooks never announce the start of
 * a turn (`user_prompt_submit` — antigravity, Command Code) keeps the previous
 * turn's `stop` as its newest event while the next turn runs, so a genuine
 * dialog in the middle of that turn would be logged as a disagreement.
 * Likewise a `stop` whose detail is `self_resume_pending` says "the turn is
 * closed but the agent wakes itself", not "the agent is done".
 *
 * The two kinds are logged separately because they mean different things:
 *
 *  - `approval-after-stop` — the screen reads an ANSWERABLE prompt
 *    (`hasActivePrompt`). The agent asks for permission before it draws a
 *    dialog, inside a turn, so after `Stop` every line of this kind is a
 *    detector defect to fixture.
 *  - `menu-after-stop` — the screen reads a selection list / pager. A user who
 *    opened `/model` after the turn produces this legitimately, so these lines
 *    are triaged, not fixed on sight.
 */

import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('layer-disagreement');

/** What kind of disagreement a poll showed. */
export type LayerDisagreementKind = 'approval-after-stop' | 'menu-after-stop';

/** The facts one poll of `buildPayload` already holds. */
export interface LayerDisagreementInput {
  /**
   * The tool's declared hook vocabulary (`capabilities.supportedEvents`). The
   * rule applies only when it names both ends of a turn.
   */
  supportedEvents: readonly string[];
  /** The SCRAPER's status (not the merged one). */
  scraperStatus: string;
  /** The SCRAPER's reason. */
  scraperReason: string;
  /** The scraper's `hasActivePrompt`. */
  hasActivePrompt: boolean;
  /** `structuredEvents.lastEventType` — the newest hook event, or null. */
  lastEventType: string | null;
  /** `structuredEvents.lastEventDetail` — the newest hook event's detail, or null. */
  lastEventDetail: string | null;
}

/**
 * Classify one poll. Pure.
 *
 * Only tools whose hooks deliver both `user_prompt_submit` and `stop` qualify
 * (claude, codex, copilot, gemini, opencode): without the turn's start, "the
 * newest event is `stop`" cannot tell a closed turn from a running one.
 */
export function classifyLayerDisagreement(input: LayerDisagreementInput): LayerDisagreementKind | null {
  if (
    !input.supportedEvents.includes('user_prompt_submit') ||
    !input.supportedEvents.includes('stop')
  ) {
    return null;
  }
  if (input.scraperStatus !== 'waiting') return null;
  if (input.lastEventType !== 'stop') return null;
  if (input.lastEventDetail === SELF_RESUME_PENDING_DETAIL) return null;
  if (input.hasActivePrompt) return 'approval-after-stop';
  if (SELECTION_LIST_REASONS.has(input.scraperReason)) return 'menu-after-stop';
  return null;
}

/** How many rows of the frame's tail go into the log line. */
export const DISAGREEMENT_FRAME_TAIL_ROWS = 40;

/**
 * Keys already reported: `<compositeKey>|<turnId>|<kind>`. One line per turn is
 * the point — a pane that stays misread polls every few seconds.
 *
 * globalThis so `npm run dev` hot reloads do not re-arm it (the pattern of
 * `unclassified-frame-tracker.ts`).
 */
declare global {
  // eslint-disable-next-line no-var
  var __layerDisagreementReported: Set<string> | undefined;
}
const reported = globalThis.__layerDisagreementReported ??
  (globalThis.__layerDisagreementReported = new Set<string>());

/** Bound on {@link reported}; at the cap the set is cleared (worst case: one repeat line). */
const REPORTED_CAP = 512;

export interface LayerDisagreementReport {
  /** `buildCompositeKey(worktreeId, cliToolId, instanceId)`. */
  compositeKey: string;
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
  /** `structuredEvents.turnId`; null folds every turn-less poll into one key. */
  turnId: string | null;
  kind: LayerDisagreementKind;
  scraperReason: string;
  /** The captured pane, ANSI intact. */
  frame: string;
}

/**
 * Log one disagreement, once per (session, turn, kind).
 *
 * @returns true when a line was written (for tests)
 */
export function reportLayerDisagreement(report: LayerDisagreementReport): boolean {
  const key = `${report.compositeKey}|${report.turnId ?? '-'}|${report.kind}`;
  if (reported.has(key)) return false;
  if (reported.size >= REPORTED_CAP) reported.clear();
  reported.add(key);

  const rows = stripAnsi(report.frame).split('\n').filter((row) => row.trim() !== '');
  logger.warn('layerDisagreement', {
    kind: report.kind,
    worktreeId: report.worktreeId,
    cliToolId: report.cliToolId,
    instanceId: report.instanceId,
    turnId: report.turnId,
    scraperReason: report.scraperReason,
    frameTail: rows.slice(-DISAGREEMENT_FRAME_TAIL_ROWS).join('\n'),
  });
  return true;
}

/** Test-only: forget what has been reported. */
export function resetLayerDisagreementForTests(): void {
  reported.clear();
}
