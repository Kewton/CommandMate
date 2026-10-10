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
import { liveRegionOf, normalizeFrame } from '@/lib/detection/tools/frame';
import { isQuotedNumberedPrompt } from '@/lib/detection/tools/live-region';
import type { NormalizedFrame } from '@/lib/detection/tools/types';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { parseClaudeOutput } from '@/lib/claude-output';
import {
  getCliToolPatterns,
  stripAnsi,
  stripBoxDrawing,
  buildDetectPromptOptions,
} from '@/lib/detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';

const logger = createLogger('response-poller');

// Sub-module imports
import { sliceOpenCodeTurn } from '../response-extractor';
import { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse, cleanCopilotResponse, truncateMessage } from '../response-cleaner';
import { COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER } from '@/config/copilot-constants';
import {
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { isDuplicatePrompt, normalizePromptForDedup } from './prompt-dedup';
import { recordPromptDedupSkip } from './prompt-dedup-state';
import {
  isDuplicateResponse,
  claimDuplicateResponseSkipLog,
  claimStructuredHistoryRecheck,
  markStructuredHistoryRecheckPending,
  settleStructuredHistoryRecheck,
} from './response-dedup';
import {
  captureStructuredHistoryTurn,
  isStructuredHistoryWriterLive,
  type StructuredHistoryCaptureReport,
} from './structured-history-gate';
import {
  PENDING_SCRAPE_HOLD_MS,
  holdScrapedResponse,
  discardPendingScrapedResponse,
  settleExpiredPendingScrapedResponse,
} from './pending-scraped-response';
// Issue #3213: the held scrape (#2436) lives in `./pending-scraped-response`.
// Re-exported under the names it had here, so no import site — and no suite
// that replaces this module by path — has to change.
export {
  PENDING_SCRAPE_HOLD_MS,
  resetPendingScrapedResponses,
  hasPendingScrapedResponse,
  flushPendingScrapedResponse,
} from './pending-scraped-response';
import { onRelayTurnCompleted } from '@/lib/relay/relay-triggers';
// Issue #2317 Phase D: while a human holds the pane's geometry, the frame is
// their terminal (44 rows), not the 1000-row canvas every rule below was
// measured against. See the block in `checkForResponse` for what that changes.
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { probeGeometryDelegation } from '@/lib/tmux/geometry-delegation';
import { isLiveAttachEligibleSession } from '@/lib/session/tmux-session-surface';
import { getPollerKey, stopPolling } from './response-poller-core';
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

// Issue #3374: the extraction result, the two dialog gates and the steps split
// out of `extractResponse` live in their own modules. The exported names are
// re-exported under the names they had here, so no import site — and no suite
// that replaces this module by path — has to change. `detectPromptOnCleanFrame`,
// `detectPromptWithOptions` and `extractResponse` stay here:
// `tests/unit/guards/prompt-detector-single-entry-2368.test.ts` pins this file as
// the one that calls `detectPrompt`, and only this file may import
// `@/lib/tmux/tmux-capture-cache` (.eslintrc.json `no-restricted-imports`).
import {
  type ExtractionResult,
  buildPromptExtractionResult,
} from './response-checker-extraction-result';
export {
  type ExtractionResult,
  incompleteResult,
  buildPromptExtractionResult,
} from './response-checker-extraction-result';
import {
  type AntigravityReceiptScope,
  isWithheldForWantOfReceipt,
  isNumberedDialogVouched,
} from './response-checker-dialog-gate';
export {
  type AntigravityReceiptScope,
  isNumberedDialogVouched,
} from './response-checker-dialog-gate';
import {
  findChromeStart,
  findRecentUserPromptIndexInFrame,
  type ExtractionContext,
  isTurnComplete,
  extractCompletedResponse,
  extractPartialResponse,
} from './response-checker-extraction-steps';

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
 * ## The raw frame, and why it is a SECOND argument rather than a replacement
 *
 * Issue #2522. Command Code's `AskUserQuestion` is anchored on a 200-column
 * U+2500 rule row, and `stripBoxDrawing` blanks exactly that row — so the
 * reading that recognises the screen answers `null` on the spelling this
 * function takes, however plainly the dialog is on the pane. The frame the
 * cleaning started from is therefore passed alongside it: the caller has it in
 * hand from the same tick, no second capture is taken, and `stripBoxDrawing`
 * (which is not idempotent) still runs exactly once per tick, upstream.
 *
 * Omitting `rawFrame` is not an error and not a silent downgrade for anything
 * else: only Command Code's reader consults it, and a caller that has no raw
 * frame for this tool reaches the same `null` the old code did.
 *
 * @param cleanOutput - tmux output with ANSI **and** box drawing already removed
 * @param cliToolId - CLI tool identifier for building detection options
 * @param precomputedLines - `cleanOutput.split('\n')` when the caller already has it
 *   (Issue #499 Item 4); must be the split of THIS string, not of the raw capture
 * @param rawFrame - the SAME tick's capture with its box drawing intact (ANSI
 *   optional), for the tool readers anchored on it (Issue #2522)
 * @param receiptScope - whose frame this is, when the caller answers it
 *   automatically (Issue #2849). For agy only: a frame that reads as a prompt is
 *   then handed back as no prompt unless agy asked CommandMate about a tool call
 *   for that instance a moment ago. Omitted, the reading is not gated — which is
 *   what every caller that only DISPLAYS the frame wants.
 * @param frame - the SAME tick's `normalizeFrame(raw, cliToolId)`, when the
 *   caller built one (Issue #3183). The Auto-Yes poller builds it once and hands
 *   the same object to the dialog gate, so the quotation veto below and the gate
 *   read one live region. Omitted, it is built here from `rawFrame` (or, failing
 *   that, `cleanOutput`).
 * @returns PromptDetectionResult with isPrompt, promptData, and cleanContent
 */
export function detectPromptOnCleanFrame(
  cleanOutput: string,
  cliToolId: CLIToolType,
  precomputedLines?: string[],
  rawFrame?: string,
  receiptScope?: AntigravityReceiptScope,
  frame?: NormalizedFrame,
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
    if (dialog !== null) {
      return isWithheldForWantOfReceipt(receiptScope)
        ? { isPrompt: false, cleanContent: cleanOutput.trim() }
        : dialog;
    }
  }

  // Issue #2522: Command Code's footer-less `AskUserQuestion`, read by the same
  // module `tools/command-code/detect.ts` publishes its status from — so the
  // status API, the row this poller stores, the push notification's excerpt and
  // `/prompt-response`'s re-verification all describe ONE screen with one
  // question, one option list and one default.
  //
  // Ahead of the generic pass rather than after it, and both halves matter:
  //
  //  - `prompt` — the generic parser SUCCEEDS on the short, unwrapped spelling
  //    of this screen and drags the tab strip and the transcript row above it
  //    into the question, so "fall back to the reader" would leave the frames
  //    that look fine looking wrong;
  //  - `unsupported` — the question UI is up and the reading declined (a gap in
  //    the numbering, an over-tall region). 確定仕様 B: no `promptData`, and
  //    explicitly NOT the generic parser's partial list either. The status path
  //    publishes #2521's manual-operation fallback for the same frame, so a
  //    human is still told to answer it at the pane.
  if (cliToolId === 'command-code' && rawFrame !== undefined) {
    const reading = readCommandCodeQuestionDialog(rawFrame);
    if (reading.kind === 'prompt') return reading.prompt;
    if (reading.kind === 'unsupported') {
      return { isPrompt: false, cleanContent: cleanOutput.trim() };
    }
  }

  const promptOptions = buildDetectPromptOptions(cliToolId);
  const result = detectPrompt(
    cleanOutput,
    precomputedLines ? { ...promptOptions, precomputedLines } : promptOptions,
  );

  // Issue #3183 (agy-only before, #2851): a numbered list on a frame whose
  // input box is the bottom of the pane is a quotation — a reply quoting a
  // dialog, or one left in the scrollback — and is not a prompt to answer. The
  // status side declines the same candidate with the same rule on the same
  // region (`run-detection.ts`), so `waiting` and an automatic answer cannot
  // disagree about one frame. Every tool, not only agy: #2851 reached Auto-Yes
  // because agy's `>` is not one of the glyphs the generic parser stops at, and
  // opencode's gutter is not either.
  //
  // `rawFrame` when there is no prebuilt frame: the input-box markers are rule
  // rows that the cleaned spelling has blanked. `stripBoxDrawing` is not
  // idempotent, so the cleaned string is never cleaned again here.
  if (result.isPrompt) {
    const liveRegion = frame !== undefined
      ? liveRegionOf(frame, cliToolId)
      : normalizeFrame(rawFrame ?? cleanOutput, cliToolId).liveRegion;
    if (isQuotedNumberedPrompt(liveRegion, result)) {
      return { isPrompt: false, cleanContent: cleanOutput.trim() };
    }
  }

  // Issue #2849: the same withholding on this exit. agy's reader answering `null`
  // does not mean the frame is no dialog — the generic pass above reads shapes
  // agy's reader declines, and #2851 showed it can read a quotation — so a gate
  // that covered only the reader's exit would leave this one open.
  if (cliToolId === 'antigravity' && result.isPrompt && isWithheldForWantOfReceipt(receiptScope)) {
    return { isPrompt: false, cleanContent: cleanOutput.trim() };
  }
  return result;
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
  // Issue #2522: `output` is the capture, so the box-drawing-bearing spelling is
  // right here and is handed on as `rawFrame`. Nothing is captured twice and
  // nothing is cleaned twice — the fourth argument is the string the first one
  // was DERIVED from.
  return detectPromptOnCleanFrame(stripBoxDrawing(stripAnsi(output)), cliToolId, undefined, output);
}

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
 * @returns Null when there is no new output; otherwise the extraction result,
 *   with `isComplete: false` when the response is not finished yet
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

  const chromeStart = findChromeStart(cliToolId, lines, openCodeCleanLines);
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

  const findRecentUserPromptIndex = (windowSize: number = 60): number =>
    findRecentUserPromptIndexInFrame(cliToolId, lines, openCodeCleanLines, chromeStart, contentEnd, windowSize);

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

  // Issue #3213: what the steps split out of this function read off the frame.
  const ctx: ExtractionContext = {
    cliToolId, lines, totalLines, openCodeCleanLines, chromeStart, contentEnd,
    lastCapturedLine, bufferReset, captureWindowSaturated, checkLineCount, cleanOutputToCheck,
    promptPattern, separatorPattern, thinkingPattern, skipPatterns,
    findRecentUserPromptIndex,
  };

  if (isTurnComplete(ctx)) {
    return extractCompletedResponse(ctx);
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

  return extractPartialResponse(ctx);
}

// ============================================================================
// checkForResponse (exported for response-poller-core.ts)
// ============================================================================

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

// The steps of checkForResponse's save path, split out one function per step
// (Issue #3213). They are declared in the order checkForResponse calls them, and
// each is called at the position its lines had, so nothing a step writes — a
// row, a broadcast, a log line, poller state — moved relative to anything else.
// The comments inside were written in place: "above" and "below" in them are
// positions in checkForResponse.

/**
 * What one `checkForResponse` tick is keyed by, as handed to the steps split
 * out of it (Issue #3213).
 *
 * One object rather than seven positional arguments because four of them are
 * strings a call site could transpose without a type error. Each step
 * destructures the names it uses, so the moved lines read exactly as they did
 * inside `checkForResponse`.
 */
interface ResponseCheckContext {
  db: ReturnType<typeof getDbInstance>;
  worktree: NonNullable<ReturnType<typeof getWorktreeById>>;
  worktreeId: string;
  cliToolId: CLIToolType;
  /** As passed to `checkForResponse`: undefined for the primary instance. */
  instanceId: string | undefined;
  /** `instanceId ?? cliToolId`. */
  resolvedInstanceId: string;
  pollerKey: string;
}

/**
 * What a tick goes on with once its frame has been read as a finished turn. The
 * three are computed in {@link extractCompletedTurn}, where the comments on each
 * say why.
 */
interface CompletedTurn {
  result: ExtractionResult;
  isFullScreenTui: boolean;
  lineCountIsCursor: boolean;
}

/**
 * Read the frame this tick captured: is there a finished turn on it that the
 * cursor has not already counted?
 *
 * The part of {@link checkForResponse} between the capture and the prompt
 * check, split out as it was (Issue #3213). It starts on the line after the
 * capture's `await` and holds no `await` of its own, so it moved as a
 * synchronous function and the call adds no yield. The part above it — the
 * session check through the capture — has four, and stays where it was: a
 * function holding them would have to be awaited, and that yield would fall
 * between the capture and everything this tick does with it.
 *
 * Not a pure read. It feeds the fault notifier and the Layer-2 accumulator on
 * every tick, and on an unfinished frame it may mark pending prompts answered.
 *
 * Every `return false` is the tick's own result; the caller returns it as it is.
 *
 * @param ctx - What this tick is keyed by
 * @param output - The capture this tick made
 * @param lastCapturedLine - Its cursor, 0 when there is none
 * @returns What the tick goes on with, or `false` when the tick ends here
 */
function extractCompletedTurn(
  ctx: ResponseCheckContext,
  output: string,
  lastCapturedLine: number
): CompletedTurn | false {
  const { db, worktreeId, cliToolId, instanceId, resolvedInstanceId, pollerKey } = ctx;

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
      // Intended twin of the sweep in recordCompletedResponse: this one runs when
      // working is visible on an unfinished frame, that one when a response is
      // recorded (Issue #31).
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
  if (lineCountIsCursor && !result.bufferReset && result.lineCount === lastCapturedLine) {
    return false;
  }

  if (lineCountIsCursor && !result.bufferReset && result.lineCount <= lastCapturedLine) {
    // Every poll of a finished, unchanged screen lands here, so it is debug.
    logger.debug('already-saved-up-to-last-captured-line', {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      lineCount: result.lineCount,
      lastCapturedLine,
    });
    return false;
  }

  return { result, isFullScreenTui, lineCountIsCursor };
}

/**
 * Save a live prompt as a prompt message, and raise what follows from it: the
 * task event, the push notification and the waiting episode.
 *
 * The body of the `if (promptIsLive)` branch of {@link checkForResponse}, split
 * out as it was (Issue #3213). Both returns are the tick's own result — `false`
 * for a prompt the dedup has already recorded, `true` once the row is written.
 *
 * @param ctx - What this tick is keyed by
 * @param promptDetection - The detection that passed the #2457 gate
 * @param result - The complete extraction this tick made
 * @param isFullScreenTui - True for opencode and copilot, which keep polling after a prompt
 * @returns What `checkForResponse` returns for this tick
 */
function savePromptMessage(
  ctx: ResponseCheckContext,
  promptDetection: PromptDetectionResult,
  result: ExtractionResult,
  isFullScreenTui: boolean
): boolean {
  const { db, worktree, worktreeId, cliToolId, instanceId, resolvedInstanceId, pollerKey } = ctx;

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

/**
 * Clean a complete response the way its tool needs before it is saved.
 *
 * The "Clean up responses" step of {@link checkForResponse}, split out as it
 * was (Issue #3213). Not a pure function: for copilot and opencode it reads the
 * Layer-2 accumulator and clears it, so it is called once per tick, at the
 * position the step had.
 *
 * @param cliToolId - CLI tool identifier
 * @param result - The complete extraction this tick made
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @returns The cleaned response
 */
function cleanCompletedResponse(
  cliToolId: CLIToolType,
  result: ExtractionResult,
  pollerKey: string
): string {
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

  return cleanedResponse;
}

/**
 * Skip a response the content dedup has already seen, and re-ask the transcript
 * reader on the ticks that are owed an answer (Issue #2399).
 *
 * The body of the `isDuplicateResponse` branch of {@link checkForResponse},
 * split out as it was (Issue #3213). Both returns are the tick's own result,
 * and the caller returns it without doing anything else — so the one `await`
 * this split adds comes after every write of the tick.
 *
 * @param ctx - What this tick is keyed by
 * @param result - The complete extraction this tick made
 * @param claudeMetadata - Claude's parsed metadata, undefined for every other tool
 * @returns What `checkForResponse` returns for this tick
 */
async function recheckDuplicateResponse(
  ctx: ResponseCheckContext,
  result: ExtractionResult,
  claudeMetadata: ReturnType<typeof parseClaudeOutput> | undefined
): Promise<boolean> {
  const { db, worktree, worktreeId, cliToolId, instanceId, resolvedInstanceId, pollerKey } = ctx;

  // Issue #1695: this branch used to drop the response silently — the
  // prompt-side guard above has logged its skip since #565, this one
  // logged nothing at all, so a reply that never reached History left no
  // trace anywhere. Same action name shape as its sibling so both skips
  // are found by one grep.
  //
  // Issue #3519: but not on every tick. A finished screen that stays up is a
  // duplicate on each of the cycle's 900 ticks, and logging all of them was
  // 51,933 lines a day. The first tick of a run logs exactly as before; after
  // that one line per `DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL` ticks, with
  // the run length and how many ticks went unlogged since the last line.
  const skipLog = claimDuplicateResponseSkipLog(pollerKey);
  if (skipLog.log) {
    logger.info('duplicate-response-skipped', {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      ...(skipLog.consecutive > 1 ? { consecutive: skipLog.consecutive, suppressed: skipLog.suppressed } : {}),
    });
  }
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

/**
 * What a tick decided to do with the pane's copy of a finished reply. The three
 * are computed in {@link recordCompletedResponse}, where the comments on each
 * say why.
 */
interface ScrapedHistoryDecision {
  structuredHistoryLive: boolean;
  suppressScrapedHistory: boolean;
  holdScrapedHistory: boolean;
}

/**
 * Hold the scraped reply, write it as a message, or drop it.
 *
 * The three-way branch on the save path of {@link checkForResponse}, split out
 * as it was (Issue #3213). Only the branch moved. What decides it — the
 * structured-history gate and the conversation log, both awaited — stays in
 * the caller, {@link recordCompletedResponse}, together with the writes that
 * follow the call (the waiting edge, the push, the cursor): an `await` on a
 * function holding the first without the second would put a yield between the
 * writes here and those, and `onRelayTurnCompleted` starts work that could then
 * run in between.
 *
 * @param ctx - What this tick is keyed by
 * @param cleanedResponse - The cleaned response
 * @param claudeMetadata - Claude's parsed metadata, undefined for every other tool
 * @param decision - Whether the scrape is held, written or suppressed
 */
function recordOrHoldScrapedResponse(
  ctx: ResponseCheckContext,
  cleanedResponse: string,
  claudeMetadata: ReturnType<typeof parseClaudeOutput> | undefined,
  decision: ScrapedHistoryDecision
): void {
  const { db, worktree, worktreeId, cliToolId, resolvedInstanceId, pollerKey } = ctx;
  const { structuredHistoryLive, suppressScrapedHistory, holdScrapedHistory } = decision;

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
}

/**
 * Record a finished reply and close the tick: the structured-history gate, the
 * conversation log, the prompt sweep, the scrape, the waiting edge, the push
 * and the cursor.
 *
 * The rest of {@link checkForResponse} from the structured-history gate to its
 * last return, split out as it was (Issue #3213). One function, tail included,
 * on purpose: the gate and the conversation log are awaited, and everything
 * after them, from the prompt sweep to `stopPolling`, runs without a yield. Cut
 * anywhere short of the last return and the caller's `await` would put one
 * inside that run. Taken whole, the one `await` the split adds comes after
 * every write of the tick, as in {@link recheckDuplicateResponse}. Both returns
 * are the tick's own result.
 *
 * @param ctx - What this tick is keyed by
 * @param turn - The finished turn this tick read off the frame
 * @param claudeMetadata - Claude's parsed metadata, undefined for every other tool
 * @param cleanedResponse - The cleaned response
 * @param delegation - What the geometry-delegation probe answered for this tick
 * @returns What `checkForResponse` returns for this tick
 */
async function recordCompletedResponse(
  ctx: ResponseCheckContext,
  turn: CompletedTurn,
  claudeMetadata: ReturnType<typeof parseClaudeOutput> | undefined,
  cleanedResponse: string,
  delegation: Awaited<ReturnType<typeof probeGeometryDelegation>>
): Promise<boolean> {
  const { db, worktree, worktreeId, cliToolId, instanceId, resolvedInstanceId, pollerKey } = ctx;
  const { result, isFullScreenTui, lineCountIsCursor } = turn;

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

  // Mark any pending prompts as answered. Intended twin of the sweep in
  // extractCompletedTurn (working visible on an unfinished frame); this one runs
  // when a response is recorded (Issue #31).
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

  recordOrHoldScrapedResponse(ctx, cleanedResponse, claudeMetadata, {
    structuredHistoryLive,
    suppressScrapedHistory,
    holdScrapedHistory,
  });

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
      logger.error('worktree-not-found');
      stopPolling(worktreeId, cliToolId, instanceId);
      return false;
    }

    // Check if CLI tool session is running
    const running = await isSessionRunning(worktreeId, cliToolId, instanceId);
    if (!running) {
      logger.info('session-not-running');
      // `stopPolling` is what confirms a held scrape here; see
      // `flushPendingScrapedResponse` and `stopPollingByKey`. Requirement B of
      // Issue #2436: this return comes long before the save path (~300 lines
      // below when measured; a function of its own today,
      // `recordCompletedResponse`), so a hold released only down there would
      // never be released at all.
      stopPolling(worktreeId, cliToolId, instanceId);
      return false;
    }

    const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);

    // Issue #3213: what the steps split out of this function are keyed by.
    const ctx: ResponseCheckContext = {
      db,
      worktree,
      worktreeId,
      cliToolId,
      instanceId,
      resolvedInstanceId,
      pollerKey,
    };

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

    const turn = extractCompletedTurn(ctx, output, lastCapturedLine);
    if (!turn) {
      return false;
    }
    const { result, isFullScreenTui, lineCountIsCursor } = turn;

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
      return savePromptMessage(ctx, promptDetection, result, isFullScreenTui);
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

    const cleanedResponse = cleanCompletedResponse(cliToolId, result, pollerKey);

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
        // `await`, so that a rejection still lands in the catch below.
        return await recheckDuplicateResponse(ctx, result, claudeMetadata);
      }
    }

    // The rest of the tick, to its last return. `await` for the same reason as
    // above.
    return await recordCompletedResponse(ctx, turn, claudeMetadata, cleanedResponse, delegation);
  } catch (error: unknown) {
    logger.error('response:check-failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
