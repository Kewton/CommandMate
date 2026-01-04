/**
 * CLI Tool response polling
 * Periodically checks tmux sessions for CLI tool responses (Claude, Codex, Gemini)
 */

import { captureSessionOutput, isSessionRunning } from './cli-session';
import { getDbInstance } from './db-instance';
import {
  createMessage,
  getSessionState,
  updateSessionState,
  getWorktreeById,
  clearInProgressMessageId,
} from './db';
import { broadcastMessage } from './ws-server';
import { detectPrompt } from './prompt-detector';
import { recordClaudeConversation } from './conversation-logger';
import type { CLIToolType } from './cli-tools/types';
import { parseClaudeOutput } from './claude-output';
import { getCliToolPatterns, stripAnsi } from './cli-patterns';

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
 * Clean up Claude response by removing shell setup commands and environment exports
 *
 * @param response - Raw Claude response
 * @returns Cleaned response
 */
function cleanClaudeResponse(response: string): string {
  // Split response into lines
  const lines = response.split('\n');
  const cleanedLines: string[] = [];

  // Patterns to remove (Claude-specific setup commands)
  const skipPatterns = [
    /CLAUDE_HOOKS_/,  // Any CLAUDE_HOOKS reference
    /\/bin\/claude/,  // Claude binary path (any variant)
    /^claude\s*$/,  // Just "claude" on a line
    /@.*\s+%/,  // Shell prompt (any user@host followed by %)
    /feature-issue-\d+/,  // Worktree indicator
    /worktreeId/,  // Curl command JSON parts
    /localhost/,  // Localhost references
    /192\.168\./,  // IP address parts
    /:3000/,  // Port references
    /done'/,  // Any line containing done' (from claude-done')
    /api\/hooks/,  // API hooks
    /curl.*POST/,  // Curl commands
    /Content-Type/,  // HTTP headers
    /export\s+/,  // Export commands
    /^\s*$/,  // Empty lines
  ];

  // Filter out all setup command lines
  for (const line of lines) {
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

  const BUFFER_RESET_TOLERANCE = 25;
  const bufferShrank = totalLines > 0 && lastCapturedLine > BUFFER_RESET_TOLERANCE && (totalLines + BUFFER_RESET_TOLERANCE) < lastCapturedLine;
  const sessionRestarted = totalLines > 0 && lastCapturedLine > 50 && totalLines < 50;
  const bufferReset = bufferShrank || sessionRestarted;

  // Debug logging for Codex
  if (cliToolId === 'codex') {
    console.log(`[Poller] extractResponse - totalLines: ${totalLines}, lastCapturedLine: ${lastCapturedLine}`);
  }

  // No new output (with buffer to handle newline inconsistencies)
  // BUT: if totalLines is much smaller than lastCapturedLine, the buffer was likely reset (session restart)
  // In that case, don't skip - proceed to check for completion
  if (!bufferReset && totalLines < lastCapturedLine - 5) {
    if (cliToolId === 'codex') {
      console.log(`[Poller] Early return: totalLines (${totalLines}) < lastCapturedLine - 5 (${lastCapturedLine - 5})`);
    }
    return null;
  }

  if (bufferReset) {
    console.log(`[Poller] ${cliToolId} buffer reset detected (totalLines: ${totalLines}, lastCapturedLine: ${lastCapturedLine}), continuing...`);
  }

  // Always check the last 20 lines for completion pattern (more robust than tracking line numbers)
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = linesToCheck.join('\n');

  // Get tool-specific patterns from shared module
  const { promptPattern, separatorPattern, thinkingPattern, skipPatterns } = getCliToolPatterns(cliToolId);

  const findRecentUserPromptIndex = (windowSize: number = 60): number => {
    const userPromptPattern = cliToolId === 'codex'
      ? /^›\s+(?!Implement|Find and fix|Type|Summarize)/
      : /^>\s+\S/;

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
    // Strip ANSI codes before prompt detection
    const cleanFullOutput = stripAnsi(fullOutput);

    console.log(`[Poller] Claude early check - lines: ${lines.length}, chars: ${fullOutput.length}`);
    console.log(`[Poller] Claude early check - last 300 chars (clean):`, cleanFullOutput.substring(Math.max(0, cleanFullOutput.length - 300)));

    const promptDetection = detectPrompt(cleanFullOutput);
    console.log(`[Poller] Claude early check - detectPrompt returned isPrompt: ${promptDetection.isPrompt}`);

    if (promptDetection.isPrompt) {
      console.log(`[Poller] ✓ Early detection: Claude permission prompt found!`);
      console.log(`[Poller] Prompt type: ${promptDetection.promptData?.type}, question: ${promptDetection.promptData?.question?.substring(0, 50)}`);

      // Return the full output as a complete interactive prompt
      // Use the cleaned output without ANSI codes
      return {
        response: cleanFullOutput,
        isComplete: true,
        lineCount: totalLines,
      };
    }
  }

  // Strip ANSI codes before pattern matching
  const cleanOutputToCheck = stripAnsi(outputToCheck);

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  const isThinking = thinkingPattern.test(cleanOutputToCheck);

  // Debug logging for all CLI tools
  if (cliToolId === 'gemini' || cliToolId === 'codex' || cliToolId === 'claude') {
    console.log(`[Poller] ${cliToolId} check - hasPrompt: ${hasPrompt}, hasSeparator: ${hasSeparator}, isThinking: ${isThinking}`);
    const lastLines = linesToCheck.slice(-5);
    lastLines.forEach((line, i) => {
      const cleanLine = stripAnsi(line);
      console.log(`[Poller] Line ${i}: "${line}" (clean: "${cleanLine}")`);
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
    const bufferWasReset = lastCapturedLine >= totalLines || bufferReset;

    if (bufferWasReset) {
      // Buffer was reset - find the most recent user prompt
      const foundUserPrompt = findRecentUserPromptIndex(40);
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
      const foundUserPrompt = findRecentUserPromptIndex(50);
      // Start extraction from after the user prompt, or from a safe earlier point
      startIndex = foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40);
    } else {
      // Normal case: start from lastCapturedLine
      startIndex = Math.max(0, lastCapturedLine);
    }

    let endIndex = totalLines;  // Track where extraction actually ended

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i];
      const cleanLine = stripAnsi(line);

      if (cliToolId === 'codex' || cliToolId === 'gemini') {
        console.log(`[Poller] ${cliToolId} Line ${i}: "${line}" (clean: "${cleanLine}")`);
      }

      // For Codex: stop at any prompt line (which indicates end of response OR we're already past it)
      if (cliToolId === 'codex' && /^›\s+/.test(cleanLine)) {
        console.log(`[Poller] Stopping at prompt line ${i}: "${cleanLine}"`);
        endIndex = i;  // Save where we stopped
        break;
      }

      // For Gemini: stop at shell prompt (indicates command completion)
      if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(cleanLine)) {
        console.log(`[Poller] Gemini: Stopping at shell prompt line ${i}: "${cleanLine}"`);
        endIndex = i;  // Save where we stopped
        break;
      }

      // Skip lines matching any skip pattern (check against clean line)
      const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
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

    // Debug: Log extracted response for Claude
    if (cliToolId === 'claude') {
      console.log(`[Poller] Claude extracted response (${response.length} chars):`);
      console.log(`[Poller] First 300 chars: ${response.substring(0, 300)}`);
      console.log(`[Poller] Last 300 chars: ${response.substring(Math.max(0, response.length - 300))}`);
    }

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
      // A real response would have content AFTER the user's prompt line (> message)
      const userPromptMatch = cleanResponse.match(/^>\s+(\S.*)$/m);

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

        console.log(`[Poller] Claude startup check - userPrompt: "${userPromptMatch[1]}", contentLines after prompt: ${contentLines.length}`);

        if (contentLines.length === 0) {
          console.log(`[Poller] Claude startup banner detected (no content after user prompt), skipping`);
          return {
            response: '',
            isComplete: false,
            lineCount: totalLines,
          };
        }
      } else if ((hasBannerArt || hasVersionInfo || hasStartupTips || hasProjectInit) && response.length < 2000) {
        // No user prompt found, but has banner characteristics - likely initial startup
        console.log(`[Poller] Claude startup screen detected (banner: ${hasBannerArt}, version: ${hasVersionInfo}, tips: ${hasStartupTips}, init: ${hasProjectInit}), skipping`);
        return {
          response: '',
          isComplete: false,
          lineCount: totalLines,
        };
      }
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
  if (cliToolId === 'claude') {
    console.log(`[Poller] Claude interactive prompt check - isThinking: ${isThinking}`);
  }

  const fullOutput = lines.join('\n');
  const promptDetection = detectPrompt(fullOutput);

  // Debug logging for Claude
  if (cliToolId === 'claude') {
    console.log(`[Poller] Claude prompt detection result: isPrompt=${promptDetection.isPrompt}`);
    console.log(`[Poller] Claude fullOutput length: ${fullOutput.length} chars, ${lines.length} lines`);
    console.log(`[Poller] Claude last 500 chars:`, fullOutput.substring(Math.max(0, fullOutput.length - 500)));
    if (promptDetection.promptData) {
      console.log(`[Poller] Prompt type: ${promptDetection.promptData.type}, question: ${promptDetection.promptData.question?.substring(0, 50)}`);
    }
  }

  if (promptDetection.isPrompt) {
    // This is an interactive prompt - consider it complete
    return {
      response: fullOutput,
      isComplete: true,
      lineCount: totalLines,
    };
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
    console.log(`[Poller] Partial response detected (${partialResponse.length} chars), returning as in-progress${isThinking ? ' (spinner active)' : ''}`);
    return {
      response: partialResponse,
      isComplete: false,
      lineCount: endIndex,
    };
  }

  // Response not yet complete (or is in thinking state)
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
    const sessionState = getSessionState(db, worktreeId, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;
    console.log(`[Poller] Session state for ${worktreeId} (${cliToolId}):`, {
      lastCapturedLine,
      inProgressMessageId: sessionState?.inProgressMessageId || 'null'
    });

    // Capture current output
    const output = await captureSessionOutput(worktreeId, cliToolId, 10000);

    // Extract response
    const result = extractResponse(output, lastCapturedLine, cliToolId);

    if (!result) {
      // No new output
      console.log(`[Poller] No new output for ${worktreeId} (${cliToolId})`);
      return false;
    }

    if (!result.isComplete) {
      // Response not yet complete
      // Frontend displays realtime output via current-output API, so we don't create/update messages here
      // NOTE: Do NOT update lastCapturedLine here - only update after successfully saving a message
      // This prevents the "already saved" check from triggering when Claude finishes responding
      console.log(`[Poller] Response incomplete for ${worktreeId} (${cliToolId}), lineCount: ${result.lineCount}`);

      return false;
    }

    // Log complete response detection
    console.log(`[Poller] Complete response detected for ${worktreeId} (${cliToolId}), lineCount: ${result.lineCount}, lastCapturedLine: ${lastCapturedLine}, inProgressMessageId: ${sessionState?.inProgressMessageId || 'null'}`);
    console.log(`[Poller] Response preview (first 200 chars): ${result.response.substring(0, 200)}`);

    // CRITICAL FIX: If lineCount == lastCapturedLine AND there's no in-progress message,
    // this response has already been saved. Skip to prevent duplicates.
    if (result.lineCount === lastCapturedLine && !sessionState?.inProgressMessageId) {
      console.log(`[Poller] Response already saved (lineCount ${result.lineCount} == lastCapturedLine ${lastCapturedLine}), skipping duplicate`);
      return false;
    }

    // Response is complete! Check if it's a prompt
    const promptDetection = detectPrompt(result.response);

    // Debug logging for all CLI tools
    if (cliToolId === 'claude' || cliToolId === 'codex' || cliToolId === 'gemini') {
      console.log(`[Poller] ${cliToolId} prompt detection - isPrompt: ${promptDetection.isPrompt}`);
      if (result.response.length < 500) {
        console.log(`[Poller] Response preview:`, result.response.substring(0, 200));
      }
    }

    if (promptDetection.isPrompt) {
      // This is a prompt - save as prompt message
      console.log(`✓ Detected prompt for ${worktreeId} (${cliToolId}):`, promptDetection.promptData?.question);

      // Clear in-progress message ID (prompt completes the response)
      clearInProgressMessageId(db, worktreeId, cliToolId);

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
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);

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
      console.log(`[Poller] Cleaned response is empty, updating session state and continuing polling...`);
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      clearInProgressMessageId(db, worktreeId, cliToolId);
      return false;
    }

    // Create Markdown log file for the conversation pair
    if (cleanedResponse) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse, cliToolId);
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
    broadcastMessage('message', {
      worktreeId,
      message,
    });

    console.log(`[Poller] Created new message ${message.id}`);

    // Update session state
    updateSessionState(db, worktreeId, cliToolId, result.lineCount);

    console.log(`✓ Saved ${cliToolId} response for ${worktreeId}, updated lastCapturedLine to ${result.lineCount}`);

    // Don't stop polling - continue watching for potential prompts or new messages
    // The duplicate check at line 671 will prevent re-saving this response
    console.log(`[Poller] Continuing to watch for prompts after response...`);

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
    } catch (error: unknown) {
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
