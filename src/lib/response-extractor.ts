/**
 * Response extraction logic for CLI tools.
 * Determines the start index for response extraction, detects completion,
 * and checks for OpenCode-specific completion patterns.
 *
 * Issue #479: Extracted from response-poller.ts for single-responsibility separation
 */

import type { CLIToolType } from './cli-tools/types';
import {
  OPENCODE_TURN_COMPLETE_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PERMISSION_PATTERN,
  findOpenCodeChromeStart,
  findOpenCodeUserEchoEnd,
  stripAnsi,
} from './detection/cli-patterns';

/**
 * Bounds of the opencode turn currently rendered in a captured pane.
 * Produced by {@link resolveOpenCodeTurnRegion}.
 */
export interface OpenCodeTurnRegion {
  /** Index of the first bottom-anchored chrome row, or -1 when none was found. */
  chromeStart: number;
  /** Index of the last row of the newest echoed user prompt, or -1 when none is on screen. */
  echoEnd: number;
  /** First transcript row of the current turn (0 when the echo has scrolled away). */
  start: number;
  /** Exclusive end of the transcript region (the chrome boundary, or the buffer end). */
  end: number;
  /**
   * True when no echoed user prompt is on screen, i.e. the turn is longer than
   * the pane and `[start, end)` is missing its head. The Layer-2 accumulator is
   * the only place that head still exists.
   */
  headTruncated: boolean;
}

/**
 * The slice of an opencode pane that belongs to the turn currently on screen
 * (Issue #1911).
 *
 * opencode renders in the alternate screen, so one capture holds the tail of the
 * whole conversation plus the bottom-anchored chrome. Three of #1911's defects
 * are the same missing boundary seen from different sides, so all three read the
 * region from here:
 *
 *  - the echoed user prompt was saved as part of the assistant's reply, because
 *    extraction anchored on the PREVIOUS turn's `▣ Build` row (and on the first
 *    turn of a session, where there is no previous row, on line 0);
 *  - the composer's model row and the footer's wrapped cwd were saved with it,
 *    because nothing bounded the extraction from below;
 *  - the previous turn's finished-turn marker satisfied `isOpenCodeComplete` on
 *    the first poll of a new turn, so the previous answer was re-saved as the
 *    new one and polling stopped before the real reply arrived.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact.
 * @returns The turn's `[start, end)` bounds plus the two anchors they came from.
 *
 * @internal Exported for unit testing
 */
export function resolveOpenCodeTurnRegion(lines: string[]): OpenCodeTurnRegion {
  const chromeStart = findOpenCodeChromeStart(lines);
  const echoEnd = findOpenCodeUserEchoEnd(lines, chromeStart);
  return {
    chromeStart,
    echoEnd,
    start: echoEnd + 1,
    end: chromeStart >= 0 ? chromeStart : lines.length,
    headTruncated: echoEnd < 0,
  };
}

/**
 * The current turn's rows of an opencode capture, ANSI intact (Issue #1911).
 *
 * Thin wrapper over {@link resolveOpenCodeTurnRegion} for callers that hold a
 * raw capture rather than a line array — today the Layer-2 accumulator, which is
 * fed this instead of the whole pane so it never records the previous turn, the
 * echoed prompt, or the bottom chrome.
 *
 * @param output - Raw `capture-pane` output.
 * @returns The region's rows joined by newlines; `''` when the turn has no rows
 *   on screen yet.
 */
export function sliceOpenCodeTurn(output: string): string {
  const rawLines = output.split('\n');
  const region = resolveOpenCodeTurnRegion(rawLines.map(stripAnsi));
  if (region.start >= region.end) return '';
  return rawLines.slice(region.start, region.end).join('\n');
}

/**
 * Check if OpenCode has completed its response.
 * Detects the finished-turn marker (e.g., "square Build . model . 2.5s").
 * [D2-002] Independent completion detection for OpenCode.
 *
 * Unlike Claude (prompt + separator) or Codex/Gemini (prompt + not thinking),
 * OpenCode signals completion via the Build summary line, which includes
 * the model name and generation timing.
 *
 * Issue #1893 tightened both halves of this, because a `true` here is what
 * makes `response-checker` persist the frame as the agent's answer and stop
 * polling — the failure mode is a permission dialog saved as if it were a
 * reply, with the turn it belongs to still unanswered:
 *
 *  1. the marker must carry its DURATION ({@link OPENCODE_TURN_COMPLETE_PATTERN}).
 *     The duration-less `▣ Build · <model>` row opencode draws for a step that
 *     is still open used to satisfy the old, looser pattern.
 *  2. a permission dialog on screen is never a completion, whatever marker sits
 *     above it. `opencode-live-1893/permission-after-complete.txt` is a live
 *     frame with the box open and a genuine `· 2.3s` marker from the PREVIOUS
 *     turn still in the transcript, so (1) alone does not cover it.
 *
 * Issue #1911 adds the third half that (1) and (2) between them still left open:
 * the marker must belong to the CURRENT turn, i.e. sit below the newest echoed
 * user prompt ({@link resolveOpenCodeTurnRegion}). Without that, the very first
 * poll after a send — before opencode has repainted `esc interrupt`, with the
 * previous turn's duration-carrying marker still on screen — reported the turn
 * as finished, so the previous answer was saved as the new one and polling
 * stopped before the real reply existed.
 *
 * @param output - Cleaned tmux output to check (ANSI-stripped). Box drawing must
 *   still be present: `OPENCODE_PERMISSION_PATTERN` anchors on the dialog box's
 *   own gutter. `response-checker` passes `stripAnsi(lines.join('\n'))`, which
 *   is exactly that.
 * @returns True if OpenCode response is complete
 *
 * @internal Exported for unit testing (response-poller-opencode.test.ts)
 */
export function isOpenCodeComplete(output: string): boolean {
  const lines = output.split('\n');
  const region = resolveOpenCodeTurnRegion(lines);

  // Issue #1911: the marker has to belong to THIS turn. Restricting the search
  // to the region below the newest echoed prompt is what stops the previous
  // turn's `▣ … · 2.3s` — still on screen, and still carrying its duration, so
  // #1893's tightening does not touch it — from completing a turn that has not
  // been answered yet. The upper bound matters too: the composer's own
  // `┃  Build · GPT-5.6 Luna GitHub Copilot` row sits in the chrome.
  const turnRegion = region.start >= region.end
    ? ''
    : lines.slice(region.start, region.end).join('\n');

  // Must have a finished-turn marker in this turn, must NOT be actively
  // processing, and must NOT be blocked on a permission dialog. The last two are
  // read from the WHOLE frame: both live in the chrome the region excludes.
  // The "esc interrupt" indicator appears in the TUI footer during model processing.
  return (
    OPENCODE_TURN_COMPLETE_PATTERN.test(turnRegion) &&
    !OPENCODE_PROCESSING_INDICATOR.test(output) &&
    !OPENCODE_PERMISSION_PATTERN.test(output)
  );
}

/**
 * Determine the start index for response extraction based on buffer state.
 * Shared between normal response extraction and prompt detection paths.
 *
 * Implements a 6-branch decision tree for startIndex determination:
 *   1. bufferWasReset  -> findRecentUserPromptIndex(40) + 1, or 0 if not found
 *   2a. cliToolId === 'opencode' | 'copilot' -> findRecentUserPromptIndex(totalLines) + 1, or 0
 *   2a''. captureWindowSaturated -> findRecentUserPromptIndex(totalLines) + 1, or 0
 *   2a'. cliToolId === 'antigravity' -> findRecentUserPromptIndex(totalLines) + 1, or lastCapturedLine
 *   2b. cliToolId === 'codex' -> Math.max(0, lastCapturedLine)
 *   3. lastCapturedLine >= totalLines - 5 (scroll boundary) ->
 *        findRecentUserPromptIndex(50) + 1, or totalLines - 40 if not found
 *   4. Normal case -> Math.max(0, lastCapturedLine)
 *
 * `bufferWasReset` is computed internally from `lastCapturedLine`, `totalLines`,
 * and `bufferReset`. Callers do NOT need to pre-compute `bufferWasReset`.
 * (Design: MF-001 responsibility boundary)
 *
 * Design references:
 * - Issue #326 design policy section 3-2 (4-branch startIndex table)
 * - Stage 4 SF-001: Defensive validation (negative lastCapturedLine clamped to 0)
 * - Stage 1 SF-001: findRecentUserPromptIndex as callback for SRP/testability
 *
 * @param lastCapturedLine - Number of lines previously captured from the tmux buffer.
 *   Negative values are defensively clamped to 0 (Stage 4 SF-001).
 * @param totalLines - Total number of (non-empty-trailing) lines in the current tmux buffer.
 * @param bufferReset - External flag indicating the buffer was reset (e.g., session restart).
 *   Combined with `lastCapturedLine >= totalLines` to derive internal `bufferWasReset`.
 * @param cliToolId - CLI tool identifier. Affects branch 2 (Codex-specific path).
 *   Note: When called from the Claude early prompt detection path (section 3-4),
 *   cliToolId is always 'claude', making the Codex branch unreachable in that context.
 *   The parameter is retained for the function's generality across all call sites.
 * @param findRecentUserPromptIndex - Callback that searches the tmux buffer backwards
 *   for the most recent user prompt line within a given window size.
 *   Returns the line index (>= 0) if found, or -1 if not found.
 * @param captureWindowSaturated - True when the capture came back clipped by the capture
 *   window (Issue #1670), i.e. `lastCapturedLine` no longer indexes into `lines`.
 *   Defaults to false so existing callers keep their behavior.
 * @returns The 0-based line index from which response extraction should begin.
 *
 * @internal Exported for testing only
 */
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number,
  captureWindowSaturated: boolean = false
): number {
  // Defensive validation: clamp negative values to 0 (Stage 4 SF-001)
  lastCapturedLine = Math.max(0, lastCapturedLine);

  // Branch 2a (highest priority for OpenCode): OpenCode runs in alternate screen mode
  // (fixed-size buffer, no scrollback). lastCapturedLine is meaningless because the buffer
  // doesn't grow -- it's always ~PANE_HEIGHT lines. bufferWasReset is often true because
  // lastCapturedLine = totalLines. Must execute BEFORE Branch 1 to avoid Branch 1's small
  // window (40 lines) which fails to find the second-to-last Build marker in a 200-line pane.
  if (cliToolId === 'opencode' || cliToolId === 'copilot') {
    const foundUserPrompt = findRecentUserPromptIndex(totalLines);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
  }

  // Branch 2a'' (Issue #1670): the capture window is saturated, so the buffer no
  // longer grows under the cursor — it slides. `lastCapturedLine` was recorded
  // against a window that has since scrolled by an unknown amount, so it is not a
  // position in `lines` any more and using it would slice off an arbitrary prefix
  // of the turn. Anchor on the newest echoed user prompt instead, exactly as the
  // alternate-screen branch above does for the same reason (#1268), and fall back
  // to the whole window when the echo has scrolled out (a single turn longer than
  // the window) — dropping it would be the very defect this branch fixes.
  //
  // Placed AFTER the opencode/copilot branch so the #1268 path is untouched, and
  // BEFORE the antigravity branch because the two agree wherever an echo exists;
  // only agy's `lastCapturedLine` fallback would still trust the stale cursor.
  if (captureWindowSaturated) {
    const foundUserPrompt = findRecentUserPromptIndex(totalLines);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
  }

  // Branch 2a' (Antigravity / agy, Issue #988): agy is inline-rendered (scrollback
  // retained, like Codex), so lastCapturedLine is meaningful. But the user echo
  // ("> <message>") is reliably present in the captured buffer and gives a cleaner
  // turn boundary than lastCapturedLine, so anchor on it when found and fall back to
  // lastCapturedLine (Codex-style) when the echo has scrolled out of the window
  // (very long responses).
  if (cliToolId === 'antigravity') {
    const foundUserPrompt = findRecentUserPromptIndex(totalLines);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, lastCapturedLine);
  }

  // Branch 2a''' (Command Code, Issue #2250): same reasoning as agy's above.
  // Command Code is inline-rendered (`#{alternate_on}` = 0, scrollback kept), so
  // `lastCapturedLine` is a real cursor and stays the fallback; but the echo
  // `❯ <message>` is present in every captured turn and is the cleaner boundary,
  // and the caller has already excluded the composer from the search window by
  // trimming the chrome, so the echo this finds is a transcript row rather than
  // the placeholder in the input box.
  if (cliToolId === 'command-code') {
    const foundUserPrompt = findRecentUserPromptIndex(totalLines);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, lastCapturedLine);
  }

  // Compute bufferWasReset internally (MF-001: responsibility boundary)
  const bufferWasReset = lastCapturedLine >= totalLines || bufferReset;

  // Branch 1: Buffer was reset - find the most recent user prompt as anchor
  if (bufferWasReset) {
    const foundUserPrompt = findRecentUserPromptIndex(40);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
  }

  // Branch 2b: Codex uses lastCapturedLine directly (Codex-specific TUI behavior)
  if (cliToolId === 'codex') {
    return Math.max(0, lastCapturedLine);
  }

  // Branch 3: Near scroll boundary - buffer may have scrolled, search for user prompt
  if (lastCapturedLine >= totalLines - 5) {
    const foundUserPrompt = findRecentUserPromptIndex(50);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40);
  }

  // Branch 4: Normal case - start from lastCapturedLine
  return Math.max(0, lastCapturedLine);
}
