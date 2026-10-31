/**
 * Session Key Sender - tmux key sending wrappers for Claude CLI sessions.
 *
 * Extracted from claude-session.ts (Issue #479) to separate key-sending
 * control logic from session lifecycle management.
 *
 * Dependencies: tmux.ts (sendKeys, sendSpecialKey) - one-way dependency.
 * claude-session.ts -> session-key-sender.ts -> tmux.ts
 */

import {
  hasSession,
  sendKeys,
  capturePane,
  killSession,
  sendSpecialKey,
} from './tmux/tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  stripAnsi,
} from './detection/cli-patterns';
import { sendMessageWithSubmitVerification } from './cli-tools/submit-verified-sender';
import { invalidateCache } from './tmux/tmux-capture-cache';
import { getErrorMessage } from './errors';
import { TUI_EXIT_WAIT_MS } from '@/config/cli-tool-timing-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session-key-sender');

/**
 * Capture tmux pane output and strip ANSI escape sequences
 *
 * @param sessionName - tmux session name
 * @param lines - Number of lines to capture (default: 50)
 * @returns Clean pane output with ANSI codes removed
 */
async function getCleanPaneOutput(sessionName: string, lines: number = 50): Promise<string> {
  const output = await capturePane(sessionName, { startLine: -lines });
  return stripAnsi(output);
}

// =============================================================================
// Constants (duplicated from claude-session.ts for one-way dependency)
// =============================================================================

/**
 * Prompt wait polling interval (milliseconds)
 */
const PROMPT_POLL_INTERVAL = 200;

// =============================================================================
// Prompt Wait
// =============================================================================

/**
 * Wait for session to be at prompt state
 * Polls for prompt detection using CLAUDE_PROMPT_PATTERN (DRY-001)
 *
 * @param sessionName - tmux session name
 * @param timeout - Timeout in milliseconds
 * @throws {Error} If prompt is not detected within timeout
 */
export async function waitForPrompt(
  sessionName: string,
  timeout: number
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const cleanOutput = await getCleanPaneOutput(sessionName);
    if (CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
      return; // Prompt detected
    }
    await new Promise((resolve) => setTimeout(resolve, PROMPT_POLL_INTERVAL));
  }

  throw new Error(`Prompt detection timeout (${timeout}ms)`);
}

// =============================================================================
// Message Sending
// =============================================================================

/**
 * Send a message to Claude CLI
 *
 * @param sessionName - tmux session name
 * @param message - Message content to send
 * @param postPromptDelay - Stability delay after prompt detection (ms)
 * @param promptWaitTimeout - Timeout for waiting for prompt state (ms)
 * @throws {Error} If session doesn't exist
 */
export async function sendMessageToSession(
  sessionName: string,
  message: string,
  postPromptDelay: number,
  promptWaitTimeout: number,
): Promise<void> {
  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(
      `Claude session ${sessionName} does not exist. Start the session first.`
    );
  }

  // Verify prompt state before sending
  const cleanOutput = await getCleanPaneOutput(sessionName);
  if (!CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
    await waitForPrompt(sessionName, promptWaitTimeout);
  }

  // Stability delay after prompt detection
  await new Promise((resolve) => setTimeout(resolve, postPromptDelay));

  // Issue #1469: Body and Enter are sent as SEPARATE tmux commands (never a
  // single body+C-m batch) and the submit is read-back verified. This replaces
  // the old fire-and-forget `sendKeys(message,false)` + `sendKeys('',true)` that
  // let Claude's ink TUI swallow the trailing C-m as a bracketed-paste newline,
  // leaving the message typed but unsent. Throws if submit cannot be confirmed.
  await sendMessageWithSubmitVerification({
    sessionName,
    message,
    cliToolId: 'claude',
  });

  // Issue #405: Invalidate cache after sending message
  invalidateCache(sessionName);

  logger.info('sent-message-to-session', { sessionName });
}

// =============================================================================
// Session Stop
// =============================================================================

/**
 * Stop a Claude session by sending Ctrl+D and killing the tmux session.
 *
 * @param sessionName - tmux session name
 * @returns True if session was stopped, false if it didn't exist or error occurred
 */
export async function stopSession(sessionName: string): Promise<boolean> {
  try {
    // Send Ctrl+D to exit Claude gracefully
    const exists = await hasSession(sessionName);
    if (exists) {
      await sendKeys(sessionName, '', false);
      // Send Ctrl+D (ASCII 4)
      await sendSpecialKey(sessionName, 'C-d');

      // Issue #405: Invalidate cache after sending stop signal
      invalidateCache(sessionName);

      // Wait a moment for Claude to exit
      await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
    }

    // Kill the tmux session
    const killed = await killSession(sessionName);

    if (killed) {
      logger.info('stopped-session', { sessionName });
    }

    return killed;
  } catch (error: unknown) {
    logger.error('session:stop-failed', { error: getErrorMessage(error) });
    return false;
  }
}
