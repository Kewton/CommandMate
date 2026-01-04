/**
 * Gemini CLI tool implementation
 * Provides integration with Google's Gemini CLI
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  killSession,
} from '../tmux';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Gemini CLI tool implementation
 * Manages Gemini sessions using tmux
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
   * Note: Gemini uses non-interactive mode, so we just create a tmux session
   * for running one-shot commands
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
      console.log(`Gemini session ${sessionName} already exists`);
      return;
    }

    try {
      // Create tmux session for running Gemini commands
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      console.log(`✓ Started Gemini session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start Gemini session: ${errorMessage}`);
    }
  }

  /**
   * Send a message to Gemini session (non-interactive mode)
   * Executes a one-shot Gemini command and captures the output
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
      // Escape the message for shell execution
      const escapedMessage = message.replace(/'/g, "'\\''");

      // Execute Gemini in non-interactive mode using stdin piping
      // This approach bypasses the TUI and executes in one-shot mode
      await sendKeys(sessionName, `echo '${escapedMessage}' | gemini`, true);

      console.log(`✓ Sent message to Gemini session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      // Send Ctrl+D to exit Gemini gracefully
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+D (ASCII 4)
        await execAsync(`tmux send-keys -t "${sessionName}" C-d`);

        // Wait a moment for Gemini to exit
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        console.log(`✓ Stopped Gemini session: ${sessionName}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error stopping Gemini session: ${errorMessage}`);
      throw error;
    }
  }
}
