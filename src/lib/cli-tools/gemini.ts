/**
 * Gemini CLI tool implementation
 * Provides integration with Google's Gemini CLI in interactive mode
 *
 * @remarks Issue #368: Rewritten from non-interactive pipe mode to interactive REPL mode.
 * Previous implementation used `echo 'msg' | gemini` which caused the process to exit
 * immediately, making response polling impossible. Now launches `gemini` in interactive
 * mode within tmux (same approach as Claude/Codex).
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKey,
  killSession,
  capturePane,
} from '../tmux/tmux';
import { detectAndResendIfPastedText } from '../pasted-text-helper';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { GEMINI_PROMPT_PATTERN, stripAnsi } from '../detection/cli-patterns';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/gemini');

/**
 * Extract error message from unknown error type (DRY)
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Gemini CLI to initialize after launch (banner + auth + dialog) */
const GEMINI_INIT_WAIT_MS = 6000;

/** Interval for polling trust dialog / prompt detection */
const GEMINI_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const GEMINI_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const GEMINI_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Gemini CLI tool implementation
 * Manages Gemini interactive sessions using tmux
 */
export class GeminiTool extends BaseCLITool {
  readonly id: CLIToolType = 'gemini';
  readonly name = 'Gemini CLI';
  readonly command = 'gemini';

  /**
   * Check if Gemini session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Gemini session for a worktree
   * Launches `gemini` in interactive REPL mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    // Check if Gemini is installed
    const geminiAvailable = await this.isInstalled();
    if (!geminiAvailable) {
      throw new Error('Gemini CLI is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      logger.info('gemini-session-sessionname');
      return;
    }

    try {
      // Create tmux session with large history buffer
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Start Gemini CLI in interactive mode (no flags = interactive REPL)
      await sendKeys(sessionName, 'gemini', true);

      // Wait for Gemini to initialize (minimum wait for banner/auth)
      await new Promise((resolve) => setTimeout(resolve, GEMINI_INIT_WAIT_MS));

      // Poll until Gemini interactive prompt is ready
      // Handles trust dialog automatically if encountered
      await this.waitForReady(sessionName);

      logger.info('started-gemini-session:sessionname');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Gemini session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Gemini CLI to become ready (prompt visible).
   * Handles trust dialog automatically if encountered.
   * Polls until GEMINI_PROMPT_PATTERN is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    let trustDialogHandled = false;
    for (let i = 0; i < GEMINI_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        // Strip ANSI escape codes before pattern matching
        // (Gemini TUI uses 24-bit color codes that break regex matching)
        const output = stripAnsi(rawOutput);

        // Check if interactive prompt is ready
        if (GEMINI_PROMPT_PATTERN.test(output)) {
          logger.info('gemini-prompt-detected');
          return;
        }

        // Handle trust dialog if not yet handled
        if (!trustDialogHandled && output.includes('Do you trust this folder?')) {
          await sendSpecialKey(sessionName, 'Enter');
          trustDialogHandled = true;
          logger.info('auto-trusted-folder-for');
          // Continue polling for prompt after trust dialog
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, GEMINI_POLL_INTERVAL_MS));
    }
    logger.info('gemini-prompt-detection');
  }

  /**
   * Wait for Gemini prompt before sending a message.
   * Used by sendMessage to ensure Gemini is ready to accept input.
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < GEMINI_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (GEMINI_PROMPT_PATTERN.test(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('gemini-prompt-not');
  }

  /**
   * Send a message to Gemini interactive session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    // Check if session exists
    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `Gemini session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Verify Gemini is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Send message to Gemini (without Enter)
      await sendKeys(sessionName, message, false);

      // Wait a moment for the text to be typed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send Enter key separately
      await sendSpecialKey(sessionName, 'C-m');

      // Wait a moment for the message to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Detect [Pasted text] and resend Enter for multi-line messages
      if (message.includes('\n')) {
        await detectAndResendIfPastedText(sessionName);
      }

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-gemini-session:sessionna');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Gemini: ${errorMessage}`);
    }
  }

  /**
   * Kill Gemini session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    try {
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+C to interrupt any running operation
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Send /quit to exit Gemini gracefully
        await sendKeys(sessionName, '/quit', true);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-gemini-session:sessionname');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
