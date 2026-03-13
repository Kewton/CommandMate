/**
 * Response extraction logic for CLI tools.
 * Determines the start index for response extraction, detects completion,
 * and checks for OpenCode-specific completion patterns.
 *
 * Issue #479: Extracted from response-poller.ts for single-responsibility separation
 */

import type { CLIToolType } from './cli-tools/types';
import {
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_PROCESSING_INDICATOR,
} from './detection/cli-patterns';

/**
 * Check if OpenCode has completed its response.
 * Detects the Build summary line pattern (e.g., "square Build . model . 2.5s").
 * [D2-002] Independent completion detection for OpenCode.
 *
 * Unlike Claude (prompt + separator) or Codex/Gemini (prompt + not thinking),
 * OpenCode signals completion via the Build summary line, which includes
 * the model name and generation timing.
 *
 * @param output - Cleaned tmux output to check (ANSI-stripped)
 * @returns True if OpenCode response is complete
 *
 * @internal Exported for unit testing (response-poller-opencode.test.ts)
 */
export function isOpenCodeComplete(output: string): boolean {
  // Must have a Build completion marker AND must NOT be actively processing.
  // The "esc interrupt" indicator appears in the TUI footer during model processing.
  // Without this check, old Build markers from previous Q&As cause false completions.
  return OPENCODE_RESPONSE_COMPLETE.test(output) && !OPENCODE_PROCESSING_INDICATOR.test(output);
}

/**
 * Determine the start index for response extraction based on buffer state.
 * Shared between normal response extraction and prompt detection paths.
 *
 * Implements a 5-branch decision tree for startIndex determination:
 *   1. bufferWasReset  -> findRecentUserPromptIndex(40) + 1, or 0 if not found
 *   2a. cliToolId === 'opencode' -> findRecentUserPromptIndex(totalLines) + 1, or 0
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
 * @returns The 0-based line index from which response extraction should begin.
 *
 * @internal Exported for testing only
 */
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number
): number {
  // Defensive validation: clamp negative values to 0 (Stage 4 SF-001)
  lastCapturedLine = Math.max(0, lastCapturedLine);

  // Branch 2a (highest priority for OpenCode): OpenCode runs in alternate screen mode
  // (fixed-size buffer, no scrollback). lastCapturedLine is meaningless because the buffer
  // doesn't grow -- it's always ~PANE_HEIGHT lines. bufferWasReset is often true because
  // lastCapturedLine = totalLines. Must execute BEFORE Branch 1 to avoid Branch 1's small
  // window (40 lines) which fails to find the second-to-last Build marker in a 200-line pane.
  if (cliToolId === 'opencode') {
    const foundUserPrompt = findRecentUserPromptIndex(totalLines);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
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
