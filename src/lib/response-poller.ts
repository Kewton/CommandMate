/**
 * CLI Tool response polling
 * Periodically checks tmux sessions for CLI tool responses (Claude, Codex, Gemini)
 */

import { captureSessionOutput, isSessionRunning } from './cli-session';
import { getDbInstance } from './db-instance';
import { createMessage, getSessionState, updateSessionState, getWorktreeById } from './db';
import { broadcastMessage } from './ws-server';
import { detectPrompt } from './prompt-detector';
import { recordClaudeConversation } from './conversation-logger';
import type { CLIToolType } from './cli-tools/types';

/**
 * Polling interval in milliseconds (default: 2 seconds)
 */
const POLLING_INTERVAL = 2000;

/**
 * Maximum polling duration in milliseconds (default: 5 minutes)
 */
const MAX_POLLING_DURATION = 5 * 60 * 1000;

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
 * Clean up Gemini response by removing shell prompts and error messages
 *
 * @param response - Raw Gemini response
 * @returns Cleaned response
 */
function cleanGeminiResponse(response: string): string {
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
  let afterMarker: string[] = [];

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
): { response: string; isComplete: boolean; lineCount: number } | null {
  const lines = output.split('\n');
  const totalLines = lines.length;

  // Debug logging for Codex
  if (cliToolId === 'codex') {
    console.log(`[Poller] extractResponse - totalLines: ${totalLines}, lastCapturedLine: ${lastCapturedLine}`);
  }

  // No new output (with buffer to handle newline inconsistencies)
  // BUT: if totalLines is much smaller than lastCapturedLine, the buffer was likely reset (session restart)
  // In that case, don't skip - proceed to check for completion
  const bufferReset = totalLines > 0 && lastCapturedLine > 50 && totalLines < 50;
  if (!bufferReset && totalLines < lastCapturedLine - 5) {
    if (cliToolId === 'codex') {
      console.log(`[Poller] Early return: totalLines (${totalLines}) < lastCapturedLine - 5 (${lastCapturedLine - 5})`);
    }
    return null;
  }

  if (bufferReset && cliToolId === 'codex') {
    console.log(`[Poller] Buffer reset detected (totalLines: ${totalLines}, lastCapturedLine: ${lastCapturedLine}), continuing...`);
  }

  // Always check the last 20 lines for completion pattern (more robust than tracking line numbers)
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = linesToCheck.join('\n');

  // Define tool-specific patterns
  let promptPattern: RegExp;
  let separatorPattern: RegExp;
  let thinkingPattern: RegExp;
  let skipPatterns: RegExp[] = [];

  switch (cliToolId) {
    case 'claude':
      // Claude shows "> " or "─────" when waiting for input
      promptPattern = /^>\s*$/m;
      separatorPattern = /^─{50,}$/m;
      // Claude shows various animations while thinking: ✻ Herding…, · Choreographing…, ∴ Thinking…, ✢ Doing…, ✳ Cascading…, etc.
      thinkingPattern = /[✻✽⏺·∴✢✳]/m;
      skipPatterns = [
        /^─{50,}$/, // Separator lines
        /^>\s*$/, // Prompt line
        /[✻✽⏺·∴✢✳]/, // Thinking indicators
        /^\s*[⎿⏋]\s+Tip:/, // Tip lines
        /^\s*Tip:/, // Tip lines
      ];
      break;

    case 'codex':
      // Codex uses › (U+203A) for prompt instead of >
      // Completion is detected by:
      // 1. A new prompt line (› followed by content or shortcuts hint)
      // 2. OR a "Worked for" separator (for complex tasks)
      promptPattern = /^›\s+.+/m;  // › followed by any content (new prompt ready)
      separatorPattern = /^─.*Worked for.*─+$/m;  // "─ Worked for 2m 20s ────" for complex tasks
      thinkingPattern = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working)/m;
      skipPatterns = [
        /^─.*─+$/,  // Separator lines
        /^›\s*$/,  // Empty prompt line (waiting for input)
        /^›\s+(Implement|Find and fix|Type)/,  // New prompt suggestions (not response content)
        /•\s*(Planning|Searching|Exploring|Running|Thinking)/,  // Activity indicators
        /^\s*\d+%\s+context left/,  // Context indicator
        /^\s*for shortcuts$/,  // Shortcuts hint
        /╭─+╮/,  // Box drawing (top)
        /╰─+╯/,  // Box drawing (bottom)
      ];
      break;

    case 'gemini':
      // Gemini in non-interactive mode (one-shot execution)
      // Completion is detected by the return to shell prompt
      promptPattern = /^(%|\$|.*@.*[%$#])\s*$/m;  // Shell prompt (%, $, or user@host%)
      separatorPattern = /^gemini\s+--\s+/m;  // Command execution line
      // Gemini runs and completes immediately, no thinking state
      thinkingPattern = /(?!)/m;  // Never matches - one-shot execution
      skipPatterns = [
        /^gemini\s+--\s+/,  // Command line itself
        /^(%|\$|.*@.*[%$#])\s*$/,  // Shell prompt lines
        /^\s*$/,  // Empty lines
      ];
      break;

    default:
      console.warn(`[Poller] Unknown CLI tool: ${cliToolId}, using Claude patterns`);
      promptPattern = /^>\s*$/m;
      separatorPattern = /^─{50,}$/m;
      thinkingPattern = /[✻✽⏺·∴✢✳]/m;
      skipPatterns = [/^─{50,}$/, /^>\s*$/, /[✻✽⏺·∴✢✳]/];
  }

  const hasPrompt = promptPattern.test(outputToCheck);
  const hasSeparator = separatorPattern.test(outputToCheck);
  const isThinking = thinkingPattern.test(outputToCheck);

  // Debug logging for Gemini and Codex
  if (cliToolId === 'gemini' || cliToolId === 'codex') {
    console.log(`[Poller] ${cliToolId} check - hasPrompt: ${hasPrompt}, hasSeparator: ${hasSeparator}, isThinking: ${isThinking}`);
    const lastLines = linesToCheck.slice(-5);
    lastLines.forEach((line, i) => {
      console.log(`[Poller] Line ${i}: "${line}"`);
    });
  }

  // Codex/Gemini completion logic: prompt detected and not thinking (separator optional)
  // - Codex: Interactive TUI, detects › prompt
  // - Gemini: Non-interactive one-shot, detects shell prompt (%, $)
  // Claude: require both prompt and separator
  const isCodexOrGeminiComplete = (cliToolId === 'codex' || cliToolId === 'gemini') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;

  if (isCodexOrGeminiComplete || isClaudeComplete) {
    // CLI tool has completed response
    // Extract the response content from lastCapturedLine to the separator (not just last 20 lines)
    const responseLines: string[] = [];

    // Handle tmux buffer scrolling: if lastCapturedLine >= totalLines, the buffer has scrolled
    // In this case, we need to find the response in the current visible buffer
    let startIndex: number;

    // For all tools: check if buffer has been reset/cleared (startIndex would be >= totalLines)
    // This happens when a session is restarted or buffer is cleared
    const bufferWasReset = lastCapturedLine >= totalLines;

    if (bufferWasReset) {
      // Buffer was reset - find the most recent user prompt
      // Search backwards to find the LAST occurrence of a prompt (which should be the user's latest message)
      let foundUserPrompt = -1;
      const userPromptPattern = cliToolId === 'codex' ? /^›\s+(?!Implement|Find and fix|Type|Summarize)/ : /^>\s+\S/;

      for (let i = totalLines - 1; i >= Math.max(0, totalLines - 30); i--) {
        if (userPromptPattern.test(lines[i])) {
          foundUserPrompt = i;
          break;  // Found the most recent user prompt (searching backwards)
        }
      }

      startIndex = foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;

      if (cliToolId === 'codex') {
        console.log(`[Poller] Buffer reset - foundUserPrompt at ${foundUserPrompt}, startIndex: ${startIndex}, totalLines: ${totalLines}`);
      }
    } else if (cliToolId === 'codex') {
      // Normal case for Codex: use lastCapturedLine
      startIndex = Math.max(0, lastCapturedLine);
      console.log(`[Poller] Codex extraction - startIndex: ${startIndex}, totalLines: ${totalLines}`);
    } else if (lastCapturedLine >= totalLines - 5) {
      // Buffer may have scrolled - look for the start of the new response
      // Find the last user input prompt to identify where the response starts
      let foundUserPrompt = -1;
      for (let i = totalLines - 1; i >= Math.max(0, totalLines - 50); i--) {
        if (/^>\s+\S/.test(lines[i])) {
          foundUserPrompt = i;
          break;
        }
      }

      // Start extraction from after the user prompt, or from a safe earlier point
      startIndex = foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40);
    } else {
      // Normal case: start from lastCapturedLine
      startIndex = Math.max(0, lastCapturedLine);
    }

    let endIndex = totalLines;  // Track where extraction actually ended

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i];

      if (cliToolId === 'codex' || cliToolId === 'gemini') {
        console.log(`[Poller] ${cliToolId} Line ${i}: "${line}"`);
      }

      // For Codex: stop at any prompt line (which indicates end of response OR we're already past it)
      if (cliToolId === 'codex' && /^›\s+/.test(line)) {
        console.log(`[Poller] Stopping at prompt line ${i}: "${line}"`);
        endIndex = i;  // Save where we stopped
        break;
      }

      // For Gemini: stop at shell prompt (indicates command completion)
      if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(line)) {
        console.log(`[Poller] Gemini: Stopping at shell prompt line ${i}: "${line}"`);
        endIndex = i;  // Save where we stopped
        break;
      }

      // Skip lines matching any skip pattern
      const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
      if (shouldSkip) {
        if (cliToolId === 'codex' || cliToolId === 'gemini') {
          console.log(`[Poller] ${cliToolId}: Skipping line ${i} (matches skip pattern)`);
        }
        continue;
      }

      if (cliToolId === 'codex' || cliToolId === 'gemini') {
        console.log(`[Poller] ${cliToolId}: Adding line ${i} to response`);
      }
      responseLines.push(line);
    }

    if (cliToolId === 'codex' || cliToolId === 'gemini') {
      console.log(`[Poller] ${cliToolId}: Extracted ${responseLines.length} lines, response: "${responseLines.join('\\n').trim()}"`);
    }

    const response = responseLines.join('\n').trim();

    // Additional check: ensure response doesn't contain thinking indicators
    // This prevents saving intermediate states as final responses
    if (thinkingPattern.test(response)) {
      console.warn(`[Poller] Response contains thinking indicators, treating as incomplete`);
      return {
        response: '',
        isComplete: false,
        lineCount: totalLines,
      };
    }

    // Gemini-specific check: ensure response contains actual content (✦ marker)
    if (cliToolId === 'gemini') {
      // Check for banner/UI characters (banner should be filtered by skipPatterns, but double-check)
      const bannerCharCount = (response.match(/[░███]/g) || []).length;
      const totalChars = response.length;
      if (bannerCharCount > totalChars * 0.3) {
        console.log(`[Poller] Gemini response contains mostly banner/UI characters (${bannerCharCount}/${totalChars}), treating as incomplete`);
        return {
          response: '',
          isComplete: false,
          lineCount: totalLines,
        };
      }

      // Check for auth/loading states that should not be treated as complete responses
      if (response.includes('Waiting for auth') ||
          response.includes('⠋') ||
          response.includes('⠙') ||
          response.includes('⠹') ||
          response.includes('⠸') ||
          response.includes('⠼') ||
          response.includes('⠴') ||
          response.includes('⠦') ||
          response.includes('⠧') ||
          response.includes('⠇') ||
          response.includes('⠏')) {
        console.log(`[Poller] Gemini is waiting for auth or loading, treating as incomplete`);
        return {
          response: '',
          isComplete: false,
          lineCount: totalLines,
        };
      }

      if (!response.includes('✦') && response.length < 10) {
        console.log(`[Poller] Gemini response too short or missing ✦ marker, treating as incomplete`);
        return {
          response: '',
          isComplete: false,
          lineCount: totalLines,
        };
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
  if (!isThinking) {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPrompt(fullOutput);

    if (promptDetection.isPrompt) {
      // This is an interactive prompt - consider it complete
      return {
        response: fullOutput,
        isComplete: true,
        lineCount: totalLines,
      };
    }
  }

  // Response not yet complete
  return {
    response: '',
    isComplete: false,
    lineCount: totalLines,
  };
}

/**
 * Check for CLI tool response once
 *
 * @param worktreeId - Worktree ID
 * @returns True if response was found and processed
 */
async function checkForResponse(worktreeId: string, cliToolId: CLIToolType): Promise<boolean> {
  const db = getDbInstance();

  // Debug: confirm function is being called
  if (cliToolId === 'codex') {
    console.log(`[Poller] checkForResponse called for ${worktreeId}`);
  }

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
      console.log(`${cliToolId} session not running for ${worktreeId}, stopping poller`);
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureSessionOutput(worktreeId, cliToolId, 10000);

    // Extract response
    const result = extractResponse(output, lastCapturedLine, cliToolId);

    if (!result) {
      // No new output
      return false;
    }

    if (!result.isComplete) {
      // Response not yet complete, update line count
      updateSessionState(db, worktreeId, result.lineCount);
      return false;
    }

    // Response is complete! Check if it's a prompt
    const promptDetection = detectPrompt(result.response);

    if (promptDetection.isPrompt) {
      // This is a prompt - save as prompt message
      console.log(`✓ Detected prompt for ${worktreeId} (${cliToolId}):`, promptDetection.promptData?.question);

      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        content: promptDetection.cleanContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
        cliToolId,
      });

      // Update session state
      updateSessionState(db, worktreeId, result.lineCount);

      // Broadcast to WebSocket
      broadcastMessage('message', {
        worktreeId,
        message,
      });

      console.log(`✓ Saved prompt message for ${worktreeId} (${cliToolId})`);

      // Stop polling - waiting for user response
      stopPolling(worktreeId, cliToolId);

      return true;
    }

    // Normal response (not a prompt)
    console.log(`✓ Detected ${cliToolId} response for ${worktreeId}`);

    // Validate response content is not empty
    if (!result.response || result.response.trim() === '') {
      console.warn(`⚠ Empty response detected for ${worktreeId}, continuing polling...`);
      // Update session state but don't save the message
      // Continue polling in case a prompt appears next
      updateSessionState(db, worktreeId, result.lineCount);
      return false;
    }

    // Clean up Gemini response (remove shell prompts and errors)
    let cleanedResponse = result.response;
    if (cliToolId === 'gemini') {
      cleanedResponse = cleanGeminiResponse(result.response);
    }

    // Create Markdown log file for the conversation pair
    if (cleanedResponse) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse);
    }

    // Create CLI tool message in database
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: new Date(),
      cliToolId,
    });

    // Update session state
    updateSessionState(db, worktreeId, result.lineCount);

    // Broadcast message to WebSocket clients
    broadcastMessage('message', {
      worktreeId,
      message,
    });

    console.log(`✓ Saved ${cliToolId} response for ${worktreeId}`);

    // Stop polling since we got the response
    stopPolling(worktreeId, cliToolId);

    return true;
  } catch (error: any) {
    console.error(`Error checking for response (${worktreeId}):`, error.message);
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

  console.log(`Starting poller for ${worktreeId} (${cliToolId})`);

  // Record start time
  pollingStartTimes.set(pollerKey, Date.now());

  // Start polling
  const interval = setInterval(async () => {
    console.log(`[Poller] Checking for response: ${worktreeId} (${cliToolId})`);
    const startTime = pollingStartTimes.get(pollerKey);

    // Check if max duration exceeded
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      console.log(`Polling timeout for ${worktreeId} (${cliToolId}), stopping`);
      stopPolling(worktreeId, cliToolId);
      return;
    }

    // Check for response
    try {
      await checkForResponse(worktreeId, cliToolId);
    } catch (error: any) {
      console.error(`[Poller] Error in checkForResponse:`, error);
    }
  }, POLLING_INTERVAL);

  activePollers.set(pollerKey, interval);
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
  const interval = activePollers.get(pollerKey);

  if (interval) {
    clearInterval(interval);
    activePollers.delete(pollerKey);
    pollingStartTimes.delete(pollerKey);
    console.log(`Stopped poller for ${worktreeId} (${cliToolId})`);
  }
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  console.log(`Stopping all pollers (${activePollers.size} active)`);

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
