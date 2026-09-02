/** Response checking and extraction logic for CLI tool polling (Issue #575 split from response-poller.ts). */

import { captureSessionOutput, isSessionRunning } from '@/lib/session/cli-session';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  createMessage,
  getSessionState,
  updateSessionState,
  getWorktreeById,
  clearInProgressMessageId,
  markPendingPromptsAsAnswered,
} from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import type { ChatMessage } from '@/types/models';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { parseClaudeOutput } from '@/lib/claude-output';
import {
  getCliToolPatterns,
  findClaudeChromeStart,
  isCodexTurnActive,
  stripAnsi,
  stripBoxDrawing,
  buildDetectPromptOptions,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_SKIP_PATTERNS,
  findCopilotChromeStart,
  readCopilotStatusBar,
  COPILOT_BOOT_BANNER_ANCHORS,
  COPILOT_USER_ECHO_PATTERN,
  COPILOT_TRANSCRIPT_CONTINUATION_PATTERN,
  findOpenCodeChromeStart,
} from '@/lib/detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';

const logger = createLogger('response-poller');

// Sub-module imports
import { resolveExtractionStartIndex, isOpenCodeComplete, resolveOpenCodeTurnRegion, sliceOpenCodeTurn } from '../response-extractor';
import { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse, cleanCopilotResponse, truncateMessage } from '../response-cleaner';
import { COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER } from '@/config/copilot-constants';
import {
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { isDuplicatePrompt, normalizePromptForDedup } from './prompt-dedup';
import { recordPromptDedupSkip } from './prompt-dedup-state';
import { isDuplicateResponse } from './response-dedup';
import { captureStructuredHistoryTurn, isStructuredHistoryWriterLive } from './structured-history-gate';
import { getPollerKey, stopPolling, GEMINI_LOADING_INDICATORS } from './response-poller-core';
import { notifyPushSubscribers } from '@/lib/push';
// Issue #1790: imported by deep path, not through `@/lib/push`. Suites that
// replace the barrel to count notifications (e.g. the #1547 escalation test)
// would otherwise get `undefined` here and take down module evaluation.
// Issue #1999: imported from its own module, not from the `@/lib/push` barrel
// above. Several suites replace that barrel wholesale with a stub that only
// declares `notifyPushSubscribers`, and a gate reached through it would be
// `undefined` in exactly those tests — a TypeError this function's catch would
// report as an ordinary "no response found".
import { isPromptPushSuppressed } from '@/lib/push/prompt-push-gate';
// Issue #2000: deep path for the same reason as the two imports above.
import { notifyUpstreamFaultPush } from '@/lib/push/failure-push-notifier';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { startWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import { getWaitingEpisode, observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';

/**
 * How many rows from the bottom of a copilot capture may hold its status bar.
 *
 * `readCopilotStatusBar` stops at the first non-blank row from the end, and the
 * capture handed to it here has already had its trailing blanks trimmed, so one
 * row is enough in practice. The slack exists so the reader keeps working if that
 * trim ever changes, without mapping a thousand rows through `stripAnsi` on every
 * poll tick. (Issue #1897)
 */
const COPILOT_STATUS_BAR_SCAN_ROWS = 8;

/**
 * How many rows from the bottom of a capture the upstream-fault check reads
 * (Issue #2000).
 *
 * The same 100 as `current-output-builder`'s `realtimeSnippet`, and for the
 * reason #1839 gives there: the wider capture keeps a banner from an hour ago
 * in scope, and "is this happening now" is the only question worth ringing a
 * phone about. Keeping the two windows equal also means the notification and
 * the `upstreamFault` field an operator reads in `capture --json` are judging
 * the same rows — a fault that rang but is invisible in the payload next to it
 * is unverifiable.
 */
const UPSTREAM_FAULT_SCAN_ROWS = 100;

/**
 * Raise a push notification when this frame shows a NEW upstream fault
 * (Issue #2000).
 *
 * Observed here, on the poller, rather than in `current-output-builder` where
 * the published `upstreamFault` field is computed. That field is on a read
 * path: it is evaluated when a browser polls the status API or holds the
 * WebSocket open, i.e. exactly when the user is already looking. A phone
 * notification is for the opposite situation, so the observation has to come
 * from something the server runs on its own — and this poller is it.
 *
 * Every decision (new episode / still the same one / inside the cooldown) is
 * made and logged by `push/failure-push-notifier`; nothing here decides
 * anything, so the level can be handed over on every poll.
 */
function observeUpstreamFaultForPush(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  output: string
): void {
  const snippet = output.split('\n').slice(-UPSTREAM_FAULT_SCAN_ROWS).join('\n');
  const match = matchUpstreamFault(snippet);
  // Fire-and-forget, like every other push call in this file: the poller must
  // not slow down or break because a notification could not be delivered.
  void notifyUpstreamFaultPush({
    worktreeId,
    cliToolId,
    instanceId,
    faultId: match?.fault.id ?? null,
    matchedText: match?.matchedText,
  }).catch(() => {});
}

/**
 * The `onUpdated` hook for `markPendingPromptsAsAnswered` (Issue #2195).
 *
 * The sweep stamps every still-pending prompt row of an instance the moment the
 * agent is seen to have moved on, which flips a prompt card in the chat surface
 * from "waiting for your answer" to answered. That was the one history mutation
 * with no realtime frame behind it, so every open pane kept showing the stale
 * card until its next `/messages` poll — and #2195 stretches that poll to 15s
 * whenever a socket is up, so the omission had to be closed in the same change
 * that introduced the longer interval.
 *
 * `message_updated`, never `message`: the row already existed and was already
 * delivered when it was created, so a client that appended instead of replacing
 * would show the question twice.
 */
function broadcastPromptSweptToAnswered(worktreeId: string): (message: ChatMessage) => void {
  return (message: ChatMessage) => {
    try {
      broadcastMessage('message_updated', { worktreeId, message });
    } catch (error) {
      // The rows are already stamped; a socket write must not fail the poll.
      logger.warn('prompt-sweep-broadcast-failed', {
        worktreeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

// Issue #1790: arm the waiting-edge push subscription.
//
// It has to exist before the first edge, and `server.ts` reaches this module at
// boot (it imports `polling/response-poller` for `stopAllPolling`, which pulls
// in `response-poller-core` and then this file), so this is the earliest hook
// the notification path owns. Idempotent by replacement, and it starts no timer
// and touches no database until a wait actually opens.
startWaitingPushNotifier();

// ============================================================================
// Extraction types and helpers
// ============================================================================

/**
 * Return type for extractResponse(), representing partial or complete response extraction.
 */
export interface ExtractionResult {
  response: string;
  isComplete: boolean;
  lineCount: number;
  /** Prompt detection result carried from extractResponse early check (Issue #372) */
  promptDetection?: PromptDetectionResult;
  /** True when tmux buffer shrank (TUI redraw, screen clear, session restart) */
  bufferReset?: boolean;
  /**
   * True when the capture came back clipped by the capture window (Issue #1670),
   * i.e. `lineCount` is pinned at the window size and can never grow again.
   * Only meaningful on results with `isComplete: true` — those are the only ones
   * whose `lineCount` is compared against `session_states.last_captured_line`.
   */
  captureWindowSaturated?: boolean;
  /**
   * True when the turn on screen has no echoed user prompt left in the capture
   * (Issue #1911), i.e. it outgrew the alternate-screen pane and `response` is
   * missing its head. Set for opencode only; the Layer-2 accumulator is the only
   * place that head still exists, and this is the flag that says to read it.
   */
  turnHeadTruncated?: boolean;
}

/**
 * Creates an incomplete extraction result with empty response.
 * Centralizes the repeated pattern of returning an in-progress/incomplete state.
 *
 * @param lineCount - Current line count for state tracking
 * @returns ExtractionResult with empty response and isComplete: false
 */
export function incompleteResult(lineCount: number): ExtractionResult {
  return { response: '', isComplete: false, lineCount };
}

/**
 * Build a complete ExtractionResult for a detected prompt.
 *
 * Shared between Claude early prompt detection (section 3-4, site 1) and
 * fallback prompt detection (section 3-4, site 2) in extractResponse().
 * Applies resolveExtractionStartIndex() to limit extraction to lastCapturedLine
 * onwards, then strips ANSI codes for safe DB storage (Stage 4 MF-001).
 *
 * @param lines - The trimmed tmux buffer lines array
 * @param lastCapturedLine - Number of lines previously captured
 * @param totalLines - Total line count in the buffer
 * @param bufferReset - External buffer reset flag
 * @param cliToolId - CLI tool identifier
 * @param findRecentUserPromptIndex - Callback to locate the most recent user prompt
 * @param promptDetection - Prompt detection result to carry on the extraction result
 * @param captureWindowSaturated - True when the capture was clipped by the capture window (#1670)
 * @returns ExtractionResult with isComplete: true and ANSI-stripped response
 */
export function buildPromptExtractionResult(
  lines: string[],
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number,
  promptDetection?: PromptDetectionResult,
  captureWindowSaturated: boolean = false,
): ExtractionResult {
  const startIndex = resolveExtractionStartIndex(
    lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
    captureWindowSaturated
  );
  const extractedLines = lines.slice(startIndex);
  return {
    response: stripAnsi(extractedLines.join('\n')),
    isComplete: true,
    lineCount: totalLines,
    promptDetection,
    bufferReset,
    captureWindowSaturated,
  };
}

/**
 * Internal helper: detect prompt with CLI-tool-specific options.
 *
 * Centralizes the stripAnsi() + buildDetectPromptOptions() + detectPrompt() pipeline
 * to avoid repeating this 3-step sequence across extractResponse() and checkForResponse().
 *
 * @param output - Raw or pre-stripped tmux output
 * @param cliToolId - CLI tool identifier for building detection options
 * @returns PromptDetectionResult with isPrompt, promptData, and cleanContent
 */
export function detectPromptWithOptions(
  output: string,
  cliToolId: CLIToolType
): PromptDetectionResult {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(stripBoxDrawing(stripAnsi(output)), promptOptions);
}

// ============================================================================
// extractResponse (internal)
// ============================================================================

/**
 * Extract CLI tool response from tmux output
 * Detects when a CLI tool has completed a response by looking for tool-specific patterns
 *
 * @param output - Full tmux output
 * @param lastCapturedLine - Number of lines previously captured
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param captureWindowLines - Size of the capture window `output` was produced with.
 *   Used only to decide whether the capture came back clipped (Issue #1670);
 *   defaults to the window `checkForResponse()` uses.
 * @returns Extracted response or null if incomplete
 */
export function extractResponse(
  output: string,
  lastCapturedLine: number,
  cliToolId: CLIToolType,
  captureWindowLines: number = CACHE_MAX_CAPTURE_LINES
): ExtractionResult | null {
  // Trim trailing empty lines from the output before processing
  const rawLines = output.split('\n');
  let trimmedLength = rawLines.length;
  while (trimmedLength > 0 && rawLines[trimmedLength - 1].trim() === '') {
    trimmedLength--;
  }
  const lines = rawLines.slice(0, trimmedLength);
  const totalLines = lines.length;

  // Issue #1670: measured on the RAW capture, before the trailing-blank trim —
  // the clip happens in sliceOutput(), so it is the untrimmed row count that
  // reveals it. Once this is true the line count is pinned at the window size and
  // `lastCapturedLine` stops being a position in `lines`; see
  // isCaptureWindowSaturated() for why raising the window only relocates it.
  const captureWindowSaturated = isCaptureWindowSaturated(rawLines.length, captureWindowLines);

  // Issue #1289: Claude Code pins a footer (rotating hint row, input box, status
  // bar) to the bottom of the pane. It is chrome, not transcript, and its hint
  // row rotates while the conversation is idle — so letting it reach the saved
  // response both stores terminal furniture and re-hashes on every poll tick,
  // defeating the content dedup from #1268. Completion detection below still
  // reads the untouched buffer: it keys off that very footer (the input box
  // supplies `hasPrompt`, its rules supply `hasSeparator`).
  //
  // Issue #1897: copilot pins the same shape of chrome (cwd row, two rules, the
  // composer, the status bar) to the bottom of its pane, and it is the reason the
  // agent's saved reply read " Working esc interrupt GPT-5.6 Terra" -- see
  // findCopilotChromeStart().
  //
  // Issue #1911: opencode pins the same kind of chrome to the bottom of its
  // alternate-screen pane — the composer box (whose model row reads
  // `Build · GPT-5.6 Luna GitHub Copilot`) and, below its `╹▀▀▀` border, a footer
  // whose wrapped cwd carries no signature at all. Both were being saved as part
  // of the assistant's reply, which is defect 1 of #1911; no pattern can remove
  // the cwd rows, so the boundary has to be structural.
  //
  // The three readers stay three functions on purpose. All three answer "where
  // does the transcript stop?", but each is anchored on a DIFFERENT measured
  // landmark — claude's two full-width rules around its input box (#1289),
  // copilot's bottom status-bar row (#1885/#1897), opencode's `╹▀▀▀` composer
  // border (#1911) — and a landmark is only as good as the frames it was measured
  // on. Folding them into one reader would let a rewording in one tool's chrome
  // silently delete another tool's boundary, and a boundary that stops existing
  // does not fail loudly: it puts terminal furniture back into History.
  const openCodeCleanLines = cliToolId === 'opencode' ? lines.map(stripAnsi) : null;
  const chromeStart = cliToolId === 'claude'
    ? findClaudeChromeStart(lines)
    : cliToolId === 'copilot'
      ? findCopilotChromeStart(lines)
      : openCodeCleanLines
        ? findOpenCodeChromeStart(openCodeCleanLines)
        : -1;
  const contentEnd = chromeStart >= 0 ? chromeStart : totalLines;

  const BUFFER_RESET_TOLERANCE = 25;
  const bufferShrank = totalLines > 0 && lastCapturedLine > BUFFER_RESET_TOLERANCE && (totalLines + BUFFER_RESET_TOLERANCE) < lastCapturedLine;
  const sessionRestarted = totalLines > 0 && lastCapturedLine > 50 && totalLines < 50;
  const bufferReset = bufferShrank || sessionRestarted;

  // No new output
  if (!bufferReset && totalLines < lastCapturedLine - 5) {
    return null;
  }

  // Check recent lines for completion pattern.
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = openCodeCleanLines
    ? openCodeCleanLines.join('\n')
    : linesToCheck.join('\n');

  // Get tool-specific patterns from shared module
  const { promptPattern, separatorPattern, thinkingPattern, skipPatterns } = getCliToolPatterns(cliToolId);

  const findRecentUserPromptIndex = (windowSize: number = 60): number => {
    let userPromptPattern: RegExp;
    if (cliToolId === 'codex') {
      userPromptPattern = /^›\s+(?!Implement|Find and fix|Type|Summarize)/;
    } else if (openCodeCleanLines) {
      // Issue #1911: anchor on the newest ECHOED USER PROMPT, not on the
      // second-to-last `▣ Build` row. The old anchor belonged to the PREVIOUS
      // turn, so the echoed prompt of the current one was always extracted as
      // part of the reply — and on the first turn of a session, where there is
      // no second marker, it fell through to line 0 and the whole pane (banner
      // included) became the answer. `windowSize` is ignored: the alternate
      // screen has no scrollback, so the whole pane IS the window, and every
      // caller already passes `totalLines` or more for this tool.
      return resolveOpenCodeTurnRegion(openCodeCleanLines).echoEnd;
    } else if (cliToolId === 'copilot') {
      // Issue #1897: copilot 1.0.80 draws the transcript one column in, so the
      // bare `^[>❯]` form below never matched the echoed prompt -- every copilot
      // extraction fell back to line 0, i.e. to the launch banner. The composer,
      // which IS at column 0, lives below `contentEnd` and so cannot be picked up
      // as an echo here.
      //
      // The scan then walks past the echo's own wrapped rows and returns the LAST
      // of them, so that callers' `+ 1` lands on the reply rather than on the
      // second half of the operator's question.
      //
      // Same defect as #1911's opencode branch above and the same shape of fix,
      // but NOT the same code: opencode's echo is a `┃  <text>` gutter row and
      // copilot's is ` ❯ <text>` at the pane's one-column indent, so the anchor
      // and the continuation rule are both tool-specific measurements.
      for (let i = contentEnd - 1; i >= Math.max(0, contentEnd - windowSize); i--) {
        if (!COPILOT_USER_ECHO_PATTERN.test(stripAnsi(lines[i]))) continue;
        let echoEnd = i;
        while (
          echoEnd + 1 < contentEnd &&
          COPILOT_TRANSCRIPT_CONTINUATION_PATTERN.test(stripAnsi(lines[echoEnd + 1]))
        ) {
          echoEnd++;
        }
        return echoEnd;
      }
      return -1;
    } else {
      userPromptPattern = /^[>❯]\s+\S/;
    }

    // Issue #1289: for Claude the search stops above the footer. The text the
    // user just typed sits in the footer's input box and matches the same "❯ …"
    // shape as the transcript echo; anchoring on it would treat the footer as
    // the newest turn and extract the status bar as its reply.
    for (let i = contentEnd - 1; i >= Math.max(0, contentEnd - windowSize); i--) {
      const cleanLine = stripAnsi(lines[i]);
      if (userPromptPattern.test(cleanLine)) {
        return i;
      }
    }

    return -1;
  };

  // Early check for interactive prompts (before extraction logic)
  if (cliToolId === 'claude' || cliToolId === 'codex' || cliToolId === 'copilot') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection, captureWindowSaturated,
      );
    }
  }

  // Strip ANSI codes before pattern matching
  const cleanOutputToCheck = stripAnsi(outputToCheck);

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  // Issue #1671: Codex's activity markers are past-tense transcript records that
  // never leave the scrollback, so testing them against this fixed tail window
  // reports "still thinking" for a finished turn whenever its final message was
  // short enough to keep the last "• Ran <cmd>" row inside the window. Codex gets
  // a liveness check that keys off the status line it repaints above the composer
  // instead; every other tool keeps the tail-window match.
  const isThinking = cliToolId === 'codex'
    ? isCodexTurnActive(lines, checkLineCount)
    : thinkingPattern.test(cleanOutputToCheck);

  // Issue #1897: copilot's `hasPrompt` is worthless as a completion signal and
  // its `isThinking` is worthless as a liveness one. The `❯` composer is drawn
  // between its two rules throughout a turn (measured on every frame of #1885's
  // running fixtures), and `COPILOT_THINKING_PATTERN` matches nothing copilot
  // 1.0.80 draws (0 of 44 live generating frames). So `hasPrompt && !isThinking`
  // was true on the very first poll of a running turn -- the extractor declared
  // the turn finished, saved the status bar as the reply, and `checkForResponse`
  // stopped polling, which is why the real answer never reached History.
  //
  // 1.0.80 paints the turn's state on the bottom row of the pane and nowhere
  // else, so that ROW -- never a tail window, which copilot's own reply text can
  // forge (`status-vocabulary-in-response.txt`) -- is the evidence. `idle` is a
  // positive observation that the turn is over (design policy §4 D1 decision 1
  // item 2); `working` and `null` (a dialog box has taken the bar away) both mean
  // "not finished", and the dialog case is already served by the prompt path
  // above.
  const copilotStatusBar = cliToolId === 'copilot'
    ? readCopilotStatusBar(lines.slice(Math.max(0, totalLines - COPILOT_STATUS_BAR_SCAN_ROWS)).map(stripAnsi))
    : null;

  // Prompt-based completion logic
  const isPromptBasedComplete = cliToolId === 'copilot'
    ? copilotStatusBar === 'idle'
    : (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local' || cliToolId === 'antigravity') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;
  const isOpenCodeDone = cliToolId === 'opencode' && isOpenCodeComplete(cleanOutputToCheck);

  if (isPromptBasedComplete || isClaudeComplete || isOpenCodeDone) {
    const responseLines: string[] = [];

    const startIndex = resolveExtractionStartIndex(
      lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
      captureWindowSaturated
    );

    let endIndex = totalLines;

    // `contentEnd` bounds the content only; `endIndex` keeps reporting the full
    // buffer so lineCount bookkeeping in session_states is unchanged (#1289).
    for (let i = startIndex; i < contentEnd; i++) {
      const line = lines[i];
      const cleanLine = stripAnsi(line);

      if (cliToolId === 'codex' && /^›\s+/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      // Antigravity (agy): the bare ">" input box line marks the end of the
      // response (the status bar and shortcuts footer follow below it). (Issue #988)
      if (cliToolId === 'antigravity' && /^>\s*$/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      // Issue #1911: both rows this stops on (`Ask anything...` in the composer,
      // `tab agents  ctrl+p commands` under its border) live in the chrome, which
      // `contentEnd` now excludes structurally. Kept only as the fallback for a
      // frame whose chrome could not be located, because there it is still the
      // one boundary available — and #1883 measured that a REPLY can contain
      // `Ask anything...`, so cutting the turn on it is a last resort, not the
      // primary rule.
      if (cliToolId === 'opencode' && chromeStart < 0) {
        if (OPENCODE_PROMPT_PATTERN.test(cleanLine) || OPENCODE_PROMPT_AFTER_RESPONSE.test(cleanLine)) {
          endIndex = i;
          break;
        }
      }

      const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
      if (shouldSkip) {
        continue;
      }

      responseLines.push(line);
    }

    const response = responseLines.join('\n').trim();

    // DR-004: Check only the tail of the response for thinking indicators.
    //
    // Issue #1897: not for copilot. This is the same tail-window match the #1671
    // codex fix removed from the liveness test, and on copilot it is both
    // redundant and harmful: the status bar above has already made a positive
    // `idle` observation about THIS frame, while the window here sees transcript
    // that never scrolls away. `COPILOT_THINKING_PATTERN`'s braille alternative
    // matches any spinner glyph a reply happens to quote, and the turn would then
    // be reported unfinished for the rest of the session.
    const responseTailLines = response.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
    if (cliToolId !== 'copilot' && thinkingPattern.test(responseTailLines)) {
      return incompleteResult(totalLines);
    }

    // CRITICAL FIX: Detect and skip Claude Code startup banner/screen
    if (cliToolId === 'claude') {
      const cleanResponse = stripAnsi(response);

      // Issue #2247: `│` is what Claude Code draws markdown TABLES with -- the
      // live frame in `tests/fixtures/claude-live-2247/turn-table.txt` is a
      // two-row table and nothing else -- so it identified a reply, not a banner.
      // The banner's own frame glyphs are the rounded corners and the block
      // shading; those stay.
      const hasBannerArt = /[╭╮╰╯]/.test(cleanResponse) || /░{3,}/.test(cleanResponse) || /▓{3,}/.test(cleanResponse);
      // Issue #2247: the bare `v\d+\.\d+` alternative matched any version string a
      // reply happens to mention. The frame that lost a turn on 2026-09-02 was
      // "GitHub Release v0.30.0 を公開しました" (148 chars, well under the 2000
      // below). What the banner actually prints is the tool's own name and
      // version on one row -- `Claude Code v2.1.258` -- so that is what is
      // matched now, plus the `claude/` form older banners used.
      const hasVersionInfo = /Claude Code v\d+\.\d+|claude\//.test(cleanResponse);
      const hasStartupTips = /Tip:|for shortcuts|\?\s*for help/.test(cleanResponse);
      const hasProjectInit = /^\s*\/Users\/.*$/m.test(cleanResponse) && cleanResponse.split('\n').length < 30;

      // Issue #2247: the anchors above are only evidence of a banner on a pane
      // that has not had a single turn yet -- the same shape as the #1897 copilot
      // fix below. Claude echoes every prompt into the transcript as `❯ <text>`,
      // and the startup screen has none, so an echo anywhere in the transcript
      // rules the banner out no matter what the reply quotes.
      //
      // The search is `findRecentUserPromptIndex`, deliberately: it is the same
      // `/^[>❯]\s+\S/` this file already anchors extraction on, and it stops at
      // `contentEnd`. That bound is load-bearing rather than incidental -- the
      // footer's composer draws a DIM ghost suggestion (`❯ Try "write a test for
      // <filepath>"`, see `boot-banner.txt`) whose stripped bytes are identical
      // to a real echo (#1879), so a scan over the whole pane would read the
      // startup screen as "already had a turn" and put the banner back in
      // History.
      const hasTurnEcho = findRecentUserPromptIndex(totalLines) >= 0;

      const userPromptMatch = cleanResponse.match(/^[>❯]\s+(\S.*)$/m);

      if (userPromptMatch) {
        const userPromptIndex = cleanResponse.indexOf(userPromptMatch[0]);
        const contentAfterPrompt = cleanResponse.substring(userPromptIndex + userPromptMatch[0].length).trim();

        const contentLines = contentAfterPrompt.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed &&
                 !skipPatterns.some(p => p.test(trimmed)) &&
                 !/^─+$/.test(trimmed);
        });

        if (contentLines.length === 0) {
          return incompleteResult(totalLines);
        }
      } else if (
        !hasTurnEcho &&
        (hasBannerArt || hasVersionInfo || hasStartupTips || hasProjectInit) &&
        response.length < 2000
      ) {
        // Issue #2247: this branch used to swallow the turn in silence -- the
        // poller kept ticking every 2s and `response-poller` logged nothing at
        // all, so the only way to tell a lost turn from an idle session was to
        // re-run `extractResponse` on a saved pane by hand. It is reached only
        // before the first echo lands, so it cannot become a per-tick flood.
        logger.info('Claude startup banner suppressed, response not saved', {
          responseLength: response.length,
          hasBannerArt,
          hasVersionInfo,
          hasStartupTips,
          hasProjectInit,
        });
        return incompleteResult(totalLines);
      }
    }

    // Issue #1897: copilot's launch screen is a complete, idle frame -- composer
    // drawn, key hints on the status bar -- so every check above accepts it and
    // History used to open with the banner ("Current Sessions Issues Pull
    // requests Gists / No copilot-instructions.md found… / Tip: /app") saved as
    // the agent's first reply, before the operator had said anything.
    //
    // What actually distinguishes it is that no turn has happened: copilot echoes
    // every prompt into the transcript as ` ❯ <text>`, and the launch screen has
    // none. The banner anchors are only consulted once that echo is missing, so a
    // reply that quotes any of this wording is unaffected.
    if (cliToolId === 'copilot') {
      const cleanResponse = stripAnsi(response);
      const hasUserEcho = cleanResponse
        .split('\n')
        .some(line => COPILOT_USER_ECHO_PATTERN.test(line));
      if (!hasUserEcho && COPILOT_BOOT_BANNER_ANCHORS.some(anchor => anchor.test(cleanResponse))) {
        return incompleteResult(totalLines);
      }
    }

    // Gemini-specific check
    if (cliToolId === 'gemini') {
      const bannerCharCount = (response.match(/[░███]/g) || []).length;
      const totalChars = response.length;
      if (bannerCharCount > totalChars * 0.3) {
        return incompleteResult(totalLines);
      }

      if (GEMINI_LOADING_INDICATORS.some(indicator => response.includes(indicator))) {
        return incompleteResult(totalLines);
      }

      if (!response.includes('\u2726') && response.length < 10) {
        return incompleteResult(totalLines);
      }
    }

    // OpenCode banner defense
    if (cliToolId === 'opencode') {
      const cleanResponse = stripAnsi(response);
      if (cleanResponse.length < 50 || !OPENCODE_RESPONSE_COMPLETE.test(cleanOutputToCheck)) {
        const contentLines = cleanResponse.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed && !OPENCODE_SKIP_PATTERNS.some(p => p.test(trimmed));
        });
        if (contentLines.length === 0) {
          return incompleteResult(totalLines);
        }
      }
    }

    return {
      response,
      isComplete: true,
      lineCount: endIndex,
      bufferReset,
      captureWindowSaturated,
      // Issue #1911: opencode only. `echoEnd < 0` means the turn is longer than
      // the alternate-screen pane and its head has already scrolled away, so
      // `response` starts mid-answer. Nothing else in this frame can recover it.
      turnHeadTruncated: openCodeCleanLines
        ? resolveOpenCodeTurnRegion(openCodeCleanLines).headTruncated
        : undefined,
    };
  }

  // Check if this is an interactive prompt
  if (cliToolId !== 'opencode') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection, captureWindowSaturated,
      );
    }
  }

  // Partial response in progress
  const responseLines: string[] = [];
  const endIndex = totalLines;
  // Issue #1670: a saturated window makes lastCapturedLine meaningless here too —
  // starting the partial slice at it would stream an arbitrary tail fragment
  // instead of the turn so far. Re-anchor on the echoed user prompt.
  const partialBufferReset = bufferReset || captureWindowSaturated || lastCapturedLine >= endIndex - 5;
  const recentPromptIndex = partialBufferReset ? findRecentUserPromptIndex(80) : -1;
  const startIndex = partialBufferReset
    ? (recentPromptIndex >= 0 ? recentPromptIndex + 1 : Math.max(0, endIndex - 80))
    : Math.max(0, lastCapturedLine);

  // Partial (still-streaming) content is bounded by the footer too (#1289).
  for (let i = startIndex; i < Math.min(endIndex, contentEnd); i++) {
    const line = lines[i];
    const cleanLine = stripAnsi(line);

    const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
    if (shouldSkip) {
      continue;
    }

    responseLines.push(line);
  }

  const partialResponse = responseLines.join('\n').trim();
  if (partialResponse) {
    return {
      response: partialResponse,
      isComplete: false,
      lineCount: endIndex,
    };
  }

  // Response not yet complete
  return incompleteResult(totalLines);
}

// ============================================================================
// checkForResponse (exported for response-poller-core.ts)
// ============================================================================

/**
 * Check for CLI tool response once
 *
 * Issue #868: Optionally scoped to a specific agent instance. The instanceId
 * keys the poller, tmux session, session_states row and chat_messages; cliToolId
 * continues to drive tool-specific parsing behavior. When instanceId is omitted
 * it defaults to cliToolId (the primary instance), preserving legacy behavior.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini, ...)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 * @returns True if response was found and processed
 */
export async function checkForResponse(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): Promise<boolean> {
  const db = getDbInstance();
  // Instance used for all keying/scoping (poller, session state, prompts).
  const resolvedInstanceId = instanceId ?? cliToolId;

  try {
    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      logger.error('worktree-worktreeid-not');
      stopPolling(worktreeId, cliToolId, instanceId);
      return false;
    }

    // Check if CLI tool session is running
    const running = await isSessionRunning(worktreeId, cliToolId, instanceId);
    if (!running) {
      logger.info('session-not-running');
      stopPolling(worktreeId, cliToolId, instanceId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output. The requested width IS the capture window, so it is
    // taken from the same constant extractResponse() measures saturation against
    // (Issue #1670) — a literal here would silently decouple the two.
    const output = await captureSessionOutput(worktreeId, cliToolId, CACHE_MAX_CAPTURE_LINES, instanceId);

    // Issue #2000: the frame is in hand, so this is the cheapest place to ask
    // whether the model API has stalled the session. Level in, edge out — see
    // the helper.
    observeUpstreamFaultForPush(worktreeId, cliToolId, instanceId, output);

    // Layer 2: Accumulate TUI content for full-screen TUI tools, so a turn that
    // outgrows the alternate-screen pane keeps the head that has scrolled away.
    if (cliToolId === 'opencode' || cliToolId === 'copilot') {
      const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
      // Issue #1911: opencode is accumulated from the CURRENT TURN'S REGION
      // rather than the whole frame. Feeding the raw pane seeded the accumulator
      // with the previous turn's transcript, the echoed prompt and the bottom
      // chrome on the very first poll, so the accumulated content could never be
      // used as a response source without re-introducing defect 1.
      const accumulatorSource = cliToolId === 'opencode' ? sliceOpenCodeTurn(output) : output;
      accumulateTuiContent(pollerKey, accumulatorSource, cliToolId);
    }

    // Extract response
    const result = extractResponse(output, lastCapturedLine, cliToolId, CACHE_MAX_CAPTURE_LINES);

    if (!result || !result.isComplete) {
      // DR-004 windowing: Only check tail lines
      const { thinkingPattern } = getCliToolPatterns(cliToolId);
      const cleanOutput = stripAnsi(output);
      const tailLines = cleanOutput.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
      if (thinkingPattern.test(tailLines)) {
        const answeredCount = markPendingPromptsAsAnswered(
          db,
          worktreeId,
          cliToolId,
          resolvedInstanceId,
          broadcastPromptSweptToAnswered(worktreeId),
        );
        if (answeredCount > 0) {
          logger.info('marked-answeredcount-pending');
        }
      }
      return false;
    }

    const isFullScreenTui = cliToolId === 'opencode' || cliToolId === 'copilot';

    // Issue #1268: line-count bookkeeping is only meaningful for tools that keep
    // scrollback. Alternate-screen tools (claude since v2, opencode, copilot)
    // always capture exactly pane_height lines, so lastCapturedLine saturates at
    // the pane height on the first save and every later check would see
    // `lineCount <= lastCapturedLine` and drop the response forever — leaving
    // History stuck on "Waiting for response..." while the terminal shows the
    // reply. Those tools dedup on response content instead (see below).
    //
    // Issue #1670: the scrollback tools reach the SAME dead end from the other
    // side. Their buffer does grow — but only until it outgrows the capture
    // window, after which the capture is clipped, the count is pinned at the
    // window size, and the cursor can never be overtaken again. #1268 fixed
    // saturation at pane height; this is saturation at the capture window, and it
    // disables the cursor for exactly as long as the clipping lasts (a session
    // restart or a cleared pane un-saturates it and the cursor comes back).
    const lineCountIsCursor = !usesAlternateScreen(cliToolId) && !result.captureWindowSaturated;

    // Duplicate prevention
    if (lineCountIsCursor && !result.bufferReset && result.lineCount === lastCapturedLine && !sessionState?.inProgressMessageId) {
      return false;
    }

    if (lineCountIsCursor && !result.bufferReset && result.lineCount <= lastCapturedLine) {
      logger.info('already-saved-up-to-line-lastcapturedlin');
      return false;
    }

    // Response is complete! Check if it's a prompt.
    const promptDetection = result.promptDetection ?? detectPromptWithOptions(result.response, cliToolId);

    if (promptDetection.isPrompt) {
      // Issue #565: Content hash-based duplicate prompt prevention
      const promptContent = promptDetection.rawContent || promptDetection.cleanContent;
      const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
      const normalizedForDedup = normalizePromptForDedup(promptContent, cliToolId);
      if (isDuplicatePrompt(pollerKey, normalizedForDedup)) {
        // Issue #1695: the log line below is invisible to `commandmate capture
        // --json`, so a suppressed prompt and a prompt the detection layer never
        // classified (#1676) look identical from the CLI — both say "nothing was
        // recorded". Count the skip so the payload can tell them apart.
        recordPromptDedupSkip(worktreeId, cliToolId, instanceId);
        logger.info('duplicate-prompt-skipped', { worktreeId, cliToolId });
        return false;
      }

      // Issue #571: Clean TUI decorations from Copilot prompt content before saving
      let promptSaveContent = promptContent;
      if (cliToolId === 'copilot') {
        promptSaveContent = cleanCopilotResponse(promptContent);
        promptSaveContent = truncateMessage(promptSaveContent, COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER);
      }

      // This is a prompt - save as prompt message
      clearInProgressMessageId(db, worktreeId, cliToolId, resolvedInstanceId);

      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        content: promptSaveContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
        cliToolId,
        instanceId: resolvedInstanceId,
      });

      updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);
      broadcastMessage('message', { worktreeId, message });

      // Issue #1548: the agent is blocked on input. Raised after the dedup and
      // save above, so the task log counts prompts the system actually recorded
      // rather than every poll that saw the same one still on screen. No-ops
      // when this instance is not running a contract.
      applyEventToActiveTask(db, worktreeId, cliToolId, resolvedInstanceId, 'prompt_detected', {
        promptType: promptDetection.promptData?.type,
      });

      // Web Push fan-out (Issue #1125): agent is now waiting for a prompt reply.
      // Fire-and-forget — push is advisory and must never block/break the poller.
      //
      // Issue #1790: the wait is now named by #1786's episode rather than by the
      // prompt text. The two lines below are ordered, not incidental:
      //
      //  1. the notification is raised first, while it still has the prompt's
      //     own question to quote — it records the episode in the dedup, so
      //     whichever path reports the wait second says nothing;
      //  2. `observeWaitingEdge` then opens that same episode, which is what
      //     lets the edge listener (and #1788's WebSocket frame) agree with this
      //     call about *which* wait this is instead of raising a second one.
      //
      // Both use one timestamp so the episode the notification claims and the
      // episode the store opens are the same number.
      const promptObservedAt = Date.now();
      const promptWaitingSince =
        getWaitingEpisode(worktreeId, cliToolId, instanceId)?.since ?? promptObservedAt;

      // Issue #1999: Auto-Yes is a declaration that this session's prompts are
      // answered without a human, so notifying for one is telling the reader the
      // opposite of the truth. Only the notification is gated — the episode
      // below still opens, so the WebSocket frame, the status API and the #1790
      // reminder all see the wait exactly as they did before. The gate runs
      // before the call rather than inside it because `shouldSendWaitingPush`
      // records the episode the moment it decides to send.
      if (
        !isPromptPushSuppressed({
          worktreeId,
          cliToolId,
          instanceId,
          waitingSince: promptWaitingSince,
        })
      ) {
        void notifyPushSubscribers({
          worktreeId,
          worktreeName: worktree.name,
          kind: 'prompt',
          agentName: resolvedInstanceId,
          instanceId: resolvedInstanceId,
          waitingKind: 'prompt',
          waitingSince: promptWaitingSince,
          excerpt: promptDetection.promptData?.question ?? promptSaveContent,
        }).catch(() => {});
      }

      observeWaitingEdge({
        worktreeId,
        cliToolId,
        instanceId,
        waiting: true,
        kind: 'prompt',
        now: promptObservedAt,
      });

      if (!isFullScreenTui) {
        stopPolling(worktreeId, cliToolId, instanceId);
      }

      return true;
    }

    // Validate response content is not empty
    if (!result.response || result.response.trim() === '') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);
      return false;
    }

    // Parse Claude-specific metadata
    const claudeMetadata = cliToolId === 'claude'
      ? parseClaudeOutput(result.response)
      : undefined;

    // Clean up responses
    let cleanedResponse = result.response;
    if (cliToolId === 'gemini') {
      cleanedResponse = cleanGeminiResponse(result.response);
    } else if (cliToolId === 'claude') {
      cleanedResponse = cleanClaudeResponse(result.response);
    } else if (cliToolId === 'copilot') {
      const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
      const accumulatedContent = getAccumulatedContent(pollerKey);
      const sourceContent = accumulatedContent || result.response;
      cleanedResponse = cleanCopilotResponse(sourceContent);
      cleanedResponse = truncateMessage(cleanedResponse, COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER);

      clearTuiAccumulator(pollerKey);
    } else if (cliToolId === 'opencode') {
      const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
      // Issue #1911 defect 3: opencode wrote to the Layer-2 accumulator but never
      // read it, so any turn longer than the pane was saved without its head.
      //
      // Read it only when the head is ACTUALLY gone, which is what
      // `turnHeadTruncated` measures — deliberately NOT copilot's unconditional
      // `accumulated || response`. The accumulator appends whatever the overlap
      // check cannot match against the previous poll, and opencode rewrites rows
      // in place while it works (`+ Thought: … · 12ms` becomes `· 579ms`, a
      // pending patch row becomes the applied edit). Every such rewrite breaks
      // the overlap and re-appends the lines above it, so preferring the
      // accumulator for the common short answer would duplicate content that
      // `result.response` already holds exactly. When the echo is off screen the
      // frame is missing content outright, and a possible duplicate beats a
      // guaranteed truncation.
      const accumulatedContent = getAccumulatedContent(pollerKey);
      const sourceContent = result.turnHeadTruncated && accumulatedContent
        ? accumulatedContent
        : result.response;
      cleanedResponse = cleanOpenCodeResponse(sourceContent);

      clearTuiAccumulator(pollerKey);
    }

    // If cleaned response is empty or just "[No content]", skip saving
    if (!cleanedResponse || cleanedResponse.trim() === '' || cleanedResponse === '[No content]') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);
      clearInProgressMessageId(db, worktreeId, cliToolId, resolvedInstanceId);
      return false;
    }

    // Issue #1268: content-based dedup replaces the line-count cursor for
    // alternate-screen tools. Once a turn finishes, the screen stays static, so
    // every subsequent poll re-extracts byte-identical content; save it once.
    // The cache is cleared by stopPolling(), i.e. per polling cycle, so an
    // identical response in a later turn is still recorded.
    //
    // Issue #1670: keyed off `lineCountIsCursor` rather than the tool trait, so a
    // scrollback tool whose capture window has saturated gets the same substitute.
    // Without this the disabled cursor would leave nothing suppressing re-saves and
    // the poller would append the same finished reply every 2 s.
    if (!lineCountIsCursor) {
      const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
      if (isDuplicateResponse(pollerKey, cleanedResponse)) {
        // Issue #1695: this branch used to drop the response silently — the
        // prompt-side guard above has logged its skip since #565, this one
        // logged nothing at all, so a reply that never reached History left no
        // trace anywhere. Same action name shape as its sibling so both skips
        // are found by one grep.
        logger.info('duplicate-response-skipped', { worktreeId, cliToolId, instanceId: resolvedInstanceId });
        updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);
        return false;
      }
    }

    // Issue #2041: opencode's own server is publishing this reply as Markdown
    // over the SSE stream `lib/hooks/sources/opencode/history` is writing from,
    // so the scrape below would be a second copy of the same turn — the agent's
    // text once as it wrote it and once as its TUI drew it, 200 columns wide.
    //
    // Read here rather than at the top of the function on purpose: everything
    // above this line is bookkeeping the event stream has no second producer for
    // (the prompt row, Auto-Yes, the waiting episode, the push fan-out), and the
    // liveness answer is only allowed to suppress the two calls that RECORD THE
    // REPLY. See `./structured-history-gate` for the whole argument.
    //
    // Issue #2121 adds the second shape. Claude has no stream to be live on; it
    // has a transcript file, and this is the moment to read it — the turn is
    // finished (everything above this line established that) and the row is
    // about to be written. `captureStructuredHistoryTurn` writes the agent's own
    // Markdown and answers true, or answers false and leaves the scrape below to
    // be the only record. `||` and not `&&`: the two are different tools'
    // answers to the same question, and each one is false for the other's tool.
    const structuredHistoryLive =
      isStructuredHistoryWriterLive(worktreeId, cliToolId, instanceId) ||
      (await captureStructuredHistoryTurn(worktreeId, cliToolId, instanceId, {
        worktreePath: worktree.path,
        transcriptPathHint: claudeMetadata?.logFilePath ?? null,
      }));

    // Create Markdown log file for the conversation pair
    if (cleanedResponse && !structuredHistoryLive) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse, cliToolId);
    }

    // Mark any pending prompts as answered
    const answeredCount = markPendingPromptsAsAnswered(
      db,
      worktreeId,
      cliToolId,
      resolvedInstanceId,
      broadcastPromptSweptToAnswered(worktreeId),
    );
    if (answeredCount > 0) {
      logger.info('marked-answeredcount-pending');
    }

    // Race condition prevention: re-check session state before saving.
    // Issue #1268: skipped for alternate-screen tools for the same reason as the
    // dedup gates above — their line count never grows past the pane height.
    const currentSessionState = getSessionState(db, worktreeId, resolvedInstanceId);
    if (lineCountIsCursor && currentSessionState && result.lineCount <= currentSessionState.lastCapturedLine) {
      logger.info('race-condition-detected-skipping-save-re');
      return false;
    }

    // Issue #2041: the one write the structured path replaces. The scraped text
    // is dropped, not saved-and-deduped, because the two renderings of one turn
    // are not byte-comparable — the pane's copy is hard-wrapped at the pane
    // width and gutter-prefixed, so no content check could ever recognise them
    // as the same reply.
    if (!structuredHistoryLive) {
      // Create new CLI tool message in database
      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        content: cleanedResponse,
        messageType: 'normal',
        timestamp: new Date(),
        cliToolId,
        instanceId: resolvedInstanceId,
        summary: claudeMetadata?.summary,
        logFileName: claudeMetadata?.logFileName,
        requestId: claudeMetadata?.requestId,
      });

      // Broadcast message to WebSocket clients
      broadcastMessage('message', { worktreeId, message });
    } else {
      logger.info('structured-history-scrape-suppressed', {
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
        scrapedLength: cleanedResponse.length,
      });
    }

    // Issue #1790: the agent has just produced a reply, so whatever it was
    // waiting for is over. Closing the episode here is what makes a *second*
    // prompt in the same session notify again: without it a wait opened by the
    // prompt branch above could stay open until a browser next probes the status
    // API, and every later prompt would be folded into that stale episode and
    // silently deduped. Nothing to close is a no-op, and no notification is
    // raised for a closing edge.
    observeWaitingEdge({ worktreeId, cliToolId, instanceId, waiting: false });

    // Web Push fan-out (Issue #1125): session completed (running → idle).
    // Fire-and-forget — push is advisory and must never block/break the poller.
    void notifyPushSubscribers({
      worktreeId,
      worktreeName: worktree.name,
      kind: 'completion',
      agentName: resolvedInstanceId,
      excerpt: cleanedResponse,
    }).catch(() => {});

    // Update session state
    updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);

    // For full-screen TUIs, stop polling after saving the response.
    if (isFullScreenTui) {
      stopPolling(worktreeId, cliToolId, instanceId);
    }

    return true;
  } catch (error: unknown) {
    logger.error('response:check-failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
