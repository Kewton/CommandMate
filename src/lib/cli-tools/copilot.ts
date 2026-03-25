/**
 * Copilot CLI tool implementation
 * Issue #545: Provides integration with GitHub Copilot CLI via `gh copilot`
 *
 * Uses `gh` as the base command with `copilot` subcommand.
 * isInstalled() is overridden to use execFile (not exec) for security [SEC4-001],
 * performing a 2-stage check: gh availability + copilot extension presence.
 */

import { execFile } from 'child_process';
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
import { COPILOT_PROMPT_PATTERN, stripAnsi } from '../detection/cli-patterns';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/copilot');

/**
 * Extract error message from unknown error type (DRY)
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Copilot CLI to initialize after launch */
const COPILOT_INIT_WAIT_MS = 4000;

/** Interval for polling prompt detection */
const COPILOT_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const COPILOT_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const COPILOT_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Copilot CLI tool implementation
 * Manages GitHub Copilot interactive sessions using tmux
 *
 * command = 'gh' because Copilot is a gh extension.
 * isInstalled() overrides BaseCLITool to use execFile (security) and
 * performs 2-stage verification: gh CLI + copilot extension. [DR1-004][SEC4-001]
 */
export class CopilotTool extends BaseCLITool {
  readonly id: CLIToolType = 'copilot';
  readonly name = 'Copilot';
  readonly command = 'gh';

  /**
   * Check if GitHub Copilot CLI is available.
   * Two-stage check using execFile (not exec) for security [SEC4-001]:
   * 1. Verify `gh` is installed (gh --version)
   * 2. Verify copilot extension is available (gh copilot --help)
   *
   * @returns True if both gh and copilot extension are available
   */
  async isInstalled(): Promise<boolean> {
    try {
      // Stage 1: Check gh CLI availability
      await new Promise<void>((resolve, reject) => {
        execFile('gh', ['--version'], { timeout: 5000 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      // Stage 2: Check copilot extension availability
      await new Promise<void>((resolve, reject) => {
        execFile('gh', ['copilot', '--help'], { timeout: 5000 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if Copilot session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Copilot session for a worktree
   * Launches `gh copilot` in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    // Check if Copilot is installed
    const copilotAvailable = await this.isInstalled();
    if (!copilotAvailable) {
      throw new Error('GitHub Copilot CLI is not installed. Install with: gh extension install github/gh-copilot');
    }

    const sessionName = this.getSessionName(worktreeId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      logger.info('copilot-session-exists');
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

      // Start Copilot CLI in interactive mode
      await sendKeys(sessionName, 'gh copilot', true);

      // Wait for Copilot to initialize
      await new Promise((resolve) => setTimeout(resolve, COPILOT_INIT_WAIT_MS));

      // Poll until Copilot interactive prompt is ready
      await this.waitForReady(sessionName);

      logger.info('started-copilot-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Copilot session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Copilot CLI to become ready (prompt visible).
   * Polls until COPILOT_PROMPT_PATTERN is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    for (let i = 0; i < COPILOT_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Check if interactive prompt is ready
        if (COPILOT_PROMPT_PATTERN.test(output)) {
          logger.info('copilot-prompt-detected');
          return;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, COPILOT_POLL_INTERVAL_MS));
    }
    logger.info('copilot-prompt-detection-timeout');
  }

  /**
   * Wait for Copilot prompt before sending a message.
   * Used by sendMessage to ensure Copilot is ready to accept input.
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < COPILOT_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (COPILOT_PROMPT_PATTERN.test(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('copilot-prompt-not-detected');
  }

  /**
   * Send a message to Copilot interactive session
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
        `Copilot session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Verify Copilot is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Send message to Copilot (without Enter)
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

      // Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-copilot-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Copilot: ${errorMessage}`);
    }
  }

  /**
   * Kill Copilot session
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

        // Send exit to close gracefully
        await sendKeys(sessionName, 'exit', true);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-copilot-session');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
