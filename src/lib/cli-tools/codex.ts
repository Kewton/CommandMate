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
  sendMessageWithEnter,
} from '../tmux';
import { getErrorMessage } from '../utils';

/**
 * Codex initialization timing constants
 * T2.6: Extracted as constants for maintainability
 */
const CODEX_INIT_WAIT_MS = 3000;  // Wait for Codex to start
const CODEX_MODEL_SELECT_WAIT_MS = 200;  // Wait between model selection keystrokes

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
      console.log(`Codex session ${sessionName} already exists`);
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

      // Wait for Codex to initialize (and potentially show update notification)
      await new Promise((resolve) => setTimeout(resolve, CODEX_INIT_WAIT_MS));

      // Auto-skip update notification if present (select option 2: Skip)
      await sendKeys(sessionName, '2', true);

      // Wait a moment for the selection to process
      await new Promise((resolve) => setTimeout(resolve, CODEX_MODEL_SELECT_WAIT_MS));

      // T2.6: Skip model selection dialog by sending Down arrow + Enter
      // This selects the default model and proceeds to the prompt
      await sendSpecialKey(sessionName, 'Down');
      await new Promise((resolve) => setTimeout(resolve, CODEX_MODEL_SELECT_WAIT_MS));
      await sendSpecialKey(sessionName, 'Enter');
      await new Promise((resolve) => setTimeout(resolve, CODEX_MODEL_SELECT_WAIT_MS));

      console.log(`✓ Started Codex session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Codex session: ${errorMessage}`);
    }
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
      // Send message with Enter using unified pattern
      await sendMessageWithEnter(sessionName, message, 100);

      // Wait a moment for the message to be processed (Codex-specific post-Enter delay)
      await new Promise((resolve) => setTimeout(resolve, 200));

      console.log(`✓ Sent message to Codex session: ${sessionName}`);
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
        // Send Ctrl+D via sendSpecialKey (Task-PRE-001)
        await sendSpecialKey(sessionName, 'C-d');

        // Wait a moment for Codex to exit
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        console.log(`✓ Stopped Codex session: ${sessionName}`);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error stopping Codex session: ${errorMessage}`);
      throw error;
    }
  }
}
