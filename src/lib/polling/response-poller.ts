/**
 * CLI Tool response polling - barrel file and polling control.
 * Periodically checks tmux sessions for CLI tool responses (Claude, Codex, Gemini, Vibe Local, OpenCode).
 *
 * Issue #479: Split into sub-modules for single-responsibility separation.
 * - response-extractor.ts: resolveExtractionStartIndex, isOpenCodeComplete
 * - response-cleaner.ts: cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse
 * - tui-accumulator.ts: TUI accumulation state and functions
 *
 * This file retains:
 * - Polling lifecycle (startPolling, stopPolling, stopAllPolling, getActivePollers)
 * - extractResponse (internal) and checkForResponse (internal)
 * - Module-scope state: activePollers, pollingStartTimes
 *
 * Note: export * is intentionally avoided (D4-001) to prevent
 * @internal functions from being unintentionally exposed.
 *
 * Issue #188 improvements:
 * - DR-004: Tail-line windowing for thinking detection in extractResponse
 * - MF-001 fix: Same windowing applied to checkForResponse thinking check
 * - SF-003: RESPONSE_THINKING_TAIL_LINE_COUNT constant tracks STATUS_THINKING_LINE_COUNT
 *
 * Issue #379 additions:
 * - OpenCode completion detection via Build summary line (isOpenCodeComplete)
 * - OpenCode response cleaning (cleanOpenCodeResponse)
 * - OpenCode extraction stop conditions (OPENCODE_PROMPT_PATTERN, OPENCODE_PROMPT_AFTER_RESPONSE)
 */

import { captureSessionOutput, isSessionRunning } from '@/lib/session/cli-session';
import { getDbInstance } from '@/lib/db-instance';
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
import type { CLIToolType } from '@/lib/cli-tools/types';
import { parseClaudeOutput } from '@/lib/claude-output';
import {
  getCliToolPatterns,
  stripAnsi,
  stripBoxDrawing,
  buildDetectPromptOptions,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_SKIP_PATTERNS,
} from '@/lib/detection/cli-patterns';
import { createLogger } from '@/lib/logger';

const logger = createLogger('response-poller');

// Sub-module imports
import { resolveExtractionStartIndex, isOpenCodeComplete } from '../response-extractor';
import { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse } from '../response-cleaner';
import {
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
  extractTuiContentLines,
  findOverlapIndex,
} from '../tui-accumulator';

// ============================================================================
// Named re-exports from sub-modules (barrel pattern, D4-001: no export *)
// ============================================================================

// response-extractor public API
export { resolveExtractionStartIndex, isOpenCodeComplete };

// response-cleaner public API
export { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse };

// tui-accumulator public API (@internal functions, exported for test access)
export {
  extractTuiContentLines,
  findOverlapIndex,
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Polling interval in milliseconds (default: 2 seconds)
 */
const POLLING_INTERVAL = 2000;

/**
 * Maximum polling duration in milliseconds (default: 30 minutes)
 * Previously 5 minutes, which caused silent polling stops for long-running tasks.
 */
const MAX_POLLING_DURATION = 30 * 60 * 1000;

/**
 * Number of tail lines to check for active thinking indicators in response extraction.
 *
 * SF-003 coupling note: This value must track STATUS_THINKING_LINE_COUNT (5) in
 * status-detector.ts. Both constants exist because they serve separate modules:
 *   - RESPONSE_THINKING_TAIL_LINE_COUNT: response-poller.ts (response extraction)
 *   - STATUS_THINKING_LINE_COUNT: status-detector.ts (UI status display)
 * If STATUS_THINKING_LINE_COUNT changes, update this value accordingly.
 *
 * Why not a shared constant? status-detector.ts has no dependency on response-poller.ts
 * and vice versa. Introducing a shared module would create a coupling that does not
 * currently exist. The test suite validates consistency (SF-003 test).
 *
 * @constant
 */
const RESPONSE_THINKING_TAIL_LINE_COUNT = 5;

/**
 * Gemini auth/loading state indicators that should not be treated as complete responses.
 * Braille spinner characters are shared with CLAUDE_SPINNER_CHARS in cli-patterns.ts.
 * Extracted to module level for clarity and to avoid re-creation on each call.
 */
const GEMINI_LOADING_INDICATORS: readonly string[] = [
  'Waiting for auth',
  '\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f',
];

// ============================================================================
// Extraction types and helpers
// ============================================================================

/**
 * Return type for extractResponse(), representing partial or complete response extraction.
 */
interface ExtractionResult {
  response: string;
  isComplete: boolean;
  lineCount: number;
  /** Prompt detection result carried from extractResponse early check (Issue #372) */
  promptDetection?: PromptDetectionResult;
  /** True when tmux buffer shrank (TUI redraw, screen clear, session restart) */
  bufferReset?: boolean;
}

/**
 * Creates an incomplete extraction result with empty response.
 * Centralizes the repeated pattern of returning an in-progress/incomplete state.
 *
 * @param lineCount - Current line count for state tracking
 * @returns ExtractionResult with empty response and isComplete: false
 */
function incompleteResult(lineCount: number): ExtractionResult {
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
 * @returns ExtractionResult with isComplete: true and ANSI-stripped response
 */
function buildPromptExtractionResult(
  lines: string[],
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number,
  promptDetection?: PromptDetectionResult,
): ExtractionResult {
  const startIndex = resolveExtractionStartIndex(
    lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
  );
  const extractedLines = lines.slice(startIndex);
  return {
    response: stripAnsi(extractedLines.join('\n')),
    isComplete: true,
    lineCount: totalLines,
    promptDetection,
    bufferReset,
  };
}

// ============================================================================
// Poller State Management
// ============================================================================

/**
 * Active pollers map: "worktreeId:cliToolId" -> NodeJS.Timeout
 *
 * Module-scope variable (not globalThis). Node.js module cache ensures
 * singleton behavior. See D3-004 in design policy for details.
 */
const activePollers = new Map<string, NodeJS.Timeout>();

/**
 * Polling start times map: "worktreeId:cliToolId" -> timestamp
 */
const pollingStartTimes = new Map<string, number>();

/**
 * Generate poller key from worktree ID and CLI tool ID
 */
function getPollerKey(worktreeId: string, cliToolId: CLIToolType): string {
  return `${worktreeId}:${cliToolId}`;
}

/**
 * Internal helper: detect prompt with CLI-tool-specific options.
 *
 * Centralizes the stripAnsi() + buildDetectPromptOptions() + detectPrompt() pipeline
 * to avoid repeating this 3-step sequence across extractResponse() and checkForResponse().
 *
 * Design notes:
 * - IA-001: stripAnsi() is applied uniformly inside this helper. It is idempotent,
 *   so double-application on already-stripped input is safe.
 * - SF-003: Uses buildDetectPromptOptions() from cli-patterns.ts for tool-specific
 *   configuration (e.g., Claude's requireDefaultIndicator=false for Issue #193).
 *
 * @param output - Raw or pre-stripped tmux output
 * @param cliToolId - CLI tool identifier for building detection options
 * @returns PromptDetectionResult with isPrompt, promptData, and cleanContent
 */
function detectPromptWithOptions(
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
 * @returns Extracted response or null if incomplete
 */
function extractResponse(
  output: string,
  lastCapturedLine: number,
  cliToolId: CLIToolType
): ExtractionResult | null {
  // Trim trailing empty lines from the output before processing
  // This prevents the "last 20 lines" from being all empty due to tmux buffer padding
  const rawLines = output.split('\n');
  let trimmedLength = rawLines.length;
  while (trimmedLength > 0 && rawLines[trimmedLength - 1].trim() === '') {
    trimmedLength--;
  }
  const lines = rawLines.slice(0, trimmedLength);
  const totalLines = lines.length;

  const BUFFER_RESET_TOLERANCE = 25;
  const bufferShrank = totalLines > 0 && lastCapturedLine > BUFFER_RESET_TOLERANCE && (totalLines + BUFFER_RESET_TOLERANCE) < lastCapturedLine;
  const sessionRestarted = totalLines > 0 && lastCapturedLine > 50 && totalLines < 50;
  const bufferReset = bufferShrank || sessionRestarted;

  // No new output (with buffer to handle newline inconsistencies)
  // BUT: if totalLines is much smaller than lastCapturedLine, the buffer was likely reset (session restart)
  // In that case, don't skip - proceed to check for completion
  if (!bufferReset && totalLines < lastCapturedLine - 5) {
    return null;
  }

  // Check recent lines for completion pattern.
  // OpenCode TUI: content area + many empty padding lines + status bar at bottom.
  // The trailing-empty-line trim above removes trailing newlines but NOT the internal
  // padding between content and status bar. For OpenCode, the Build completion marker
  // can be far above the last 20 lines, so we must check the full buffer.
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = cliToolId === 'opencode'
    ? stripAnsi(lines.join('\n'))
    : linesToCheck.join('\n');

  // Get tool-specific patterns from shared module
  const { promptPattern, separatorPattern, thinkingPattern, skipPatterns } = getCliToolPatterns(cliToolId);

  const findRecentUserPromptIndex = (windowSize: number = 60): number => {
    // User prompt pattern: supports legacy '>' and new '>' for Claude
    let userPromptPattern: RegExp;
    if (cliToolId === 'codex') {
      userPromptPattern = /^›\s+(?!Implement|Find and fix|Type|Summarize)/;
    } else if (cliToolId === 'opencode') {
      // OpenCode TUI accumulates conversation history in a single screen.
      // Each Q&A exchange ends with a "square Build . model . time" marker.
      // "Ask anything..." does NOT appear in tmux capture content area.
      // Instead, find the SECOND-TO-LAST Build marker (= end of previous exchange)
      // to use as the extraction boundary. The first Build marker found (searching
      // backwards) is the current response's completion; the second is the boundary.
      let buildCount = 0;
      for (let i = totalLines - 1; i >= Math.max(0, totalLines - windowSize); i--) {
        const cleanLine = stripAnsi(lines[i]);
        if (OPENCODE_RESPONSE_COMPLETE.test(cleanLine)) {
          buildCount++;
          if (buildCount === 2) {
            return i;
          }
        }
      }
      return -1;
    } else {
      userPromptPattern = /^[>❯]\s+\S/;
    }

    for (let i = totalLines - 1; i >= Math.max(0, totalLines - windowSize); i--) {
      const cleanLine = stripAnsi(lines[i]);
      if (userPromptPattern.test(cleanLine)) {
        return i;
      }
    }

    return -1;
  };

  // Early check for interactive prompts (before extraction logic)
  // Permission prompts appear after normal responses and need special handling.
  // Issue #372: Codex command confirmation prompts (> 1. Yes, proceed) match
  // CODEX_PROMPT_PATTERN, causing isCodexOrGeminiComplete to fire prematurely.
  // Early detection ensures prompt options are preserved in the extraction result.
  if (cliToolId === 'claude' || cliToolId === 'codex') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      // Prompt detection uses full buffer for accuracy, but return only lastCapturedLine onwards.
      // Issue #372: Carry promptDetection through ExtractionResult so checkForResponse()
      // can use it directly, avoiding a second detection on the (potentially truncated)
      // extracted portion which may miss the > indicator line.
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection,
      );
    }
  }

  // Strip ANSI codes before pattern matching
  const cleanOutputToCheck = stripAnsi(outputToCheck);

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  const isThinking = thinkingPattern.test(cleanOutputToCheck);

  // Codex/Gemini/Vibe-Local completion logic: prompt detected and not thinking (separator optional)
  // - Codex: Interactive TUI, detects > prompt
  // - Gemini: Interactive REPL, detects > / > prompt
  // - Vibe-Local: Interactive REPL, detects > prompt
  // Claude: require both prompt and separator
  const isCodexOrGeminiComplete = (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;
  // [D2-002] OpenCode completion: detected via Build summary line pattern (independent of prompt/separator)
  const isOpenCodeDone = cliToolId === 'opencode' && isOpenCodeComplete(cleanOutputToCheck);

  if (isCodexOrGeminiComplete || isClaudeComplete || isOpenCodeDone) {
    // CLI tool has completed response
    // Extract the response content from lastCapturedLine to the separator (not just last 20 lines)
    const responseLines: string[] = [];

    // Determine start index for response extraction using shared helper
    // Handles buffer reset, Codex-specific logic, scroll boundary, and normal cases
    const startIndex = resolveExtractionStartIndex(
      lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
    );

    let endIndex = totalLines;  // Track where extraction actually ended

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i];
      const cleanLine = stripAnsi(line);

      // For Codex: stop at any prompt line (which indicates end of response OR we're already past it)
      if (cliToolId === 'codex' && /^›\s+/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      // For Gemini: stop at shell prompt (indicates command completion)
      if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      // [D2-003] For OpenCode: stop at prompt or status bar patterns
      if (cliToolId === 'opencode') {
        if (OPENCODE_PROMPT_PATTERN.test(cleanLine) || OPENCODE_PROMPT_AFTER_RESPONSE.test(cleanLine)) {
          endIndex = i;
          break;
        }
      }

      // Skip lines matching any skip pattern (check against clean line)
      const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
      if (shouldSkip) {
        continue;
      }

      responseLines.push(line);
    }

    const response = responseLines.join('\n').trim();

    // DR-004: Check only the tail of the response for thinking indicators.
    // Prevents false blocking when completed thinking summaries appear in the response body.
    const responseTailLines = response.split('\n').slice(-RESPONSE_THINKING_TAIL_LINE_COUNT).join('\n');
    if (thinkingPattern.test(responseTailLines)) {
      return incompleteResult(totalLines);
    }

    // CRITICAL FIX: Detect and skip Claude Code startup banner/screen
    // The startup screen contains: ASCII art logo, version info, prompt, separator
    // But no actual response content from the user's query
    if (cliToolId === 'claude') {
      const cleanResponse = stripAnsi(response);

      // Check for Claude Code banner patterns
      const hasBannerArt = /[╭╮╰╯│]/.test(cleanResponse) || /░{3,}/.test(cleanResponse) || /▓{3,}/.test(cleanResponse);
      const hasVersionInfo = /Claude Code|claude\/|v\d+\.\d+/.test(cleanResponse);
      const hasStartupTips = /Tip:|for shortcuts|\?\s*for help/.test(cleanResponse);
      const hasProjectInit = /^\s*\/Users\/.*$/m.test(cleanResponse) && cleanResponse.split('\n').length < 30;

      // Check if this looks like just a startup screen (no actual response content)
      // A real response would have content AFTER the user's prompt line (> or > message)
      const userPromptMatch = cleanResponse.match(/^[>❯]\s+(\S.*)$/m);

      if (userPromptMatch) {
        // Found user prompt - check if there's actual response content after it
        const userPromptIndex = cleanResponse.indexOf(userPromptMatch[0]);
        const contentAfterPrompt = cleanResponse.substring(userPromptIndex + userPromptMatch[0].length).trim();

        // Filter out just separators, tips, and empty lines
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
        // No user prompt found, but has banner characteristics - likely initial startup
        return incompleteResult(totalLines);
      }
    }

    // Gemini-specific check: ensure response contains actual content (star marker)
    if (cliToolId === 'gemini') {
      // Check for banner/UI characters (banner should be filtered by skipPatterns, but double-check)
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

    // OpenCode banner defense: initial startup screen should not be treated as a response
    if (cliToolId === 'opencode') {
      const cleanResponse = stripAnsi(response);
      // If the output is very short and contains only TUI elements, treat as startup banner
      if (cleanResponse.length < 50 || !OPENCODE_RESPONSE_COMPLETE.test(cleanOutputToCheck)) {
        // Check if there's actual content (not just TUI decoration)
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
      lineCount: endIndex,  // Use endIndex instead of totalLines to track where we actually stopped
      bufferReset,
    };
  }

  // Check if this is an interactive prompt (yes/no or multiple choice)
  // Interactive prompts don't have the ">" prompt and separator, so we need to detect them separately
  // [Issue #379] Skip general prompt detection for OpenCode when response is incomplete.
  // OpenCode's "Ask anything..." prompt pattern can cause false positive prompt detection
  // when combined with user input text visible in the TUI buffer, leading to duplicate
  // message creation. OpenCode prompts are only relevant when completion is detected above.
  if (cliToolId !== 'opencode') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      // Prompt detection uses full buffer for accuracy, but return only lastCapturedLine onwards
      // stripAnsi is applied inside buildPromptExtractionResult (Stage 4 MF-001: XSS risk mitigation)
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection,
      );
    }
  }

  // Not a prompt, but we may have a partial response in progress (even if Claude shows a spinner)
  const responseLines: string[] = [];
  const endIndex = totalLines;
  const partialBufferReset = bufferReset || lastCapturedLine >= endIndex - 5;
  const recentPromptIndex = partialBufferReset ? findRecentUserPromptIndex(80) : -1;
  const startIndex = partialBufferReset
    ? (recentPromptIndex >= 0 ? recentPromptIndex + 1 : Math.max(0, endIndex - 80))
    : Math.max(0, lastCapturedLine);

  for (let i = startIndex; i < endIndex; i++) {
    const line = lines[i];
    const cleanLine = stripAnsi(line);

    // Skip lines matching any skip pattern
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

  // Response not yet complete (or is in thinking state)
  return incompleteResult(totalLines);
}

// ============================================================================
// checkForResponse (internal)
// ============================================================================

/**
 * Check for CLI tool response once
 *
 * @param worktreeId - Worktree ID
 * @returns True if response was found and processed
 */
async function checkForResponse(worktreeId: string, cliToolId: CLIToolType): Promise<boolean> {
  const db = getDbInstance();

  try {
    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      logger.error('worktree-worktreeid-not');
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Check if CLI tool session is running
    const running = await isSessionRunning(worktreeId, cliToolId);
    if (!running) {
      logger.info('session-not-running');
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureSessionOutput(worktreeId, cliToolId, 10000);

    // Layer 2: Accumulate TUI content for OpenCode (for overlap tracking only).
    if (cliToolId === 'opencode') {
      const pollerKey = getPollerKey(worktreeId, cliToolId);
      accumulateTuiContent(pollerKey, output);
    }

    // Extract response
    const result = extractResponse(output, lastCapturedLine, cliToolId);

    if (!result || !result.isComplete) {
      // No new output or response not yet complete.
      // If CLI tool is actively thinking, mark any pending prompts as answered.
      // This handles cases where user responded to prompts directly via terminal.
      //
      // DR-004 windowing: Only check tail lines (same as extractResponse thinking check)
      // to avoid false matches on completed thinking summaries in scrollback.
      // Previously (MF-001), full-text check caused false positives.
      const { thinkingPattern } = getCliToolPatterns(cliToolId);
      const cleanOutput = stripAnsi(output);
      const tailLines = cleanOutput.split('\n').slice(-RESPONSE_THINKING_TAIL_LINE_COUNT).join('\n');
      if (thinkingPattern.test(tailLines)) {
        const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
        if (answeredCount > 0) {
          logger.info('marked-answeredcount-pending');
        }
      }
      return false;
    }

    // Issue #379: OpenCode uses a full-screen TUI with fixed buffer size (~200 lines).
    // The tmux pane doesn't grow (no scrollback); each response overwrites the same pane,
    // so lineCount is always approximately equal to lastCapturedLine. Skip line-based
    // duplicate detection entirely for full-screen TUIs.
    const isFullScreenTui = cliToolId === 'opencode';

    // CRITICAL FIX: If lineCount == lastCapturedLine AND there's no in-progress message,
    // this response has already been saved. Skip to prevent duplicates.
    // Issue #372: Skip when buffer reset detected (TUI redraw may coincidentally match lineCount).
    if (!isFullScreenTui && !result.bufferReset && result.lineCount === lastCapturedLine && !sessionState?.inProgressMessageId) {
      return false;
    }

    // Additional duplicate prevention: check if savePendingAssistantResponse
    // already saved this content by comparing line counts.
    // Issue #372: Skip this check when buffer reset is detected (TUI redraw, screen clear).
    // Codex TUI redraws cause totalLines to shrink, making lineCount < lastCapturedLine.
    if (!result.bufferReset && !isFullScreenTui && result.lineCount <= lastCapturedLine) {
      logger.info('already-saved-up-to-line-lastcapturedlin');
      return false;
    }

    // Response is complete! Check if it's a prompt.
    // Issue #372: Prefer the prompt detection carried from extractResponse() early check,
    // which uses the full tmux output for accuracy. The extracted portion (result.response)
    // may be truncated and miss the > indicator line when lastCapturedLine falls just before it.
    const promptDetection = result.promptDetection ?? detectPromptWithOptions(result.response, cliToolId);

    if (promptDetection.isPrompt) {
      // This is a prompt - save as prompt message
      clearInProgressMessageId(db, worktreeId, cliToolId);

      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        // Issue #235: rawContent priority for DB save (rawContent contains complete prompt output)
        content: promptDetection.rawContent || promptDetection.cleanContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
        cliToolId,
      });

      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      broadcastMessage('message', { worktreeId, message });
      stopPolling(worktreeId, cliToolId);

      return true;
    }

    // Validate response content is not empty
    if (!result.response || result.response.trim() === '') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      return false;
    }

    // Parse Claude-specific metadata (summary, log filename, request id)
    const claudeMetadata = cliToolId === 'claude'
      ? parseClaudeOutput(result.response)
      : undefined;

    // Clean up responses (remove shell prompts, setup commands, and errors)
    // [D2-009] Each tool has its own clean function for tool-specific artifacts
    let cleanedResponse = result.response;
    if (cliToolId === 'gemini') {
      cleanedResponse = cleanGeminiResponse(result.response);
    } else if (cliToolId === 'claude') {
      cleanedResponse = cleanClaudeResponse(result.response);
    } else if (cliToolId === 'opencode') {
      cleanedResponse = cleanOpenCodeResponse(result.response);

      // Clear accumulator for next response cycle (Layer 2 data not used for final content;
      // accumulatedContent includes all past Q&A history from the fixed-size TUI, causing
      // old responses to leak into the saved message even after cleanOpenCodeResponse trimming).
      const pollerKey = getPollerKey(worktreeId, cliToolId);
      clearTuiAccumulator(pollerKey);
    }

    // If cleaned response is empty or just "[No content]", skip saving
    // This prevents creating messages for shell setup commands that get filtered out
    if (!cleanedResponse || cleanedResponse.trim() === '' || cleanedResponse === '[No content]') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      clearInProgressMessageId(db, worktreeId, cliToolId);
      return false;
    }

    // Create Markdown log file for the conversation pair
    if (cleanedResponse) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse, cliToolId);
    }

    // Mark any pending prompts as answered since Claude has started processing
    // This handles cases where user responded to prompts directly via terminal
    const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
    if (answeredCount > 0) {
      logger.info('marked-answeredcount-pending');
    }

    // Race condition prevention: re-check session state before saving
    // savePendingAssistantResponse may have already saved this content concurrently
    // Issue #379: Skip for OpenCode full-screen TUI (fixed buffer size, lineCount never advances)
    const currentSessionState = getSessionState(db, worktreeId, cliToolId);
    if (!isFullScreenTui && currentSessionState && result.lineCount <= currentSessionState.lastCapturedLine) {
      logger.info('race-condition-detected-skipping-save-re');
      return false;
    }

    // Create new CLI tool message in database
    // (No longer using in-progress messages - frontend shows realtime output instead)
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: new Date(),
      cliToolId,
      summary: claudeMetadata?.summary,
      logFileName: claudeMetadata?.logFileName,
      requestId: claudeMetadata?.requestId,
    });

    // Broadcast message to WebSocket clients
    broadcastMessage('message', { worktreeId, message });

    // Update session state
    updateSessionState(db, worktreeId, cliToolId, result.lineCount);

    // For full-screen TUIs (OpenCode), stop polling after saving the response.
    // Line-count based duplicate prevention doesn't work because the pane size is fixed,
    // so lineCount never advances. Polling restarts when the user sends the next message.
    if (isFullScreenTui) {
      stopPolling(worktreeId, cliToolId);
    }

    return true;
  } catch (error: unknown) {
    logger.error('response:check-failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

// ============================================================================
// Polling lifecycle (public API)
// ============================================================================

/**
 * Start polling for CLI tool response
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 *
 * @example
 * ```typescript
 * startPolling('feature-foo', 'claude');
 * ```
 */
export function startPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);

  // Stop existing poller if any
  stopPolling(worktreeId, cliToolId);

  // Record start time
  pollingStartTimes.set(pollerKey, Date.now());

  // Initialize TUI accumulator for OpenCode (Layer 2 safety net)
  if (cliToolId === 'opencode') {
    initTuiAccumulator(pollerKey);
  }

  // Start polling with setTimeout chain to prevent race conditions
  scheduleNextResponsePoll(worktreeId, cliToolId);
}

/** Schedule next checkForResponse() after current one completes (setTimeout chain) */
function scheduleNextResponsePoll(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);

  const timerId = setTimeout(async () => {
    // Check if max duration exceeded
    const startTime = pollingStartTimes.get(pollerKey);
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      stopPolling(worktreeId, cliToolId);
      return;
    }

    // Check for response
    try {
      await checkForResponse(worktreeId, cliToolId);
    } catch (error: unknown) {
      logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Schedule next poll ONLY after current one completes
    // Guard: only if poller is still active (not stopped during checkForResponse)
    if (activePollers.has(pollerKey)) {
      scheduleNextResponsePoll(worktreeId, cliToolId);
    }
  }, POLLING_INTERVAL);

  activePollers.set(pollerKey, timerId);
}

/**
 * Stop polling for a worktree and CLI tool combination
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 *
 * @example
 * ```typescript
 * stopPolling('feature-foo', 'claude');
 * ```
 */
export function stopPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);
  const timerId = activePollers.get(pollerKey);

  if (timerId) {
    clearTimeout(timerId);
    activePollers.delete(pollerKey);
    pollingStartTimes.delete(pollerKey);
  }

  // Clean up TUI accumulator if present
  clearTuiAccumulator(pollerKey);
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  for (const pollerKey of activePollers.keys()) {
    const [worktreeId, cliToolId] = pollerKey.split(':') as [string, CLIToolType];
    stopPolling(worktreeId, cliToolId);
  }
}

/**
 * Get list of active pollers
 *
 * @returns Array of worktree IDs currently being polled
 */
export function getActivePollers(): string[] {
  return Array.from(activePollers.keys());
}
