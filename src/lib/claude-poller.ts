/**
 * Claude response polling
 * Periodically checks tmux sessions for Claude responses
 */

import { captureClaudeOutput, isClaudeRunning } from './claude-session';
import { getDbInstance } from './db-instance';
import { getMessages, createMessage, getSessionState, updateSessionState } from './db';
import { createLog } from './log-manager';
import { broadcastMessage } from './ws-server';
import { detectPrompt } from './prompt-detector';

/**
 * Polling interval in milliseconds (default: 2 seconds)
 */
const POLLING_INTERVAL = 2000;

/**
 * Maximum polling duration in milliseconds (default: 5 minutes)
 */
const MAX_POLLING_DURATION = 5 * 60 * 1000;

/**
 * Active pollers map: worktreeId -> NodeJS.Timeout
 */
const activePollers = new Map<string, NodeJS.Timeout>();

/**
 * Polling start times map: worktreeId -> timestamp
 */
const pollingStartTimes = new Map<string, number>();

/**
 * Extract Claude response from tmux output
 * Detects when Claude has completed a response by looking for the prompt
 *
 * @param output - Full tmux output
 * @param lastCapturedLine - Number of lines previously captured
 * @returns Extracted response or null if incomplete
 */
function extractClaudeResponse(
  output: string,
  lastCapturedLine: number
): { response: string; isComplete: boolean; lineCount: number } | null {
  const lines = output.split('\n');
  const totalLines = lines.length;

  // No new output (with buffer to handle newline inconsistencies)
  if (totalLines < lastCapturedLine - 5) {
    return null;
  }

  // Always check the last 20 lines for completion pattern (more robust than tracking line numbers)
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = linesToCheck.join('\n');

  // Check if Claude has returned to prompt (indicated by the prompt symbols)
  // Claude shows "> " or "─────" when waiting for input
  const promptPattern = /^>\s*$/m;
  const separatorPattern = /^─{50,}$/m;

  // Check for thinking/processing indicators
  // Claude shows various animations while thinking: ✻ Herding…, · Choreographing…, ∴ Thinking…, etc.
  // Match lines that contain: symbol + word + … (with optional additional text like "(esc to interrupt)")
  const thinkingPattern = /^[✻✽⏺·∴]\s+\w+…/m;

  const hasPrompt = promptPattern.test(outputToCheck);
  const hasSeparator = separatorPattern.test(outputToCheck);
  const isThinking = thinkingPattern.test(outputToCheck);

  // Only consider complete if we have prompt + separator AND Claude is NOT thinking
  if (hasPrompt && hasSeparator && !isThinking) {
    // Claude has completed response
    // Extract the response content from lastCapturedLine to the separator (not just last 20 lines)
    const responseLines: string[] = [];

    // Handle tmux buffer scrolling: if lastCapturedLine >= totalLines, the buffer has scrolled
    // In this case, we need to find the response in the current visible buffer
    let startIndex: number;

    if (lastCapturedLine >= totalLines - 5) {
      // Buffer may have scrolled - look for the start of the new response
      // Find the last user input prompt ("> ...") to identify where the response starts
      let foundUserPrompt = -1;
      for (let i = totalLines - 1; i >= Math.max(0, totalLines - 50); i--) {
        // Look for user input line (starts with "> " followed by content)
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

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i];

      // Skip separator lines
      if (/^─{50,}$/.test(line)) {
        continue;
      }

      // Stop at new prompt
      if (/^>\s*$/.test(line)) {
        break;
      }

      // Skip control characters and status lines (thinking indicators, tips, etc.)
      if (/^[✻✽⏺·∴]\s+\w+…/.test(line)) {
        continue;
      }

      // Skip tip lines and decoration lines
      if (/^\s*[⎿⏋]\s+Tip:/.test(line) || /^\s*Tip:/.test(line)) {
        continue;
      }

      responseLines.push(line);
    }

    const response = responseLines.join('\n').trim();

    return {
      response,
      isComplete: true,
      lineCount: totalLines,
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
 * Check for Claude response once
 *
 * @param worktreeId - Worktree ID
 * @returns True if response was found and processed
 */
async function checkForResponse(worktreeId: string): Promise<boolean> {
  const db = getDbInstance();

  try {
    // Check if Claude session is running
    const running = await isClaudeRunning(worktreeId);
    if (!running) {
      console.log(`Claude session not running for ${worktreeId}, stopping poller`);
      stopPolling(worktreeId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureClaudeOutput(worktreeId, 10000);

    // Extract response
    const result = extractClaudeResponse(output, lastCapturedLine);

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
      console.log(`✓ Detected prompt for ${worktreeId}:`, promptDetection.promptData?.question);

      const message = createMessage(db, {
        worktreeId,
        role: 'claude',
        content: promptDetection.cleanContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
      });

      // Update session state
      updateSessionState(db, worktreeId, result.lineCount);

      // Broadcast to WebSocket
      broadcastMessage('message', {
        worktreeId,
        message,
      });

      console.log(`✓ Saved prompt message for ${worktreeId}`);

      // Stop polling - waiting for user response
      stopPolling(worktreeId);

      return true;
    }

    // Normal response (not a prompt)
    console.log(`✓ Detected Claude response for ${worktreeId}`);

    // Get the last user message to pair with this response
    const messages = getMessages(db, worktreeId);
    const lastUserMessage = messages
      .filter((m) => m.role === 'user')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    // Create Markdown log file
    if (lastUserMessage && result.response) {
      try {
        await createLog(worktreeId, lastUserMessage.content, result.response);
      } catch (error) {
        console.error('Failed to create log file:', error);
      }
    }

    // Create Claude message in database
    const message = createMessage(db, {
      worktreeId,
      role: 'claude',
      content: result.response,
      messageType: 'normal',
      timestamp: new Date(),
    });

    // Update session state
    updateSessionState(db, worktreeId, result.lineCount);

    // Broadcast message to WebSocket clients
    broadcastMessage('message', {
      worktreeId,
      message,
    });

    console.log(`✓ Saved Claude response for ${worktreeId}`);

    // Stop polling since we got the response
    stopPolling(worktreeId);

    return true;
  } catch (error: any) {
    console.error(`Error checking for response (${worktreeId}):`, error.message);
    return false;
  }
}

/**
 * Start polling for Claude response
 *
 * @param worktreeId - Worktree ID
 *
 * @example
 * ```typescript
 * startPolling('feature-foo');
 * ```
 */
export function startPolling(worktreeId: string): void {
  // Stop existing poller if any
  stopPolling(worktreeId);

  console.log(`Starting poller for ${worktreeId}`);

  // Record start time
  pollingStartTimes.set(worktreeId, Date.now());

  // Start polling
  const interval = setInterval(async () => {
    console.log(`[Poller] Checking for response: ${worktreeId}`);
    const startTime = pollingStartTimes.get(worktreeId);

    // Check if max duration exceeded
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      console.log(`Polling timeout for ${worktreeId}, stopping`);
      stopPolling(worktreeId);
      return;
    }

    // Check for response
    try {
      await checkForResponse(worktreeId);
    } catch (error: any) {
      console.error(`[Poller] Error in checkForResponse:`, error);
    }
  }, POLLING_INTERVAL);

  activePollers.set(worktreeId, interval);
}

/**
 * Stop polling for a worktree
 *
 * @param worktreeId - Worktree ID
 *
 * @example
 * ```typescript
 * stopPolling('feature-foo');
 * ```
 */
export function stopPolling(worktreeId: string): void {
  const interval = activePollers.get(worktreeId);

  if (interval) {
    clearInterval(interval);
    activePollers.delete(worktreeId);
    pollingStartTimes.delete(worktreeId);
    console.log(`Stopped poller for ${worktreeId}`);
  }
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  console.log(`Stopping all pollers (${activePollers.size} active)`);

  for (const worktreeId of activePollers.keys()) {
    stopPolling(worktreeId);
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
