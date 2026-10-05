/**
 * Is this pane still on its tool's startup screen? (Issue #3293)
 *
 * codex and vibe-local are the two tools whose saved reply is "the rows past the
 * cursor": the response poller (`extractResponse`) and the pre-send flush
 * (`savePendingAssistantResponse`) both start reading at `lastCapturedLine`,
 * which is 0 for a new session. Their startup screen is a complete, idle frame —
 * input box drawn, nothing working — so both paths read the banner as a finished
 * reply and History opened with an assistant row holding the version, the cwd
 * and the model, before the operator had said anything.
 *
 * The rule is the one #1897 (copilot), #2247 (claude) and #2250 (command-code)
 * converged on: every prompt is echoed into the transcript, and the startup
 * screen has none. It is asked of the WHOLE pane, never of the rows past the
 * cursor — those legitimately hold a reply whose echo sits above the cursor.
 *
 * Both halves are required, and the answer is `false` when either is missing:
 *
 *  - the tool's input box is on the pane. A frame it cannot be found on is not
 *    known to be an idle screen, and the reading the two paths had before stands;
 *  - no echoed user message is above it.
 *
 * One function for the two paths, so the poller and the flush cannot disagree
 * about the same pane. Each tool keeps its own reader, as the chrome readers in
 * `response-checker` do: the echo is a tool-specific measurement.
 *
 * Callers do not ask on a capture the window has clipped (#1670): the echo of a
 * turn longer than the window has scrolled out of it, and a startup screen is
 * never that tall.
 *
 * @module lib/polling/startup-screen
 */

import type { CLIToolType } from '../cli-tools/types';
import { findCodexChromeStart, findCodexUserEchoIndex, stripAnsi } from '../detection/cli-patterns';

/**
 * vibe-local's prompt row, `ctx:N% ❯`, at column 0.
 *
 * Measured on vibe-local 1.3.3 (`tests/fixtures/startup-screen-3293/`): the row
 * is drawn once per prompt and stays in the scrollback with what was typed
 * after it, so a submitted message and the input box share this shape.
 */
const VIBE_LOCAL_PROMPT_ROW_PATTERN = /^ctx:\d+%\s*[>❯]/;

/** The same row with text after the glyph: an echoed message, or one being typed. */
const VIBE_LOCAL_PROMPT_ROW_WITH_TEXT_PATTERN = /^ctx:\d+%\s*[>❯]\s*\S/;

/**
 * codex: the composer is located, and no transcript echo is above it.
 *
 * `findCodexChromeStart` reads the composer by its SGR attributes (#2310), so a
 * message typed into it and not yet sent is still the composer, not an echo.
 */
function isCodexStartupScreen(lines: readonly string[]): boolean {
  const chromeStart = findCodexChromeStart(lines);
  if (chromeStart < 0) return false;
  return findCodexUserEchoIndex(lines, chromeStart, lines.length, true) < 0;
}

/**
 * vibe-local: a prompt row is on the pane, and none of them holds text.
 *
 * A row with text is read as an echo even while it is still the input box. The
 * row alone cannot tell the two apart: while a reply is being printed the newest
 * prompt row IS the echo, and reading it as a message not yet sent would answer
 * "no turn yet" and move the cursor past the reply under it.
 */
function isVibeLocalStartupScreen(lines: readonly string[]): boolean {
  let hasPromptRow = false;
  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    if (!VIBE_LOCAL_PROMPT_ROW_PATTERN.test(line)) continue;
    if (VIBE_LOCAL_PROMPT_ROW_WITH_TEXT_PATTERN.test(line)) return false;
    hasPromptRow = true;
  }
  return hasPromptRow;
}

/**
 * Does the pane show the tool's input box with no user message echoed yet?
 *
 * @param cliToolId - The tool the capture came from
 * @param lines - The whole capture, ANSI intact (codex's reader needs the attributes)
 * @returns True for a codex or vibe-local pane that has not had a turn; false for
 *   every other tool, and whenever the input box cannot be located
 */
export function isStartupScreenWithoutUserEcho(
  cliToolId: CLIToolType,
  lines: readonly string[]
): boolean {
  switch (cliToolId) {
    case 'codex':
      return isCodexStartupScreen(lines);
    case 'vibe-local':
      return isVibeLocalStartupScreen(lines);
    default:
      return false;
  }
}
