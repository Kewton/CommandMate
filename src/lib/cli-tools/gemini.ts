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
} from '../tmux';
import { detectAndResendIfPastedText } from '../pasted-text-helper';

/**
 * Extract error message from unknown error type (DRY)
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Gemini CLI to initialize after launch (banner + auth + dialog) */
const GEMINI_INIT_WAIT_MS = 6000;

/** Interval for polling trust dialog detection */
const TRUST_DIALOG_POLL_INTERVAL_MS = 1000;

/** Max attempts to detect trust dialog (10 * 1000ms = 10s polling window) */
const TRUST_DIALOG_MAX_ATTEMPTS = 10;

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
      console.log(`Gemini session ${sessionName} already exists`);
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

      // Wait for Gemini to initialize
      await new Promise((resolve) => setTimeout(resolve, GEMINI_INIT_WAIT_MS));

      // Auto-handle "Do you trust this folder?" dialog on first run
      await this.handleTrustDialog(sessionName);

      console.log(`✓ Started Gemini session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Gemini session: ${errorMessage}`);
    }
  }

  /**
   * Handle Gemini "Do you trust this folder?" dialog
   * On first run in a new directory, Gemini shows a trust confirmation.
   * Auto-selects "1. Trust folder" to allow execution.
   */
  private async handleTrustDialog(sessionName: string): Promise<void> {
    for (let i = 0; i < TRUST_DIALOG_MAX_ATTEMPTS; i++) {
      try {
        const output = await capturePane(sessionName, 50);
        if (output.includes('Do you trust this folder?')) {
          // Option 1 "Trust folder" is pre-selected (● marker).
          // Send Enter to confirm the selection.
          await sendSpecialKey(sessionName, 'Enter');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          console.log('✓ Auto-trusted folder for Gemini session');
          return;
        }
        // Check if Gemini interactive prompt is already showing (no dialog needed)
        if (output.match(/^[>❯]\s*$/m)) {
          console.log('✓ Gemini prompt detected - no trust dialog needed');
          return;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, TRUST_DIALOG_POLL_INTERVAL_MS));
    }
    console.log('⚠ Trust dialog detection timed out - proceeding anyway');
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

      console.log(`✓ Sent message to Gemini session: ${sessionName}`);
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
        console.log(`✓ Stopped Gemini session: ${sessionName}`);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error stopping Gemini session: ${errorMessage}`);
      throw error;
    }
  }
}
