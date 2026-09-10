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
import { detectAntigravityNumberedDialogPrompt } from '@/lib/detection/tools/antigravity/dialog';
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
  findCommandCodeChromeStart,
  findCopilotChromeStart,
  readCopilotStatusBar,
  COPILOT_BOOT_BANNER_ANCHORS,
  COPILOT_USER_ECHO_PATTERN,
  COPILOT_TRANSCRIPT_CONTINUATION_PATTERN,
  findOpenCodeChromeStart,
  findCodexChromeStart,
  findCodexUserEchoIndex,
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
// Issue #2457: the same rollout table, `hasDialogRules` cross-check and
// `detectDialog` seam Auto-Yes reads, reached through the presence helper rather
// than through `evaluateAutoYesDialogGate` — see `isNumberedDialogVouched`.
import { evaluateDialogPresence } from './auto-yes-dialog-gate';
import { recordPromptDedupSkip } from './prompt-dedup-state';
import {
  isDuplicateResponse,
  claimStructuredHistoryRecheck,
  markStructuredHistoryRecheckPending,
  settleStructuredHistoryRecheck,
} from './response-dedup';
import {
  captureStructuredHistoryTurn,
  isStructuredHistoryWriterLive,
  type StructuredHistoryCaptureReport,
} from './structured-history-gate';
import { STOP_TRANSCRIPT_DEFERRED_DELAYS_MS } from '@/lib/hooks/stop-history-capture';
import { onRelayTurnCompleted } from '@/lib/relay/relay-triggers';
// Issue #2317 Phase D: while a human holds the pane's geometry, the frame is
// their terminal (44 rows), not the 1000-row canvas every rule below was
// measured against. See the block in `checkForResponse` for what that changes.
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { probeGeometryDelegation } from '@/lib/tmux/geometry-delegation';
import { isLiveAttachEligibleSession } from '@/lib/session/tmux-session-surface';
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
 * The one reading of a frame that every consumer of it shares, for a capture
 * that has ALREADY been through `stripBoxDrawing(stripAnsi(…))`.
 *
 * Split out of {@link detectPromptWithOptions} by Issue #2368 so the Auto-Yes
 * poller can reach it. That poller cleans its own capture once per tick
 * (`captureAndCleanOutput`) and reuses the cleaned string and its line split for
 * the stop-condition delta, the dialog gate and the thinking check, so handing
 * it back through `detectPromptWithOptions` would clean it a SECOND time — and
 * `stripBoxDrawing` is not idempotent (it removes one leading `│` per pass, so a
 * doubly-bordered row loses a second character on the second pass). Taking the
 * already-clean frame here is what keeps the two callers reading identical text.
 *
 * @param cleanOutput - tmux output with ANSI **and** box drawing already removed
 * @param cliToolId - CLI tool identifier for building detection options
 * @param precomputedLines - `cleanOutput.split('\n')` when the caller already has it
 *   (Issue #499 Item 4); must be the split of THIS string, not of the raw capture
 * @returns PromptDetectionResult with isPrompt, promptData, and cleanContent
 */
export function detectPromptOnCleanFrame(
  cleanOutput: string,
  cliToolId: CLIToolType,
  precomputedLines?: string[],
): PromptDetectionResult {
  // Issue #2364: agy's `↑/↓ Navigate` dialogs are read by agy's own reader
  // before the generic pass, on the same spelling `tools/antigravity/detect.ts`
  // reads them on. The generic multiple-choice parser takes one row per option
  // and agy wraps a long command across several rows of one label, so without
  // this the poller stored nothing for the frame the status API published as a
  // prompt — and, on the file-creation menu, stored a question with the diff
  // preview joined into it. One reader for both producers is what makes the
  // stored `prompt` row, the push notification's excerpt and `/current-output`
  // agree about one screen.
  //
  // Issue #2368: and the Auto-Yes poller, which was the one consumer #2364 left
  // on the generic pass. agy's Bash approvals wrap their option labels with no
  // indentation, `isContinuationLine` refuses those rows, and the frame came
  // back `isPrompt: false` — so Auto-Yes sent nothing at all while the status
  // API published the very same screen as an answerable four-option prompt.
  if (cliToolId === 'antigravity') {
    const dialog = detectAntigravityNumberedDialogPrompt(cleanOutput);
    if (dialog !== null) return dialog;
  }
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(
    cleanOutput,
    precomputedLines ? { ...promptOptions, precomputedLines } : promptOptions,
  );
}

/**
 * Is the generic parser's numbered-list candidate a dialog the tool vouches for?
 * (Issue #2457)
 *
 * ## The candidate this removes
 *
 * `detectPrompt` classifies a frame as `multiple_choice` from the ROWS alone,
 * and for Claude `buildDetectPromptOptions` returns
 * `requireDefaultIndicator: false` — so a reply that happens to answer in
 * Markdown ("1. …  2. …  3. …") is a candidate with no `❯` anywhere near it.
 * Every one of those was stored as a `prompt` message, and the chat surface drew
 * a tool-approval chip over an ordinary answer.
 *
 * ## Why the whole frame, and only the frame
 *
 * `detectDialog` decides by POSITION and CHROME — where the option block sits
 * relative to the transcript tail, what (if anything) is drawn under it. None of
 * that survives being handed the extracted response, the question string or a
 * tail window, so the caller passes the same capture the candidate came off, as
 * captured: `evaluateDialogPresence` documents why the box drawing must still be
 * on it.
 *
 * ## What a `false` means downstream
 *
 * Not "there is no output here" — only "this is not a prompt". The caller falls
 * through to the ordinary completion/partial reading, so a real reply is still
 * saved by the normal path and a half-written one still reports
 * `isComplete: false`.
 *
 * @param cliToolId - CLI tool the frame came from
 * @param promptDetection - What the generic parser (or a tool reader) answered
 * @param frame - The whole capture this tick made, as captured
 * @returns True when the candidate may be treated as a live prompt
 */
export function isNumberedDialogVouched(
  cliToolId: CLIToolType,
  promptDetection: PromptDetectionResult,
  frame: string,
): boolean {
  const presence = evaluateDialogPresence(
    cliToolId,
    promptDetection.promptData?.type,
    frame,
  );
  if (presence.present) return true;

  // `debug`, not `info`: the poller re-reads a static idle pane every 2s, so a
  // reply carrying a numbered list would print this on every tick for as long as
  // it stays on screen. The suppression is not silent where it matters — nothing
  // is stored, so History simply shows the reply the ordinary path saves.
  logger.debug('prompt-candidate-not-vouched', {
    cliToolId,
    promptType: promptDetection.promptData?.type,
    gateMode: presence.mode,
  });
  return false;
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
  return detectPromptOnCleanFrame(stripBoxDrawing(stripAnsi(output)), cliToolId);
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

  // Issue #2250: Command Code is the fourth. Its landmark is its own — the
  // `❯ Ask your question...` composer fenced by two full-pane rules, with the
  // permission-mode row underneath — and it is load-bearing rather than tidy:
  // that placeholder is drawn with the same `❯ <text>` shape as a transcript
  // echo, so without the boundary `findRecentUserPromptIndex` anchors the turn
  // on the FOOTER and every reply extracts as empty (#1289's defect, verbatim).
  //
  // Issue #2400: codex is the fifth, and the one that had been missing. It pins
  // the same two rows — `› Ask Codex to do anything` and the `model · cwd`
  // status bar — and without a boundary the saturated-window anchor (#1670)
  // walked into them: the newest `›` in the pane was the COMPOSER, so extraction
  // started on the status bar and every reply on a saturated pane was saved as
  // that one row. `findCodexChromeStart` reads the composer by its SGR
  // attributes (#2310) rather than by its placeholder wording, which is what the
  // previous guard did and why it stopped working at codex 0.15x.
  const chromeStart = cliToolId === 'claude'
    ? findClaudeChromeStart(lines)
    : cliToolId === 'copilot'
      ? findCopilotChromeStart(lines)
      : cliToolId === 'command-code'
        ? findCommandCodeChromeStart(lines)
        : cliToolId === 'codex'
          ? findCodexChromeStart(lines)
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
      // Issue #2400: codex's three uses of `›` are separated by their SGR
      // attributes, not by their text (#2310). This branch used to exclude the
      // composer with a negative lookahead over its placeholder strings
      // (`Implement`, `Find and fix`, `Type`, `Summarize`) — codex 0.1x wording,
      // none of which 0.15x draws. `Ask Codex to do anything` passed the guard,
      // became the newest "echo", and on a saturated pane (#1670) — the only
      // path where this anchor decides where extraction STARTS — every reply was
      // saved as the single status-bar row below it.
      //
      // Two independent things now keep the composer out, and the reader needs
      // both because neither covers the other's frames: `contentEnd` cuts the
      // composer off structurally when `findCodexChromeStart` located it, and
      // when it did not, `findCodexUserEchoIndex` steps over the bottom-most
      // `›` row instead. The second is what still answers on an ANSI-stripped
      // capture, where none of #2310's attributes survive to be read.
      return findCodexUserEchoIndex(lines, contentEnd, windowSize, chromeStart >= 0);
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
  //
  // Issue #2250: `command-code` must be here. Its permission dialog draws its
  // highlighted option as `❯ 1. Yes` and keeps a full-pane rule above the block,
  // so `hasPrompt && hasSeparator && !isThinking` below is TRUE while the dialog
  // is waiting for an answer — the turn would be declared finished and the
  // dialog saved as the reply.
  if (
    cliToolId === 'claude' ||
    cliToolId === 'codex' ||
    cliToolId === 'copilot' ||
    cliToolId === 'command-code'
  ) {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    // Issue #2457: a candidate the tool's own rules cannot vouch for is not a
    // prompt, and returning here would declare the turn finished ON IT — the
    // early-completion half of the defect. Falling through leaves the ordinary
    // completion/partial reading to answer, which is what a reply containing a
    // numbered list needs. The gate is handed `fullOutput`, the capture itself,
    // not the string `detectPromptWithOptions` cleaned for the parser.
    if (promptDetection.isPrompt && isNumberedDialogVouched(cliToolId, promptDetection, fullOutput)) {
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
  // Issue #2250: claude's shape, because Command Code's layout is claude's — the
  // composer sits between two full-pane rules and is drawn only when the agent
  // will accept input. Deliberately NOT keyed on `✻ Worked for`: that row is the
  // live turn's, not the transcript's (it is present in `turn-version.txt` and
  // gone from `dialog-create-file.txt`, the same pane one prompt later) and
  // `WorkedDurationNote` omits it entirely for a turn under 1000 ms.
  const isCommandCodeComplete =
    cliToolId === 'command-code' && hasPrompt && hasSeparator && !isThinking;
  const isOpenCodeDone = cliToolId === 'opencode' && isOpenCodeComplete(cleanOutputToCheck);

  if (isPromptBasedComplete || isClaudeComplete || isCommandCodeComplete || isOpenCodeDone) {
    const responseLines: string[] = [];

    const startIndex = resolveExtractionStartIndex(
      lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
      captureWindowSaturated
    );

    // `contentEnd` bounds the content only; `endIndex` keeps reporting the full
    // buffer so lineCount bookkeeping in session_states is unchanged (#1289).
    //
    // Issue #2400: codex is the exception, and it is the pre-existing behaviour
    // rather than a new rule. Before this Issue the loop below stopped on the
    // composer's `›` and wrote that row's index into `endIndex`; now the composer
    // is outside `contentEnd`, so the break can no longer fire on it and
    // `endIndex` would silently advance ~3 rows further. Those rows matter for
    // codex specifically: it renders INLINE, and it repaints the composer band in
    // place — the next turn's transcript is printed over exactly the rows the
    // composer occupied in this capture. A cursor parked past them would skip
    // real content on the following poll. So the cursor stops where the content
    // stops, which is what it did before.
    let endIndex = cliToolId === 'codex' ? contentEnd : totalLines;

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

    // Issue #2250: Command Code's launch screen is a complete, idle frame --
    // block-art logo, three `#` banner rows, composer drawn between its two
    // rules -- so every check above accepts it, and History would open with
    // `# Command Code v1.40.1 / # models: … / # <cwd>` saved as the agent's
    // first reply before the operator has said anything.
    //
    // The rule is ONE condition and it is a positive one: Command Code echoes
    // every prompt into the transcript as `❯ <text>`, and the launch screen has
    // none. That is the shape #1897 and #2247 both converged on; the anchor
    // heuristics claude carries above (`hasBannerArt` / `hasVersionInfo` /
    // `hasStartupTips`) are deliberately NOT reproduced here, because they are
    // what #2247 had to take back -- a bare version string in a reply is a
    // normal reply, and Command Code prints its own version on every launch.
    //
    // `findRecentUserPromptIndex` is the same `/^[>❯]\s+\S/` scan the extraction
    // anchors on, and it stops at `contentEnd`, so the composer's own dim
    // `❯ Ask your question...` placeholder cannot be mistaken for an echo
    // (#1879's trap).
    if (cliToolId === 'command-code' && findRecentUserPromptIndex(totalLines) < 0) {
      logger.info('Command Code launch screen suppressed, response not saved', {
        responseLength: response.length,
      });
      return incompleteResult(totalLines);
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
    // Issue #2457: same gate as the early check above — this is the site a frame
    // reaches when the completion rules said "unfinished", so a candidate
    // accepted here would end the turn on it just the same.
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt && isNumberedDialogVouched(cliToolId, promptDetection, fullOutput)) {
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

// ============================================================================
// The held scrape (Issue #2436)
// ============================================================================

/**
 * How long a scraped reply is held while its transcript finishes closing.
 *
 * Derived from `STOP_TRANSCRIPT_DEFERRED_DELAYS_MS`, not spelled again: those
 * are the instants the Stop receiver re-reads the transcript at after it has
 * answered the agent (#2398), so their SUM is the moment after which nobody is
 * still trying. Holding past it would be holding for a row that has no producer
 * left; stopping short of it would race the producer that is still running.
 *
 * The measured gap this covers is under a second — codex 2026-09-08 appended
 * `task_complete` ~700 ms after the frame went quiet — so the budget is roughly
 * ten times the case it exists for, spent only on turns that ask for it.
 */
export const PENDING_SCRAPE_HOLD_MS = STOP_TRANSCRIPT_DEFERRED_DELAYS_MS.reduce(
  (total, delay) => total + delay,
  0
);

/**
 * A scraped reply the poller has read but not written yet (Issue #2436).
 *
 * Everything `checkForResponse` would have passed to `createMessage`, plus the
 * instant it decided to and the instant it stops waiting. The timestamp is the
 * one taken when the turn was JUDGED finished rather than when the row is
 * finally written: History sorts on it, and a row dated seven seconds late would
 * sort under the next turn's prompt.
 */
interface PendingScrapedResponse {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId: string;
  /** The pane's copy of the reply, cleaned. Replaced if the frame moves on. */
  content: string;
  readonly timestamp: Date;
  readonly summary?: string;
  readonly logFileName?: string;
  readonly requestId?: string;
  /** `transcriptPathHint` for the last-chance re-ask; see {@link settleExpiredPendingScrapedResponse}. */
  readonly worktreePath: string;
  readonly transcriptPathHint: string | null;
  /** `Date.now()` after which the hold is over and the row is written. */
  readonly expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __pendingScrapedResponses: Map<string, PendingScrapedResponse> | undefined;
}

/**
 * Held scrapes, by poller key.
 *
 * **Deliberately not in `./response-dedup`.** That module's two caches are
 * cleared by `stopPollingByKey` — `clearResponseHashCache` is called from
 * inside it — so a held reply parked beside them would be dropped by the very
 * event that has to write it (Issue #2436, requirement B). It lives here, next
 * to the code that fills it and the code that writes it out, and
 * `flushPendingScrapedResponse` is what the poller calls before it clears
 * anything.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and each route's bundle would otherwise
 * hold a private copy, and a held reply only one bundle can see is a lost one.
 */
const pendingScrapedResponses = (globalThis.__pendingScrapedResponses ??= new Map<
  string,
  PendingScrapedResponse
>());

/** Forget every held scrape. Test seam. */
export function resetPendingScrapedResponses(): void {
  pendingScrapedResponses.clear();
}

/** Whether a scrape is being held for this poller key. Test seam / diagnostics. */
export function hasPendingScrapedResponse(pollerKey: string): boolean {
  return pendingScrapedResponses.has(pollerKey);
}

/**
 * Hold this tick's scraped reply instead of writing it (Issue #2436).
 *
 * Called when the transcript reader has said `not_yet_closed`: the agent's own
 * Markdown for this turn is coming, and writing the pane's copy now is what put
 * 234,323 characters of prompt echo, intermediate output and footer into
 * History beside the real answer.
 *
 * A second hold for the same key REPLACES the content and keeps the original
 * deadline. Replaces, because a frame that moved on is a better copy of the
 * same turn; keeps, because a pane that redraws every tick would otherwise push
 * its own deadline forward forever and the hold would stop being bounded.
 */
function holdScrapedResponse(pollerKey: string, pending: PendingScrapedResponse): void {
  const existing = pendingScrapedResponses.get(pollerKey);
  if (existing) {
    existing.content = pending.content;
    return;
  }
  pendingScrapedResponses.set(pollerKey, pending);
}

/**
 * Drop a held scrape without writing it (Issue #2436).
 *
 * The one thing that justifies dropping it: the transcript reader has since
 * written the turn as the agent's own Markdown, so the pane's copy is the
 * duplicate this Issue exists to stop.
 */
function discardPendingScrapedResponse(pollerKey: string): void {
  pendingScrapedResponses.delete(pollerKey);
}

/**
 * Write a held scrape now, whatever the clock says (Issue #2436).
 *
 * Exported because `response-poller-core` calls it from `stopPollingByKey`,
 * which is every way a polling cycle ends: an explicit stop, the session going
 * away, `MAX_POLLING_DURATION`, and the restart that opens the NEXT turn. A
 * held reply must not be able to outlive the cycle that holds it — the caches
 * that key it are cleared in that same function, and a reply nobody writes is
 * strictly worse than the duplicate row this Issue is trading against.
 *
 * **Deliberately bypasses `isDuplicateResponse`.** The hash for this content was
 * registered by the tick that decided to hold it (the dedup guard's check is
 * also its write), so a re-check here would answer "duplicate" for the reply
 * that has never been saved. That is requirement A of the Issue in one line.
 *
 * Synchronous through the row: `better-sqlite3` is, and this runs on shutdown
 * paths where an awaited continuation may never be reached. The Markdown
 * conversation log is fired afterwards and not waited for, because it is a
 * secondary record and the row is the one History reads.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @param reason - What ended the hold; logged, for the operator reading back
 * @returns Whether a held reply was written
 */
export function flushPendingScrapedResponse(pollerKey: string, reason: string): boolean {
  const pending = pendingScrapedResponses.get(pollerKey);
  if (!pending) return false;
  pendingScrapedResponses.delete(pollerKey);

  try {
    const db = getDbInstance();
    const message = createMessage(db, {
      worktreeId: pending.worktreeId,
      role: 'assistant',
      content: pending.content,
      messageType: 'normal',
      timestamp: pending.timestamp,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      summary: pending.summary,
      logFileName: pending.logFileName,
      requestId: pending.requestId,
    });
    broadcastMessage('message', { worktreeId: pending.worktreeId, message });
    logger.info('pending-scrape-flushed', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      reason,
      scrapedLength: pending.content.length,
      heldForMs: Date.now() - pending.timestamp.getTime(),
    });
    void recordClaudeConversation(db, pending.worktreeId, pending.content, pending.cliToolId).catch(
      () => {}
    );
    return true;
  } catch (error) {
    logger.warn('pending-scrape-flush-failed', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * End a hold whose deadline has passed, one way or the other (Issue #2436).
 *
 * Run at the top of every tick, because the tick that has to notice an expiry
 * is very often one that returns early — a static frame yields no new lines for
 * a scrollback tool and is a duplicate for an alternate-screen one, and neither
 * of those paths reaches the save block at the bottom of `checkForResponse`.
 *
 * The reader is asked ONE more time before the row is written. By the deadline
 * the throttled recheck (#2399) has usually already captured the turn and
 * dropped the hold, but the two are not in step — the recheck is every third
 * duplicate tick and this is a wall clock — and a last read costs one tail
 * parse against writing a pane dump that is about to be superseded.
 */
async function settleExpiredPendingScrapedResponse(pollerKey: string): Promise<void> {
  const pending = pendingScrapedResponses.get(pollerKey);
  if (!pending || Date.now() < pending.expiresAt) return;

  const captured = await captureStructuredHistoryTurn(
    pending.worktreeId,
    pending.cliToolId,
    pending.instanceId,
    { worktreePath: pending.worktreePath, transcriptPathHint: pending.transcriptPathHint }
  );
  if (captured) {
    discardPendingScrapedResponse(pollerKey);
    settleStructuredHistoryRecheck(pollerKey);
    logger.info('pending-scrape-superseded', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      heldForMs: Date.now() - pending.timestamp.getTime(),
    });
    return;
  }

  flushPendingScrapedResponse(pollerKey, 'hold-expired');
}

/**
 * Record what the structured writers said about this turn, for the ticks that
 * will not get to ask (Issue #2399).
 *
 * One line either way, but named because the two calls are a pair and the
 * failure mode of writing only one of them is silent: mark without settle and
 * the reader is re-asked forever after a turn it already recorded; settle
 * without mark and the fix does not exist.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @param recorded - Whether a structured writer owns this turn
 */
function markOrSettleStructuredHistoryRecheck(pollerKey: string, recorded: boolean): void {
  if (recorded) {
    settleStructuredHistoryRecheck(pollerKey);
  } else {
    markStructuredHistoryRecheckPending(pollerKey);
  }
}

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
      // `stopPolling` is what confirms a held scrape here; see
      // `flushPendingScrapedResponse` and `stopPollingByKey`. Requirement B of
      // Issue #2436: this return is ~300 lines above the save path, so a hold
      // released only down there would never be released at all.
      stopPolling(worktreeId, cliToolId, instanceId);
      return false;
    }

    const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);

    // Issue #2436: a scrape held by an earlier tick, whose transcript has now
    // had its whole budget to close. Ahead of everything below because most
    // ticks of a finished turn never reach the save path — a static frame is a
    // duplicate for an alternate-screen tool and yields no new lines for a
    // scrollback one, and both of those return early.
    await settleExpiredPendingScrapedResponse(pollerKey);

    // Issue #2317 Phase D: is a human reading this pane at their own terminal
    // size right now, and did they just stop?
    //
    // Asked only for the tools `attach --live` accepts — no other session can be
    // delegated, so asking about one would be a tmux round-trip per poll with a
    // single possible answer. The read itself is memoised for a second
    // (`DELEGATION_TTL_MS`), which is under one poll interval.
    const sessionName = resolveSessionName(cliToolId, worktreeId, instanceId);
    const delegation = isLiveAttachEligibleSession(sessionName)
      ? await probeGeometryDelegation(sessionName)
      : { delegated: false, released: false };

    if (delegation.released) {
      // The canvas is 1000 rows again, so a cursor recorded against a 44-row
      // frame indexes into a pane that no longer exists. Zero is the only value
      // that cannot be wrong in either direction: too low re-saves a turn, too
      // high suppresses every future one. Done BEFORE the state is read below so
      // this poll already sees the reset.
      //
      // A no-op for claude in practice — it renders in the alternate screen, so
      // `lineCountIsCursor` is false and the cursor is not consulted — and that
      // is exactly why it is written here rather than left implicit: the guard
      // has to already be right on the day a scrollback tool is added to
      // `LIVE_ATTACH_TOOLS`.
      updateSessionState(db, worktreeId, cliToolId, 0, resolvedInstanceId);
      logger.info('geometry-delegation-released', {
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
      });
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

    // Issue #2457: the gate is applied HERE as well as in `extractResponse`, and
    // to a carried `result.promptDetection` as well as to one derived on this
    // line. Two independent reasons, either one sufficient:
    //
    //  1. the fallback above reads `result.response` — the EXTRACTED text, with
    //     the pane's chrome already cut off — so a reply's `1. / 2. / 3.` rows
    //     look even more like a dialog here than they did upstream, and a tool
    //     the early check never runs for (opencode) reaches the save path only
    //     through this line;
    //  2. `promptDetection` carried from `extractResponse` is the one thing that
    //     could walk a candidate past the gate unexamined, and this is the last
    //     position before the row is written.
    //
    // The frame is the capture this tick made — never `result.response`, which
    // has lost the position `detectDialog` judges by.
    const promptIsLive =
      promptDetection.isPrompt && isNumberedDialogVouched(cliToolId, promptDetection, output);

    if (promptIsLive) {
      // Issue #565: Content hash-based duplicate prompt prevention
      const promptContent = promptDetection.rawContent || promptDetection.cleanContent;
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
      const accumulatedContent = getAccumulatedContent(pollerKey);
      const sourceContent = accumulatedContent || result.response;
      cleanedResponse = cleanCopilotResponse(sourceContent);
      cleanedResponse = truncateMessage(cleanedResponse, COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER);

      clearTuiAccumulator(pollerKey);
    } else if (cliToolId === 'opencode') {
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
      if (isDuplicateResponse(pollerKey, cleanedResponse)) {
        // Issue #1695: this branch used to drop the response silently — the
        // prompt-side guard above has logged its skip since #565, this one
        // logged nothing at all, so a reply that never reached History left no
        // trace anywhere. Same action name shape as its sibling so both skips
        // are found by one grep.
        logger.info('duplicate-response-skipped', { worktreeId, cliToolId, instanceId: resolvedInstanceId });
        updateSessionState(db, worktreeId, cliToolId, result.lineCount, resolvedInstanceId);

        // Issue #2399: the skip above is about the SCREEN, and until this Issue
        // it also ended the tick for the TRANSCRIPT READER 100 lines below —
        // which is the one consumer for whom "the frame has not changed" is not
        // evidence of anything. A pull-mode agent closes its turn in its own
        // file AFTER the pane has gone quiet, so the reader's single ask (on the
        // poll that saved the scrape) is systematically too early, and every
        // later poll returned here. Measured on codex 2026-09-07: one
        // `codex-transcript-turn-open`, `task_complete` appended 1.8 s later,
        // and then `duplicate-response-skipped` every 2 s until
        // `MAX_POLLING_DURATION` ran out. The Markdown row was never written and
        // the only thing left in History was the scrape — for a saturated pane,
        // a single footer line.
        //
        // So the reader is re-asked from inside the skip, throttled by
        // `claimStructuredHistoryRecheck` (once on the first duplicate tick,
        // then every third — see `./response-dedup`). Deliberately the reader
        // and nothing else: the scrape stays suppressed, the cursor has already
        // been advanced above, and none of the bookkeeping the guard skips has a
        // second producer to be asked about.
        //
        // Order over the alternative in the Issue (hoist the reader above the
        // guard): the reader is a WRITE, and hoisting it would run that write on
        // every one of the 900 ticks of a 30-minute cycle instead of on the ones
        // that are owed an answer — the same argument the #2317 Phase D comment
        // below makes for not letting the delegation test short-circuit it.
        //
        // What this does NOT do is retract the scraped row the earlier tick
        // saved. Three reasons, and the first is decisive: nothing here can
        // identify that row. The hash this guard matched is per pollerKey, not
        // per turn — it survives the `resume` of a chain paused on a prompt —
        // so the row it stands for may belong to an earlier turn entirely, and
        // a scraped row carries no turn key to join on. Second, `archived` in
        // this schema is the tombstone of an operator clearing History (#168),
        // written by `archiveMessages` for a whole worktree; reusing it for
        // "superseded" would make a clear and a handover indistinguishable in
        // the table. Third, the scrape is not always junk — when a turn is
        // interrupted the pane holds text the transcript's closed turn does not
        // — and a duplicated row is visible and recoverable where a deleted one
        // is neither. Two rows for one turn is the failure this trades for, and
        // #2401 has already stopped the junk one being picked as a relay's
        // answer.
        //
        // Issue #2436 narrowed what that trade costs, without changing the
        // decision above. The row this skip cannot retract is now only ever one
        // the poller had no reason to hold: a turn whose reader said
        // `not_yet_closed` is held at the save path below rather than written,
        // so on the ordinary codex turn there is no earlier row here to regret.
        // What remains is the case the three reasons above are actually about —
        // a scrape written when the reader could tell us nothing, and a
        // transcript that closed later anyway — and for that the row stays,
        // folded rather than deleted on the chat surface (`ChatMessageBubble`).
        if (claimStructuredHistoryRecheck(pollerKey)) {
          const recaptured = await captureStructuredHistoryTurn(worktreeId, cliToolId, instanceId, {
            worktreePath: worktree.path,
            transcriptPathHint: claudeMetadata?.logFilePath ?? null,
          });
          if (recaptured) {
            settleStructuredHistoryRecheck(pollerKey);
            // Issue #2436: the turn is now the agent's own Markdown, so a
            // scrape held for it is exactly the second row this Issue exists
            // to stop. Dropped, not written — the only case where dropping a
            // held reply loses nothing.
            discardPendingScrapedResponse(pollerKey);
            logger.info('structured-history-recheck-captured', {
              worktreeId,
              cliToolId,
              instanceId: resolvedInstanceId,
            });
            // The turn IS now in History, as the agent's own Markdown, so this
            // tick recorded something and says so. Inert for the poller either
            // way: `runPollTick` only reads this value after a stop the tick
            // raised itself, and this branch raises none.
            return true;
          }
        }
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
    //
    // Issue #2436 adds the third answer. `captureReport.outcome` distinguishes
    // "the agent has not closed this turn yet" from "there is nothing to read
    // here", which the boolean could not: both arrived as `false`, and `false`
    // meant "save the pane's copy". See {@link StructuredHistoryCaptureOutcome}.
    const captureReport: StructuredHistoryCaptureReport = {};
    const structuredHistoryLive =
      isStructuredHistoryWriterLive(worktreeId, cliToolId, instanceId) ||
      (await captureStructuredHistoryTurn(
        worktreeId,
        cliToolId,
        instanceId,
        {
          worktreePath: worktree.path,
          transcriptPathHint: claudeMetadata?.logFilePath ?? null,
        },
        captureReport
      ));

    // Issue #2399: remember which way that went, because the next tick may not
    // get here. A `false` is the reader saying "not yet, or not mine", and the
    // dedup guard above turns every following poll of the same static frame into
    // a return — so unless the fact is written down now, the ask never happens
    // again. A `true` settles it: the turn is recorded and there is nothing left
    // to re-ask about.
    markOrSettleStructuredHistoryRecheck(pollerKey, structuredHistoryLive);

    // Issue #2317 Phase D: the scrape is dropped while the geometry is
    // delegated, and the transcript capture above is what makes that safe.
    //
    // ORDER IS LOAD-BEARING. The delegation test is folded in AFTER the two
    // calls above rather than short-circuiting them: `captureStructuredHistoryTurn`
    // is a WRITE, not a query — it is the moment claude's own transcript becomes
    // a History row — so an `||` that put the delegation first would suppress
    // the scrape and the real reply together, and the turn would vanish. Read as
    // it stands: record the turn from the agent's own file, then drop the pane's
    // copy of it, which at 44 rows is a fraction of the answer hard-wrapped at
    // the reader's terminal width.
    //
    // When the transcript capture answers false (an unreadable or absent file)
    // the turn goes UNRECORDED for as long as the delegation lasts. That is the
    // deliberate trade: a missing row is recoverable, a truncated reply saved as
    // the agent's answer is not.
    const suppressScrapedHistory = structuredHistoryLive || delegation.delegated;

    // Issue #2436: not suppressed — HELD. The reader has read the transcript,
    // found the newest turn still open and said so, which means the agent's own
    // Markdown for this turn is on its way. Writing the pane's copy now is what
    // put a 234,323-character dump of prompt echo, intermediate output and
    // footer into History beside the real answer, and #2399 explicitly accepted
    // that trade because the boolean it had could not tell "not yet" from
    // "never". It can now.
    //
    // Everything else this tick does still happens: the cursor advances, the
    // prompts are marked answered, the waiting episode closes, the push goes
    // out. Only the two writes that RECORD THE REPLY wait.
    const holdScrapedHistory = !suppressScrapedHistory && captureReport.outcome === 'not_yet_closed';

    // Create Markdown log file for the conversation pair
    if (cleanedResponse && !suppressScrapedHistory && !holdScrapedHistory) {
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
    if (holdScrapedHistory) {
      holdScrapedResponse(pollerKey, {
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
        content: cleanedResponse,
        // The instant the turn was JUDGED finished, not the instant the row is
        // written. History sorts on this, and a row dated at the end of the
        // hold would sort under the NEXT turn's prompt.
        timestamp: new Date(),
        summary: claudeMetadata?.summary,
        logFileName: claudeMetadata?.logFileName,
        requestId: claudeMetadata?.requestId,
        worktreePath: worktree.path,
        transcriptPathHint: claudeMetadata?.logFilePath ?? null,
        expiresAt: Date.now() + PENDING_SCRAPE_HOLD_MS,
      });
      logger.info('structured-history-scrape-held', {
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
        scrapedLength: cleanedResponse.length,
        holdMs: PENDING_SCRAPE_HOLD_MS,
      });

      // The completion edge is announced HERE and not at the flush, because the
      // turn finished now. A relay waiting on this session gets #2401's grace
      // window to find a turn-keyed row, which is exactly the row the hold is
      // waiting for; delaying the announcement by the hold would delay every
      // delivery by it too.
      onRelayTurnCompleted(worktreeId, cliToolId, resolvedInstanceId, false);
    } else if (!suppressScrapedHistory) {
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

      // Issue #2377: the scrape path's completion edge. `settled: false` is the
      // whole difference from the gate's own announcement: this row was read off
      // a SCREEN whose completion was judged by string analysis, so a relay
      // waiting on this session re-reads after a few seconds of quiet before it
      // delivers — the Issue's 「完了検知 + 数秒の静穏」 for the three tools that
      // keep no transcript. Announced here rather than after the `if` because
      // the suppressed branch means the gate already announced it, settled.
      onRelayTurnCompleted(worktreeId, cliToolId, resolvedInstanceId, false);
    } else {
      // Issue #2436: a hold from an earlier tick of this same turn is now moot
      // — the row it was waiting for exists.
      if (structuredHistoryLive) discardPendingScrapedResponse(pollerKey);
      logger.info('structured-history-scrape-suppressed', {
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
        scrapedLength: cleanedResponse.length,
        // Which of the two reasons suppressed it. Without this the Phase D case
        // and the ordinary #2041/#2121 handover are one indistinguishable log
        // line, and "History is missing a turn" has two very different causes.
        reason: structuredHistoryLive ? 'structured-history' : 'geometry-delegated',
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
