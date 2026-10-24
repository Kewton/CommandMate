/**
 * The one place a prompt's screen is read as a kind of dialog for storage
 * (Issue #3881).
 *
 * The response poller saves a `prompt` row from a frame it has in hand; every
 * later reader — the chat transcript above all — has only the row's cut-down
 * `question` and `options`. Deciding "question, permission or confirmation
 * page?" from those again is what drew Claude's 16-column confirm page as a
 * tool approval: its option 1 wraps (`Submit` / `answers`), so the stored
 * option is `Submit`, and the review list is above the five rows the stored
 * question keeps. So the kind is read here, from the frame, with the same
 * predicates the Auto-Yes poller acts on, and stored as `promptData.reading`.
 *
 * What is evidence, in order:
 *
 *  1. the tool's confirm-page reader (`isAutoYesDeclinedConfirmFrame`, the
 *     predicate behind the poller's `question-confirm-page`) — `confirmation`;
 *  2. a question reader's picker chrome (`isAskUserQuestion`) — `question`;
 *  3. rows that read as a permission dialog's effects
 *     (`selectAllowOnceOption`, the resolver's own reading) — `permission`;
 *  4. a yes/no confirmation pattern — `permission`;
 *  5. nothing — `unknown`, which is not "not a question".
 *
 * Server-only: the confirm-page reader reaches `logger` → `env` → `fs`. The
 * client reads what this wrote through `lib/detection/prompt-reading`.
 *
 * Which tools' screens carry more evidence (agy's receipt-backed lists,
 * copilot's and codex's questions) is the second half of #3881; this module is
 * where it goes, and `tests/unit/guards/prompt-reading-sites-3881.test.ts`
 * keeps it the only place.
 *
 * @module lib/polling/prompt-screen-reading
 */

import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import type { PromptDetectionResult } from '@/lib/detection/types';
import type { PromptData } from '@/types/models';
import {
  PROMPT_READING_VERSION,
  type CaptureTop,
  type PromptReading,
  type PromptReadingEvidence,
} from '@/types/prompt-reading';
import type { NormalizedFrame } from '@/lib/detection/tools/types';
import { isAutoYesDeclinedConfirmFrame, isAutoYesDeclinedConfirmPage } from './auto-yes-confirm-page';
import { selectAllowOnceOption } from './auto-yes-option-effect';

/**
 * Where the first row of a capture sits in the pane (Issue #3881 review P2-1).
 *
 * Every capture is the last `windowLines` rows of the pane
 * (`captureSessionOutput` → `sliceOutput`), so one that came back with fewer
 * rows than its window holds the pane's whole history and its first row is
 * the history's first; one that filled the window may have been cut there.
 * The same test as `isCaptureWindowSaturated` (#1670) on the row count —
 * restated, not imported: this module may not reach `tmux-capture-cache`
 * (Issue #1922's import rule), and the equivalence is pinned by
 * `tests/unit/lib/polling/prompt-reading-capture-top-3881.test.ts`.
 *
 * That holds for a scrollback pane only (the second review's N1). A tool in
 * the alternate screen ({@link usesAlternateScreen}: claude, copilot,
 * opencode) keeps no history, so its capture is the visible screen whatever
 * the window, and "fewer rows than the window" says nothing about what the
 * tool scrolled off. Its capture is read off the screen instead
 * ({@link screenTopOf}), once the window is known not to have cut it.
 *
 * Whether it did (the third review's N4): the capture layer says so when the
 * caller asks (`headCut`, the Auto-Yes poller's `capturePollerFrame`). The row
 * count alone cannot tell at a window of exactly {@link TUI_PANE_HEIGHT} rows
 * (the tallest alternate-screen pane, and the poller's REDUCED window): a
 * whole 1000-row screen and a longer pane cut to its last 1000 rows come back
 * the same size. Above that height it can: a cut capture has as many rows as
 * its window, more than any alternate screen holds, and a capture that tall
 * is a pane with history (the tool is not in the alternate screen), read as
 * a scrollback pane. Below it, a capture that filled its window is `clipped`
 * unless the capture layer said otherwise.
 *
 * @param capture - The capture as returned (or its cleaned spelling: same rows)
 * @param windowLines - The window it was captured with
 * @param cliToolId - The tool whose pane it is; omitted, the pane is read as a
 *   scrollback pane (the reading before N1)
 * @param headCut - Whether the window dropped rows from the top of what tmux
 *   returned, when the capture layer said; omitted, judged from the row count
 */
export function captureTopOf(
  capture: string,
  windowLines: number,
  cliToolId?: CLIToolType,
  headCut?: boolean,
): CaptureTop {
  const filled = windowLines > 0 && capture.split('\n').length >= windowLines;
  if (cliToolId === undefined || !usesAlternateScreen(cliToolId)) {
    return filled || headCut === true ? 'clipped' : 'history-start';
  }
  if (headCut === true) return 'clipped';
  if (screenRowsOf(capture).length > TUI_PANE_HEIGHT) return filled ? 'clipped' : 'history-start';
  if (headCut === undefined && filled && windowLines < TUI_PANE_HEIGHT) return 'clipped';
  return screenTopOf(capture);
}

/** A capture's rows: tmux ends every row with a newline, and the last one is not a row of its own. */
function screenRowsOf(capture: string): string[] {
  return (capture.endsWith('\n') ? capture.slice(0, -1) : capture).split('\n');
}

/**
 * An alternate-screen capture taken whole: does its content begin at the top
 * of what the tool drew? These tools lay their content out from the screen's
 * top down (a fresh 1000-row claude pane is a blank margin row, the banner,
 * the turn, and blank rows to the bottom — `tests/fixtures/
 * claude-confirm-live-3791/`), and one whose content outgrew the screen
 * scrolls it: then the content reaches the bottom row
 * (`head-cut-200x12.txt`), and the rows that left the top are gone. So the
 * first row is the content's own only when the screen shows both its top
 * margin (a blank first row) and room below (a blank last row); anything else
 * — a content row at either edge — is `screen-full`, which is the side that
 * withholds an answer rather than gives one.
 */
function screenTopOf(capture: string): CaptureTop {
  const rows = screenRowsOf(capture);
  const blank = (row: string | undefined): boolean => row === undefined || stripAnsi(row).trim() === '';
  return rows.length > 1 && blank(rows[0]) && blank(rows[rows.length - 1]) ? 'screen-start' : 'screen-full';
}

/**
 * The detection with `approvalTargetCompleteness: 'top-unknown'` on its prompt
 * when the target's upward scan reached the frame's first row without a
 * boundary and that row is not known to be the top of the pane's history
 * (Issue #3881 review P2-1). Before this, `top-unknown` stayed on the
 * detection only and the resolver read such a target as complete: a confirm
 * whose command began above the capture, and whose rest fell within 12 rows,
 * was answered under a contract that denies the command.
 *
 * A capture whose first row is where the pane's content begins
 * (`history-start`, or `screen-start` on the alternate screen) leaves the
 * detection as it is.
 * Blank-row compaction during detection removes no non-blank row, so it does
 * not change which of the two a frame is.
 *
 * @param detection - The tick's detection of the capture
 * @param captureTop - Where the capture's first row sits ({@link CaptureTop}),
 *   judged by the caller that knows its window ({@link captureTopOf})
 */
export function withCaptureTopCompleteness(
  detection: PromptDetectionResult,
  captureTop: CaptureTop,
): PromptDetectionResult {
  const promptData = detection.promptData;
  if (
    !promptData ||
    promptData.approvalTarget === undefined ||
    promptData.approvalTargetCompleteness !== undefined ||
    detection.approvalContext?.completeness !== 'top-unknown' ||
    !captureTopMayBeCut(captureTop)
  ) {
    return detection;
  }
  return { ...detection, promptData: { ...promptData, approvalTargetCompleteness: 'top-unknown' } };
}

/** Whether rows may be missing above a capture's first row ({@link CaptureTop}). */
function captureTopMayBeCut(captureTop: CaptureTop): boolean {
  return captureTop === 'clipped' || captureTop === 'screen-full';
}

/**
 * Read the prompt's screen as a kind of dialog.
 *
 * @param cliToolId - The tool that drew the frame
 * @param frame - The capture the prompt was detected on (ANSI and box drawing
 *   as captured), or the tick's own `normalizeFrame` of it — the Auto-Yes
 *   poller passes that, so a tick still normalises its capture once (#3183) —
 *   or null when the caller has none: then no confirm page can be read off it
 * @param detection - The detection of that frame
 * @param captureTop - Where `frame`'s first row sits in the pane, when the
 *   caller knows its capture window (Issue #3881 review P2-1)
 * @returns The reading, or null when the detection carries no prompt
 */
export function readPromptScreen(
  cliToolId: CLIToolType,
  frame: string | NormalizedFrame | null,
  detection: PromptDetectionResult,
  captureTop?: CaptureTop,
): PromptReading | null {
  const promptData = detection.promptData;
  if (!promptData) return null;

  const context = detection.approvalContext;
  const base = {
    version: PROMPT_READING_VERSION,
    ...(context ? { liveRange: { startRow: context.startRow, endRow: context.endRow } } : {}),
    approvalTarget: context?.completeness ?? ('not-measured' as const),
    ...(captureTop !== undefined ? { captureTop } : {}),
  };

  const confirmPage = typeof frame === 'object' && frame !== null
    ? isAutoYesDeclinedConfirmPage(cliToolId, frame)
    : isAutoYesDeclinedConfirmFrame(cliToolId, frame);
  if (confirmPage) {
    return { ...base, kind: 'confirmation', phase: 'confirmation', evidence: ['confirm-page-reader'] };
  }

  if (promptData.type === 'multiple_choice' && promptData.isAskUserQuestion === true) {
    const evidence: PromptReadingEvidence[] = ['question-picker-chrome'];
    if (promptData.askUserQuestion !== undefined) evidence.push('ask-user-question-payload');
    return { ...base, kind: 'question', phase: 'question', evidence };
  }

  if (promptData.type === 'multiple_choice') {
    return selectAllowOnceOption(promptData.options, cliToolId).kind === 'not-a-permission-dialog'
      ? { ...base, kind: 'unknown', evidence: [] }
      : { ...base, kind: 'permission', evidence: ['permission-option-effect'] };
  }

  return { ...base, kind: 'permission', evidence: ['yes-no-pattern'] };
}

/**
 * The `promptData` a `prompt` row is saved with: the detection's, with what
 * {@link readPromptScreen} read stored beside it. Undefined when the detection
 * carries none, exactly as before. Both writers of a new `prompt` row from a
 * frame use it: the response poller's save, and (review P2-2) the Auto-Yes
 * poller's audit row when it answers before any row was saved.
 */
export function promptDataForStorage(
  cliToolId: CLIToolType,
  frame: string | NormalizedFrame | null,
  detection: PromptDetectionResult,
  captureTop?: CaptureTop,
): PromptData | undefined {
  const reading = readPromptScreen(cliToolId, frame, detection, captureTop);
  if (!detection.promptData || reading === null) return detection.promptData;
  return { ...detection.promptData, reading };
}
