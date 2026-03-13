/**
 * Codex CLI tool implementation
 * Provides integration with OpenAI's Codex CLI
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  killSession,
  sendSpecialKey,
  capturePane,
} from '../tmux/tmux';
import { detectAndResendIfPastedText } from '../pasted-text-helper';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { CODEX_PROMPT_PATTERN, stripAnsi } from '../detection/cli-patterns';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/codex');

/**
 * Extract error message from unknown error type (DRY)
 * Same pattern as claude-session.ts getErrorMessage()
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Codex CLI to initialize after launch */
const CODEX_INIT_WAIT_MS = 3000;

/** Interval for polling trust dialog / prompt detection */
const CODEX_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const CODEX_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const CODEX_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Codex CLI tool implementation
 * Manages Codex sessions using tmux
 */
export class CodexTool extends BaseCLITool {
  readonly id: CLIToolType = 'codex';
  readonly name = 'Codex CLI';
  readonly command = 'codex';

  /**
   * Check if Codex session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Codex session for a worktree
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    // Check if Codex is installed
    const codexAvailable = await this.isInstalled();
    if (!codexAvailable) {
      throw new Error('Codex CLI is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      logger.info('codex-session-sessionname');
      return;
    }

    try {
      // Create tmux session with large history buffer for Codex output
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Start Codex CLI in interactive mode
      await sendKeys(sessionName, 'codex', true);

      // Wait for Codex to initialize
      await new Promise((resolve) => setTimeout(resolve, CODEX_INIT_WAIT_MS));

      // Poll until Codex interactive prompt is ready
      // Handles trust dialog and update notification automatically
      await this.waitForReady(sessionName);

      logger.info('started-codex-session:sessionname');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Codex session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Codex CLI to become ready (prompt visible).
   * Handles trust dialog ("Do you trust the contents of this directory?")
   * and update notification automatically by sending Enter/number keys.
   * Polls until CODEX_PROMPT_PATTERN is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    let trustDialogHandled = false;
    for (let i = 0; i < CODEX_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Check if interactive prompt is ready
        if (CODEX_PROMPT_PATTERN.test(output)) {
          // Verify it's the actual input prompt, not a prompt inside a dialog
          // by checking no trust/update dialog is still active
          if (!output.includes('Do you trust') && !output.includes('Press enter to continue')) {
            logger.info('codex-prompt-detected');
            return;
          }
        }

        // Handle update notification BEFORE trust dialog check.
        // Update notification shows: › 1. Update now / 2. Skip / 3. Skip until next version
        // followed by "Press enter to continue". Must send "2" (Skip) to avoid
        // triggering npm install which kills the Codex process.
        if (output.includes('Update') && output.includes('Skip')) {
          await sendKeys(sessionName, '2', true);
          logger.info('skipped-codex-update');
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        // Handle "Press enter to continue" (after update skip or other notification)
        if (output.includes('Press enter to continue')) {
          await sendSpecialKey(sessionName, 'Enter');
          logger.info('dismissed-codex-notification');
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        // Handle trust dialog: "Do you trust the contents of this directory?"
        // Options: › 1. Yes, continue / 2. No, quit
        if (!trustDialogHandled && output.includes('Do you trust')) {
          await sendKeys(sessionName, '1', true);
          trustDialogHandled = true;
          logger.info('auto-trusted-folder-for');
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, CODEX_POLL_INTERVAL_MS));
    }
    logger.info('codex-prompt-detection');
  }

  /**
   * Wait for Codex prompt before sending a message.
   * Used by sendMessage to ensure Codex is ready to accept input.
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < CODEX_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (CODEX_PROMPT_PATTERN.test(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('codex-prompt-not');
  }

  /**
   * Send a message to Codex session
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
        `Codex session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Verify Codex is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Send message to Codex (without Enter)
      await sendKeys(sessionName, message, false);

      // Wait a moment for the text to be typed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send Enter key separately
      await sendSpecialKey(sessionName, 'C-m');

      // Wait a moment for the message to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Issue #212: Detect [Pasted text] and resend Enter for multi-line messages
      // MF-001: Single-line messages skip detection (+0ms overhead)
      if (message.includes('\n')) {
        await detectAndResendIfPastedText(sessionName);
      }

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-codex-session:sessionnam');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Codex: ${errorMessage}`);
    }
  }

  /**
   * Kill Codex session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    try {
      // Send Ctrl+D to exit Codex gracefully
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+D (ASCII 4)
        await sendSpecialKey(sessionName, 'C-d');

        // Wait a moment for Codex to exit
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-codex-session:sessionname');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
