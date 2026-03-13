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
} from './tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  stripAnsi,
} from './cli-patterns';
import { detectAndResendIfPastedText } from './pasted-text-helper';
import { invalidateCache } from './tmux-capture-cache';
import { getErrorMessage } from './errors';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session-key-sender');

const execAsync = promisify(exec);

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
// Environment Sanitization
// =============================================================================

/**
 * Remove CLAUDECODE environment variable from tmux session environment
 * Prevents Claude Code from detecting nested session and refusing to start
 * (SF-002: SRP - environment sanitization separated from session creation)
 *
 * MF-S3-002: tmux set-environment -g -u operates on the global tmux environment.
 *
 * SEC-SF-001: sessionName is validated by the caller chain:
 * ClaudeTool.startSession() -> BaseCLITool.getSessionName() -> validateSessionName()
 *
 * @param sessionName - tmux session name
 */
export async function sanitizeSessionEnvironment(sessionName: string): Promise<void> {
  // 3-1: Remove from tmux global environment
  await execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true');

  // 3-2: Unset inside the session shell (safety net)
  // 100ms wait: empirically determined time for sendKeys command to reach the shell
  await sendKeys(sessionName, 'unset CLAUDECODE', true);
  await new Promise(resolve => setTimeout(resolve, 100));
}

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

  // Send message using sendKeys consistently (CONS-001)
  await sendKeys(sessionName, message, false);
  await sendKeys(sessionName, '', true);

  // Issue #212: Detect [Pasted text] and resend Enter for multi-line messages
  // MF-001: Single-line messages skip detection (+0ms overhead)
  if (message.includes('\n')) {
    await detectAndResendIfPastedText(sessionName);
  }

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
      await new Promise((resolve) => setTimeout(resolve, 500));
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
