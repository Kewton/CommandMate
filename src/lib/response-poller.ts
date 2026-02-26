/**
 * CLI Tool response polling.
 * Periodically checks tmux sessions for CLI tool responses (Claude, Codex, Gemini).
 *
 * Key responsibilities:
 * - Extract completed responses from tmux output (extractResponse)
 * - Detect interactive prompts and save as prompt messages
 * - Clean tool-specific artifacts from response content
 * - Manage polling lifecycle (start/stop/timeout)
 *
 * Issue #188 improvements:
 * - DR-004: Tail-line windowing for thinking detection in extractResponse
 * - MF-001 fix: Same windowing applied to checkForResponse thinking check
 * - SF-003: RESPONSE_THINKING_TAIL_LINE_COUNT constant tracks STATUS_THINKING_LINE_COUNT
 */

import { captureSessionOutput, isSessionRunning } from './cli-session';
import { getDbInstance } from './db-instance';
import {
  createMessage,
  getSessionState,
  updateSessionState,
  getWorktreeById,
  clearInProgressMessageId,
  markPendingPromptsAsAnswered,
} from './db';
import { broadcastMessage } from './ws-server';
import { detectPrompt } from './prompt-detector';
import type { PromptDetectionResult } from './prompt-detector';
import { recordClaudeConversation } from './conversation-logger';
import type { CLIToolType } from './cli-tools/types';
import { parseClaudeOutput } from './claude-output';
import { getCliToolPatterns, stripAnsi, stripBoxDrawing, buildDetectPromptOptions, PASTED_TEXT_PATTERN } from './cli-patterns';

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

/**
 * Return type for extractResponse(), representing partial or complete response extraction.
 */
interface ExtractionResult {
  response: string;
  isComplete: boolean;
  lineCount: number;
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
  findRecentUserPromptIndex: (windowSize: number) => number
): ExtractionResult {
  const startIndex = resolveExtractionStartIndex(
    lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
  );
  const extractedLines = lines.slice(startIndex);
  return {
    response: stripAnsi(extractedLines.join('\n')),
    isComplete: true,
    lineCount: totalLines,
  };
}

/**
 * Active pollers map: "worktreeId:cliToolId" -> NodeJS.Timeout
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

/**
 * Clean up Claude response by removing shell setup commands, environment exports, ANSI codes, and banner
 * Also extracts only the LATEST response to avoid including conversation history
 *
 * @param response - Raw Claude response
 * @returns Cleaned response (only the latest response)
 */
export function cleanClaudeResponse(response: string): string {
  // First, strip ANSI escape codes
  const cleanedResponse = stripAnsi(response);

  // Find the LAST user prompt (❯ followed by content) and extract only the response after it
  // This ensures we only get the latest response, not the entire conversation history
  const lines = cleanedResponse.split('\n');

  // Find the last user prompt line index
  let lastUserPromptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // User prompt line: ❯ followed by actual content (not empty ❯)
    if (/^❯\s+\S/.test(lines[i])) {
      lastUserPromptIndex = i;
      break;
    }
  }

  // Extract lines after the last user prompt
  const startIndex = lastUserPromptIndex >= 0 ? lastUserPromptIndex + 1 : 0;
  const responseLines = lines.slice(startIndex);

  // Patterns to remove (Claude-specific setup commands and UI elements)
  // IMPORTANT: These patterns should NOT match legitimate Claude response content
  // Lines starting with ⏺ (Claude output marker) are typically valid content
  const skipPatterns = [
    /CLAUDE_HOOKS_/,  // Any CLAUDE_HOOKS reference
    /\/bin\/claude/,  // Claude binary path (any variant)
    /^claude\s*$/,  // Just "claude" on a line
    /@.*\s+%\s*$/,  // Shell prompt (any user@host followed by % at end of line)
    /^[^⏺]*curl.*POST/,  // Curl POST commands (not starting with ⏺)
    /^[^⏺]*Content-Type/,  // HTTP headers (not in Claude output)
    /^[^⏺]*export\s+CLAUDE_/,  // Claude environment exports only
    /^\s*$/,  // Empty lines
    // Claude Code banner patterns (only match pure banner elements)
    /^[╭╮╰╯│─\s]+$/,  // Box drawing characters only (with spaces)
    /^[│╭╮╰╯].*[│╭╮╰╯]$/,  // Lines with box drawing on both sides (banner rows)
    /Claude Code v[\d.]+/,  // Version info
    /^Tips for getting started/,  // Tips header (at line start)
    /^Welcome back/,  // Welcome message (at line start)
    /Run \/init to create/,  // Init instruction
    /^Recent activity/,  // Activity header (at line start)
    /^No recent activity/,  // No activity message (at line start)
    /▐▛███▜▌|▝▜█████▛▘|▘▘ ▝▝/,  // ASCII art logo
    /^\s*Opus \d+\.\d+\s*·\s*Claude Max/,  // Model info in banner format
    /\.com's Organization/,  // Organization info
    /\?\s*for shortcuts\s*$/,  // Shortcuts hint at end of line
    /^─{10,}$/,  // Separator lines
    /^❯\s*$/,  // Empty prompt lines
    PASTED_TEXT_PATTERN,  // [Pasted text #N +XX lines] (Issue #212)
  ];

  // Filter out UI elements and keep only the response content
  const cleanedLines: string[] = [];
  for (const line of responseLines) {
    const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
    if (!shouldSkip && line.trim()) {
      cleanedLines.push(line);
    }
  }

  // Return cleaned content
  return cleanedLines.join('\n').trim();
}

/**
 * Clean up Gemini response by removing shell prompts and error messages
 *
 * @param response - Raw Gemini response
 * @returns Cleaned response
 */
export function cleanGeminiResponse(response: string): string {
  // Split response into lines
  const lines = response.split('\n');
  const cleanedLines: string[] = [];

  // Patterns to remove
  const skipPatterns = [
    /^maenokota@.*%/,  // Shell prompt
    /^zsh:/,           // Shell error messages
    /^feature-issue-\d+/,  // Worktree indicator
    /^\s*$/,           // Empty lines at start
  ];

  // Find the ✦ marker (actual Gemini response start)
  let foundMarker = false;
  const afterMarker: string[] = [];

  for (const line of lines) {
    if (line.includes('✦')) {
      foundMarker = true;
      // Extract content after ✦ marker
      const markerIndex = line.indexOf('✦');
      const afterMarkerContent = line.substring(markerIndex + 1).trim();
      if (afterMarkerContent) {
        afterMarker.push(afterMarkerContent);
      }
      continue;
    }

    if (foundMarker) {
      // Skip shell prompts and errors after ✦ marker
      if (skipPatterns.some(pattern => pattern.test(line))) {
        continue;
      }
      afterMarker.push(line);
    }
  }

  // If we found content after ✦, use only that
  if (afterMarker.length > 0) {
    return afterMarker.join('\n').trim();
  }

  // Otherwise, filter the original response
  for (const line of lines) {
    if (skipPatterns.some(pattern => pattern.test(line))) {
      continue;
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Determine the start index for response extraction based on buffer state.
 * Shared between normal response extraction and prompt detection paths.
 *
 * Implements a 4-branch decision tree for startIndex determination:
 *   1. bufferWasReset  -> findRecentUserPromptIndex(40) + 1, or 0 if not found
 *   2. cliToolId === 'codex' -> Math.max(0, lastCapturedLine)
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

  // Compute bufferWasReset internally (MF-001: responsibility boundary)
  const bufferWasReset = lastCapturedLine >= totalLines || bufferReset;

  // Branch 1: Buffer was reset - find the most recent user prompt as anchor
  if (bufferWasReset) {
    const foundUserPrompt = findRecentUserPromptIndex(40);
    return foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
  }

  // Branch 2: Codex uses lastCapturedLine directly (Codex-specific TUI behavior)
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

  // Always check the last 20 lines for completion pattern (more robust than tracking line numbers)
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = linesToCheck.join('\n');

  // Get tool-specific patterns from shared module
  const { promptPattern, separatorPattern, thinkingPattern, skipPatterns } = getCliToolPatterns(cliToolId);

  const findRecentUserPromptIndex = (windowSize: number = 60): number => {
    // User prompt pattern: supports legacy '>' and new '❯' for Claude
    const userPromptPattern = cliToolId === 'codex'
      ? /^›\s+(?!Implement|Find and fix|Type|Summarize)/
      : /^[>❯]\s+\S/;

    for (let i = totalLines - 1; i >= Math.max(0, totalLines - windowSize); i--) {
      const cleanLine = stripAnsi(lines[i]);
      if (userPromptPattern.test(cleanLine)) {
        return i;
      }
    }

    return -1;
  };

  // Early check for Claude permission prompts (before extraction logic)
  // Permission prompts appear after normal responses and need special handling
  if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      // Prompt detection uses full buffer for accuracy, but return only lastCapturedLine onwards
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
      );
    }
  }

  // Strip ANSI codes before pattern matching
  const cleanOutputToCheck = stripAnsi(outputToCheck);

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  const isThinking = thinkingPattern.test(cleanOutputToCheck);

  // Codex/Gemini/Vibe-Local completion logic: prompt detected and not thinking (separator optional)
  // - Codex: Interactive TUI, detects › prompt
  // - Gemini: Interactive REPL, detects > / ❯ prompt
  // - Vibe-Local: Interactive REPL, detects > prompt
  // Claude: require both prompt and separator
  const isCodexOrGeminiComplete = (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;

  if (isCodexOrGeminiComplete || isClaudeComplete) {
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
      // A real response would have content AFTER the user's prompt line (> or ❯ message)
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

    // Gemini-specific check: ensure response contains actual content (✦ marker)
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

      if (!response.includes('✦') && response.length < 10) {
        return incompleteResult(totalLines);
      }
    }

    return {
      response,
      isComplete: true,
      lineCount: endIndex,  // Use endIndex instead of totalLines to track where we actually stopped
    };
  }

  // Check if this is an interactive prompt (yes/no or multiple choice)
  // Interactive prompts don't have the ">" prompt and separator, so we need to detect them separately
  const fullOutput = lines.join('\n');
  const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

  if (promptDetection.isPrompt) {
    // Prompt detection uses full buffer for accuracy, but return only lastCapturedLine onwards
    // stripAnsi is applied inside buildPromptExtractionResult (Stage 4 MF-001: XSS risk mitigation)
    return buildPromptExtractionResult(
      lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
    );
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
      console.error(`Worktree ${worktreeId} not found, stopping poller`);
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Check if CLI tool session is running
    const running = await isSessionRunning(worktreeId, cliToolId);
    if (!running) {
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureSessionOutput(worktreeId, cliToolId, 10000);

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
          console.log(`Marked ${answeredCount} pending prompt(s) as answered (thinking detected) for ${worktreeId}`);
        }
      }
      return false;
    }

    // CRITICAL FIX: If lineCount == lastCapturedLine AND there's no in-progress message,
    // this response has already been saved. Skip to prevent duplicates.
    if (result.lineCount === lastCapturedLine && !sessionState?.inProgressMessageId) {
      return false;
    }

    // Additional duplicate prevention: check if savePendingAssistantResponse
    // already saved this content by comparing line counts
    if (result.lineCount <= lastCapturedLine) {
      console.log(`[checkForResponse] Already saved up to line ${lastCapturedLine}, skipping (result: ${result.lineCount})`);
      return false;
    }

    // Response is complete! Check if it's a prompt
    const promptDetection = detectPromptWithOptions(result.response, cliToolId);

    if (promptDetection.isPrompt) {
      // This is a prompt - save as prompt message
      clearInProgressMessageId(db, worktreeId, cliToolId);

      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        // Issue #235: rawContent優先でDB保存 (rawContent contains complete prompt output)
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
    let cleanedResponse = result.response;
    if (cliToolId === 'gemini') {
      cleanedResponse = cleanGeminiResponse(result.response);
    } else if (cliToolId === 'claude') {
      cleanedResponse = cleanClaudeResponse(result.response);
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
      console.log(`Marked ${answeredCount} pending prompt(s) as answered for ${worktreeId}`);
    }

    // Race condition prevention: re-check session state before saving
    // savePendingAssistantResponse may have already saved this content concurrently
    const currentSessionState = getSessionState(db, worktreeId, cliToolId);
    if (currentSessionState && result.lineCount <= currentSessionState.lastCapturedLine) {
      console.log(`[checkForResponse] Race condition detected, skipping save (result: ${result.lineCount}, current: ${currentSessionState.lastCapturedLine})`);
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

    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error checking for response (${worktreeId}):`, errorMessage);
    return false;
  }
}

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
      console.error(`[Poller] Error:`, error);
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
