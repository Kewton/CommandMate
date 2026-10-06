/**
 * Assistant Response Saver
 * Issue #53: Saves pending assistant responses before a new user message
 *
 * This module implements the "next user input trigger" pattern:
 * When a user sends a new message, we first capture and save any pending
 * assistant response from the CLI tool.
 *
 * Key responsibilities:
 * - Capture CLI output since last saved position
 * - Clean and validate the response based on CLI tool type
 * - Save as assistant message with proper timestamp ordering
 * - Update session state to prevent duplicate saves
 *
 * Scope: scrollback-rendering tools only (codex, gemini, vibe-local, antigravity).
 * The whole pattern rests on `lastCapturedLine` being a read cursor into a growing
 * buffer, which is false for alternate-screen tools — those are handled by the
 * response poller instead (Issue #1268 / #1292; see savePendingAssistantResponse).
 */

import Database from 'better-sqlite3';
import { captureSessionOutput } from './session/cli-session';
import {
  createMessage,
  getSessionState,
  updateSessionState,
} from './db';
import { broadcastMessage } from './ws-server';
// Issue #571 [DR1-05]: Import directly from response-cleaner instead of barrel re-export
import {
  cleanClaudeResponse,
  cleanGeminiResponse,
  cleanOpenCodeResponse,
  cleanCopilotResponse,
  cleanScrollbackResponse,
} from './response-cleaner';
import { usesAlternateScreen, type CLIToolType } from './cli-tools/types';
import { findCodexChromeStart } from './detection/cli-patterns';
import type { ChatMessage } from '@/types/models';
import { createLogger } from '@/lib/logger';

const logger = createLogger('assistant-response-saver');

/**
 * Default buffer size for capturing CLI session output (in lines)
 * @constant
 */
const SESSION_OUTPUT_BUFFER_SIZE: number = 10000;

/**
 * Tolerance for detecting buffer reset (in lines)
 * If the buffer shrinks by more than this amount, we consider it a buffer reset
 * @constant
 */
const BUFFER_RESET_TOLERANCE: number = 25;

/**
 * Detect if the tmux buffer has been reset (cleared or session restarted)
 *
 * This handles two scenarios:
 * 1. Buffer shrink: When the current line count is significantly smaller than
 *    lastCapturedLine (e.g., 1993 -> 608 lines after scrollback cleared)
 * 2. Session restart: When a CLI session is restarted and the buffer is much
 *    smaller (e.g., 500 -> 30 lines)
 *
 * Without this detection, the condition `currentLineCount <= lastCapturedLine`
 * would incorrectly skip saving responses after buffer resets.
 *
 * @param currentLineCount - Current number of lines in the buffer
 * @param lastCapturedLine - Last captured line position from session state
 * @returns Object with bufferReset boolean and reason (shrink/restart/null)
 */
export function detectBufferReset(
  currentLineCount: number,
  lastCapturedLine: number
): { bufferReset: boolean; reason: 'shrink' | 'restart' | null } {
  // Condition 1: Buffer shrink detection
  // The buffer has shrunk significantly if:
  // - currentLineCount > 0 (buffer is not empty)
  // - lastCapturedLine > BUFFER_RESET_TOLERANCE (we had significant content before)
  // - (currentLineCount + BUFFER_RESET_TOLERANCE) < lastCapturedLine (significant shrink)
  const bufferShrank = currentLineCount > 0
    && lastCapturedLine > BUFFER_RESET_TOLERANCE
    && (currentLineCount + BUFFER_RESET_TOLERANCE) < lastCapturedLine;

  // Condition 2: Session restart detection
  // The session was restarted if:
  // - currentLineCount > 0 (buffer is not empty)
  // - lastCapturedLine > 50 (we had meaningful content before)
  // - currentLineCount < 50 (buffer is now very small, typical of fresh session)
  const sessionRestarted = currentLineCount > 0
    && lastCapturedLine > 50
    && currentLineCount < 50;

  if (bufferShrank) {
    return { bufferReset: true, reason: 'shrink' };
  }
  if (sessionRestarted) {
    return { bufferReset: true, reason: 'restart' };
  }
  return { bufferReset: false, reason: null };
}

/**
 * How many rows of a capture count as "read so far".
 *
 * Trailing blank rows are discarded, for consistency with the response poller's
 * `extractResponse`: tmux pads the pane out to its height, and counting that
 * padding inflates the stored cursor so far past the real content that the
 * poller's dedup check (`result.lineCount <= lastCapturedLine`) can never fire
 * again.
 *
 * The one definition of the count, shared by the two writers of
 * `session_states.last_captured_line` in this module (Issue #2437): the
 * pre-send flush and {@link advanceCapturedLineForTranscriptTurn}. Two spellings
 * of "how far have I read" would be two cursors that disagree.
 *
 * @param output - Raw capture
 * @returns Row count with trailing blank rows removed
 */
function countCapturedLines(output: string): number {
  const lines = output.split('\n');
  let trimmedLength = lines.length;
  while (trimmedLength > 0 && lines[trimmedLength - 1].trim() === '') {
    trimmedLength--;
  }
  return trimmedLength;
}

/**
 * Does a codex cursor start at or below the composer? (Issue #3335)
 *
 * Nothing at or below codex's composer is a reply: it is the composer, the
 * status bar and `? for shortcuts`. On the inline layout (0.15x) a cursor
 * rarely lands there, because the next turn is printed over the composer band
 * and the composer moves down. On 0.160.0 it is where the cursor always is.
 *
 * codex 0.160.0 draws in the alternate screen: the capture is the pane, 1000
 * rows, whatever the transcript holds, with the composer pinned to row 996.
 * The row count this module stores is therefore NOT a read cursor for it — it
 * settles at 999 or 1000 after the first read (here, or in
 * {@link advanceCapturedLineForTranscriptTurn}) and never grows again, and
 * the reply is drawn above it. The screen read does not take codex's reply
 * from such a pane; the reply reaches History from codex's own transcript
 * (`hooks/sources/codex/history.ts`). What this rule stops is the flush
 * saving the chrome past the parked cursor as the reply — before #3335 a
 * cursor of 999 saved `? for shortcuts`, and 997 or 998 the status bar.
 *
 * The composer is located by its SGR attributes (#2310), on the whole pane.
 * A pane it cannot be found on keeps the reading it had.
 *
 * @param lines - The whole capture, ANSI intact
 * @param cursor - The row the flush would start reading at
 * @returns True when the rows from `cursor` down are all codex chrome
 */
export function isCodexCursorAtOrBelowComposer(lines: readonly string[], cursor: number): boolean {
  const chromeStart = findCodexChromeStart(lines);
  return chromeStart >= 0 && cursor >= chromeStart;
}

/**
 * Time offset (in milliseconds) for assistant message timestamp
 * Ensures assistant response appears before user message in chronological order
 * @constant
 */
const ASSISTANT_TIMESTAMP_OFFSET_MS: number = 1;

/**
 * Clean CLI tool response based on tool type
 *
 * Every one of `CLI_TOOL_IDS`' eight tools has a branch (Issue #2437). Until
 * then four of them — codex, command-code, antigravity and vibe-local — fell
 * through to `output.trim()`, and codex's branch said so in as many words:
 * *"Codex doesn't need special cleaning"*. It does. What that branch actually
 * saved was codex's **idle composer**, ANSI and all, as an assistant reply:
 *
 * ```text
 * › Ask Codex to do anything
 *
 *   gpt-6-astra xhigh · ~/share/work/… · Main [default]
 * ```
 *
 * See {@link cleanScrollbackResponse} for how the four share one cleaner
 * without sharing a boundary rule.
 *
 * @param output - Raw output from CLI tool
 * @param cliToolId - CLI tool identifier
 * @param paneLines - The whole capture `output` was sliced from, for the
 *   startup-screen rule of {@link cleanScrollbackResponse} (Issue #3293). Only
 *   that cleaner reads it; omitted, no tool's cleaning changes
 * @returns Cleaned response content
 */
export function cleanCliResponse(
  output: string,
  cliToolId: CLIToolType,
  paneLines?: readonly string[]
): string {
  switch (cliToolId) {
    case 'claude':
      return cleanClaudeResponse(output);
    case 'gemini':
      return cleanGeminiResponse(output);
    case 'opencode':
      return cleanOpenCodeResponse(output);
    case 'copilot':
      return cleanCopilotResponse(output);
    case 'codex':
    case 'command-code':
    case 'antigravity':
    case 'vibe-local':
      return cleanScrollbackResponse(output, cliToolId, paneLines);
    default:
      return output.trim();
  }
}

/**
 * Move `last_captured_line` past everything a transcript row now covers
 * (Issue #2437).
 *
 * ## The defect this closes
 *
 * The pre-send flush ({@link savePendingAssistantResponse}) reads
 * `lastCapturedLine`, and saves **everything past it** as the pending reply. The
 * only writer of that cursor used to be the flush itself and the response
 * poller — the Stop path that writes the agent's OWN Markdown into History
 * (`hooks/sources/<tool>/history.ts`) never touched it. So on this ordering, which
 * costs nothing to hit at a 2-second poll interval:
 *
 * ```text
 * 1. turn ends  → the Stop path writes the turn as a Markdown row   (cursor unmoved)
 * 2. `/send` arrives BEFORE the next poll tick
 * 3. the flush saves "everything since the cursor" = the whole finished turn
 * ```
 *
 * The second copy is the pane's scrape of the very same turn, so the chat
 * surface shows one reply twice. A cleaner cannot help: what is duplicated is
 * the real body, not chrome.
 *
 * ## Why a capture rather than an arithmetic bump
 *
 * The cursor is a row index into the pane, and the transcript reader never looks
 * at the pane at all — it reads a JSONL file. The only honest way to say "the
 * pane up to here is already in History" is to ask the pane how tall it is now.
 * The capture is the cached one ({@link captureSessionOutput}, 5s TTL shared
 * with the poller), so a Stop that lands between two ticks usually costs no
 * `tmux capture-pane` at all.
 *
 * ## What it deliberately does not do
 *
 * - **Alternate-screen tools are skipped.** For claude, opencode and copilot the
 *   line count is a screen-row constant rather than a cursor (Issue #1268), and
 *   {@link savePendingAssistantResponse} refuses to run for them at all — there
 *   is no cursor here to advance and writing one would be a lie.
 * - **The cursor only ever moves forward.** A capture shorter than the stored
 *   value is a buffer reset, and `detectBufferReset` owns that reading; moving
 *   the cursor backwards from here would hand the flush a range it has already
 *   saved.
 * - **It never throws, and never changes the caller's answer.** The transcript
 *   row is written whether or not this succeeds; a failure here costs one
 *   duplicated reply, and a failure that propagated would cost the row.
 *
 * @param target - The instance whose turn was just written to History
 * @returns The cursor's new value, or null when it was left where it was
 */
export async function advanceCapturedLineForTranscriptTurn(target: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
}): Promise<number | null> {
  const { worktreeId, cliToolId } = target;
  const resolvedInstanceId = target.instanceId ?? cliToolId;
  try {
    if (usesAlternateScreen(cliToolId)) {
      return null;
    }

    const output = await captureSessionOutput(
      worktreeId,
      cliToolId,
      SESSION_OUTPUT_BUFFER_SIZE,
      target.instanceId
    );
    if (!output) {
      return null;
    }

    const currentLineCount = countCapturedLines(output);
    const { getDbInstance } = await import('./db/db-instance');
    const db = getDbInstance();
    const lastCapturedLine = getSessionState(db, worktreeId, resolvedInstanceId)?.lastCapturedLine || 0;
    if (currentLineCount <= lastCapturedLine) {
      return null;
    }

    updateSessionState(db, worktreeId, cliToolId, currentLineCount, target.instanceId);
    logger.info('transcript:cursor-advanced', {
      worktreeId,
      instanceId: resolvedInstanceId,
      from: lastCapturedLine,
      to: currentLineCount,
    });
    return currentLineCount;
  } catch (error) {
    // Never the caller's problem: the transcript row is already written, and the
    // worst this costs is the duplicate it was meant to prevent.
    logger.debug('transcript:cursor-advance-failed', {
      worktreeId,
      instanceId: resolvedInstanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Save pending assistant response before a new user message
 *
 * This function is called when a user sends a new message. It:
 * 1. Captures the current tmux output since the last saved position
 * 2. Cleans and validates the output
 * 3. Saves it as an assistant message (if non-empty)
 * 4. Updates the session state to track the new position
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param userMessageTimestamp - Timestamp of the new user message (for timestamp ordering)
 * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance (=== cliToolId).
 * @returns Saved message or null if no response to save
 */
export async function savePendingAssistantResponse(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  userMessageTimestamp: Date,
  instanceId?: string
): Promise<ChatMessage | null> {
  // Issue #868: session_states / chat_messages are keyed by instance. The
  // primary instance uses instanceId === cliToolId, preserving legacy behavior.
  const resolvedInstanceId = instanceId ?? cliToolId;
  try {
    // Issue #1292: this whole function assumes the pane is a growing scrollback —
    // that `lastCapturedLine` is a read cursor and everything past it is unsaved.
    // Alternate-screen tools (claude since v2, opencode, copilot) break that
    // assumption at the root: tmux keeps no scrollback for them, so `capture-pane`
    // always returns exactly `pane_height` lines and the previous turns stay
    // painted on screen. "Old" and "pending new" content are therefore
    // indistinguishable, and the line count is a screen-row constant rather than a
    // cursor (Issue #1268).
    //
    // Measured on Claude (pane_height=1000): the first call saves at fromLine=0 and
    // parks lastCapturedLine at 1000; every later call then trips the
    // `currentLineCount <= lastCapturedLine` gate (1000 <= 1000) and returns null.
    // So its only lifetime effect was persisting the startup banner — model, plan,
    // login expiry, MCP auth state and cwd — as a bogus assistant message.
    //
    // The response poller is what actually records these tools' replies, deduping
    // on response content instead of line counts (Issue #1268/#1289), so skipping
    // here drops no coverage. OpenCode already opted out for this exact reason.
    if (usesAlternateScreen(cliToolId)) {
      return null;
    }

    // 1. Get session state for last captured position
    const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // 2. Capture current tmux output
    let output: string;
    try {
      output = await captureSessionOutput(worktreeId, cliToolId, SESSION_OUTPUT_BUFFER_SIZE, instanceId);
    } catch {
      // Session not running or capture failed - return null without error
      logger.info('failed-to-capture');
      return null;
    }

    if (!output) {
      return null;
    }

    // 3. Calculate current line count (see countCapturedLines for the trim).
    const lines = output.split('\n');
    const currentLineCount = countCapturedLines(output);

    // 4. Detect buffer reset (Issue #59 fix)
    const { bufferReset, reason } = detectBufferReset(currentLineCount, lastCapturedLine);

    if (bufferReset) {
      logger.info('buffer:reset-detected', { reason, currentLineCount, lastCapturedLine });
    }

    // 5. Determine effective last captured line
    // If buffer was reset, start from the beginning (0)
    const effectiveLastCapturedLine = bufferReset ? 0 : lastCapturedLine;

    // 6. Check for new output (using effective position)
    // Prevent duplicate saves when no new output has been added
    if (!bufferReset && currentLineCount <= lastCapturedLine) {
      // Correct stale position: if stored lastCapturedLine was inflated (untrimmed count
      // from before the trimming fix), update it to the current trimmed count so the
      // response-poller's dedup check can work correctly.
      if (currentLineCount < lastCapturedLine) {
        updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);
        logger.info('position:corrected-stale', { from: lastCapturedLine, to: currentLineCount });
      }
      return null;
    }

    // 7. Extract new lines since effective last capture position
    const newLines = lines.slice(effectiveLastCapturedLine);
    const newOutput = newLines.join('\n');

    // 8. Clean the response.
    // Only scrollback-rendering tools reach this point (Issue #1292), so the
    // tool-specific cleaners in cleanCliResponse cover every remaining case.
    //
    // Issue #3293: the pane goes with the rows. On the first send of a session
    // the cursor is 0 and "everything past it" is the tool's startup screen —
    // measured on vibe-local as `response:saved {"fromLine":0,"toLine":1001}`
    // 30 ms after `started-vibe-local-session`, and on codex as an assistant
    // row holding the version, the cwd and the logo. A pane no message has been
    // echoed on yet holds no reply, and that is a fact about the pane: the rows
    // past the cursor ordinarily carry no echo either. It cleans to '', so the
    // branch below moves the cursor exactly as the banner save used to.
    //
    // Not on a capture that came back at the size it was asked for: the window
    // has clipped it, and the echo of a turn longer than the window is no longer
    // in it. This is `isCaptureWindowSaturated` (#1670) against this module's
    // own window, written out because `lib/tmux` is not imported from here
    // (#1922).
    const captureClipped = lines.length >= SESSION_OUTPUT_BUFFER_SIZE;
    //
    // Issue #3335: on codex, rows from the composer down are chrome, never a
    // reply — and on 0.160.0 (alternate screen) that is where the cursor
    // parks for the life of the session. Read as nothing, so the branch below
    // moves the cursor as an empty clean would. See isCodexCursorAtOrBelowComposer.
    const pastCodexComposer =
      cliToolId === 'codex' && isCodexCursorAtOrBelowComposer(lines, effectiveLastCapturedLine);
    const cleanedResponse = pastCodexComposer
      ? ''
      : cleanCliResponse(newOutput, cliToolId, captureClipped ? undefined : lines);

    // 9. Check if cleaned response is empty
    if (!cleanedResponse || cleanedResponse.trim() === '') {
      // Output exists but cleaned to empty - update position but don't save
      updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);
      logger.debug('response:empty-after-clean', { currentLineCount });
      return null;
    }

    // Set assistant timestamp before user message to ensure correct chronological order
    // This is critical for proper conversation history display
    const assistantTimestamp = new Date(userMessageTimestamp.getTime() - ASSISTANT_TIMESTAMP_OFFSET_MS);

    // 10. Save to database
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: assistantTimestamp,
      cliToolId,
      instanceId: resolvedInstanceId,
    });

    // 11. Update session state with new position
    updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);

    // 12. Broadcast to WebSocket clients
    broadcastMessage('message', { worktreeId, message });

    logger.info('response:saved', { fromLine: lastCapturedLine, toLine: currentLineCount });

    return message;
  } catch (error) {
    // Log error but don't throw - user message should still be saved
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
