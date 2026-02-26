/**
 * Vibe Local CLI tool implementation
 * Provides integration with vibe-local (vibe-coder) in interactive mode
 *
 * @remarks Issue #368: Rewritten from non-interactive pipe mode to interactive REPL mode.
 * Previous implementation used `echo 'msg' | vibe-local` which caused the process to exit
 * immediately with "(Cancelled)" + "Goodbye!", making response polling impossible.
 * Now launches `vibe-local -y` in interactive mode within tmux (same approach as Claude/Codex/Gemini).
 */

import { BaseCLITool } from './base';
import { OLLAMA_MODEL_PATTERN, type CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKey,
  killSession,
} from '../tmux';
import { detectAndResendIfPastedText } from '../pasted-text-helper';
import { getDbInstance } from '../db-instance';
import { getWorktreeById } from '../db';

/**
 * Extract error message from unknown error type (DRY)
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait for vibe-local to initialize after launch.
 * vibe-local shows a permission check prompt, banner, and model loading.
 */
const VIBE_LOCAL_INIT_WAIT_MS = 5000;

/**
 * Vibe Local CLI tool implementation
 * Manages vibe-local interactive sessions using tmux
 */
export class VibeLocalTool extends BaseCLITool {
  readonly id: CLIToolType = 'vibe-local';
  readonly name = 'Vibe Local';
  readonly command = 'vibe-local';

  /**
   * Check if vibe-local session is running for a worktree
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new vibe-local session for a worktree
   * Launches `vibe-local -y` in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    const vibeLocalAvailable = await this.isInstalled();
    if (!vibeLocalAvailable) {
      throw new Error('vibe-local is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId);

    const exists = await hasSession(sessionName);
    if (exists) {
      console.log(`Vibe Local session ${sessionName} already exists`);
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

      // Read Ollama model preference from DB
      // [SEC-001] Re-validate model name at point of use (defense-in-depth)
      let vibeLocalCommand = 'vibe-local -y';
      try {
        const db = getDbInstance();
        const wt = getWorktreeById(db, worktreeId);
        if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
          vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
        }
      } catch {
        // DB read failure is non-fatal; use default model
      }

      // Start vibe-local in interactive mode with auto-approve (-y)
      // -y flag skips the permission confirmation prompt
      await sendKeys(sessionName, vibeLocalCommand, true);

      // Wait for vibe-local to initialize (banner + model loading)
      await new Promise((resolve) => setTimeout(resolve, VIBE_LOCAL_INIT_WAIT_MS));

      console.log(`✓ Started Vibe Local session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Vibe Local session: ${errorMessage}`);
    }
  }

  /**
   * Send a message to vibe-local interactive session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `Vibe Local session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Send message to vibe-local (without Enter)
      await sendKeys(sessionName, message, false);

      // Wait a moment for the text to be typed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // vibe-local uses IME mode: first Enter creates a new line,
      // second Enter on empty line submits the message.
      // Send Enter twice with a short delay between.
      await sendSpecialKey(sessionName, 'C-m');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await sendSpecialKey(sessionName, 'C-m');

      // Wait a moment for the message to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Detect [Pasted text] and resend Enter for multi-line messages
      if (message.includes('\n')) {
        await detectAndResendIfPastedText(sessionName);
      }

      console.log(`✓ Sent message to Vibe Local session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Vibe Local: ${errorMessage}`);
    }
  }

  /**
   * Kill vibe-local session
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

        // Send Ctrl+C again to ensure exit
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        console.log(`✓ Stopped Vibe Local session: ${sessionName}`);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error stopping Vibe Local session: ${errorMessage}`);
      throw error;
    }
  }
}
