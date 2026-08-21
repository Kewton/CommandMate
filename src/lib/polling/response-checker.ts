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
import { getPollerKey, stopPolling, GEMINI_LOADING_INDICATORS } from './response-poller-core';
import { notifyPushSubscribers } from '@/lib/push';
// Issue #1790: imported by deep path, not through `@/lib/push`. Suites that
// replace the barrel to count notifications (e.g. the #1547 escalation test)
// would otherwise get `undefined` here and take down module evaluation.
import { startWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import { getWaitingEpisode, observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';

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
  // Issue #1911: opencode pins the same kind of chrome to the bottom of its
  // alternate-screen pane — the composer box (whose model row reads
  // `Build · GPT-5.6 Luna GitHub Copilot`) and, below its `╹▀▀▀` border, a footer
  // whose wrapped cwd carries no signature at all. Both were being saved as part
  // of the assistant's reply, which is defect 1 of #1911; no pattern can remove
  // the cwd rows, so the boundary has to be structural.
  const openCodeCleanLines = cliToolId === 'opencode' ? lines.map(stripAnsi) : null;
  const chromeStart = cliToolId === 'claude'
    ? findClaudeChromeStart(lines)
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

  // Prompt-based completion logic
  const isPromptBasedComplete = (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local' || cliToolId === 'copilot' || cliToolId === 'antigravity') && hasPrompt && !isThinking;
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
    const responseTailLines = response.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
    if (thinkingPattern.test(responseTailLines)) {
      return incompleteResult(totalLines);
    }

    // CRITICAL FIX: Detect and skip Claude Code startup banner/screen
    if (cliToolId === 'claude') {
      const cleanResponse = stripAnsi(response);

      const hasBannerArt = /[╭╮╰╯│]/.test(cleanResponse) || /░{3,}/.test(cleanResponse) || /▓{3,}/.test(cleanResponse);
      const hasVersionInfo = /Claude Code|claude\/|v\d+\.\d+/.test(cleanResponse);
      const hasStartupTips = /Tip:|for shortcuts|\?\s*for help/.test(cleanResponse);
      const hasProjectInit = /^\s*\/Users\/.*$/m.test(cleanResponse) && cleanResponse.split('\n').length < 30;

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
      } else if ((hasBannerArt || hasVersionInfo || hasStartupTips || hasProjectInit) && response.length < 2000) {
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
        const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId, resolvedInstanceId);
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

    // Create Markdown log file for the conversation pair
    if (cleanedResponse) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse, cliToolId);
    }

    // Mark any pending prompts as answered
    const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId, resolvedInstanceId);
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
