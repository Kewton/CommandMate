/**
 * OpenCode CLI tool implementation
 * Issue #379: Provides integration with OpenCode TUI in interactive mode
 *
 * @remarks Follows the same tmux-based pattern as Claude/Codex/Gemini/VibeLocal tools.
 * - startSession: launches `opencode` TUI in tmux
 * - sendMessage: sends text via tmux send-keys + Enter
 * - killSession: sends `/exit` command then falls back to tmux kill-session
 * - interrupt(): inherits BaseCLITool default (Escape key) [D2-008]
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKey,
  killSession,
} from '../tmux';
import { detectAndResendIfPastedText } from '../pasted-text-helper';
import { ensureOpencodeConfig } from './opencode-config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Extract error message from unknown error type (DRY)
 * Same pattern as claude-session.ts / codex.ts / gemini.ts / vibe-local.ts.
 * A shared version exists in src/lib/errors.ts (getErrorMessage), but CLI tool
 * modules use local copies to avoid importing the server-side error module.
 * [D1-002] Future refactoring candidate: extract to BaseCLITool or a shared util.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** OpenCode TUI graceful exit command [D1-006] */
export const OPENCODE_EXIT_COMMAND = '/exit';

/**
 * Wait for OpenCode TUI to initialize after launch.
 * Set to 15000ms to accommodate GPU model loading via Ollama.
 */
export const OPENCODE_INIT_WAIT_MS = 15000;

/**
 * OpenCode CLI tool implementation
 * Manages OpenCode interactive sessions using tmux
 */
export class OpenCodeTool extends BaseCLITool {
  readonly id: CLIToolType = 'opencode';
  readonly name = 'OpenCode';
  readonly command = 'opencode';
  // interrupt() is inherited from BaseCLITool (Escape key) [D2-008]
  // OpenCode TUI supports Escape for interruption ("esc interrupt" display)

  /**
   * Check if OpenCode session is running for a worktree
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new OpenCode session for a worktree
   * Launches `opencode` TUI in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    const opencodeAvailable = await this.isInstalled();
    if (!opencodeAvailable) {
      throw new Error('OpenCode is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId);

    const exists = await hasSession(sessionName);
    if (exists) {
      console.log(`OpenCode session ${sessionName} already exists`);
      return;
    }

    try {
      // Generate opencode.json if not present (non-fatal on failure)
      await ensureOpencodeConfig(worktreePath);

      // Create tmux session with large history buffer
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Resize tmux window to 80 columns (hide sidebar for clean capture-pane output)
      try {
        await execAsync(`tmux resize-window -t "${sessionName}" -x 80 -y 30`);
      } catch {
        // Non-fatal: resize may fail in some environments
      }

      // Start OpenCode TUI
      await sendKeys(sessionName, 'opencode', true);

      // Wait for OpenCode to initialize (GPU model loading via Ollama)
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_INIT_WAIT_MS));

      console.log(`Started OpenCode session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start OpenCode session: ${errorMessage}`);
    }
  }

  /**
   * Send a message to OpenCode interactive session
   * [D1-004] Same pattern as Codex/Gemini/VibeLocal (future Template Method candidate)
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `OpenCode session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Send message to OpenCode (without Enter)
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

      console.log(`Sent message to OpenCode session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to OpenCode: ${errorMessage}`);
    }
  }

  /**
   * Kill OpenCode session with graceful shutdown.
   *
   * Shutdown sequence [D1-006, D1-007]:
   * 1. Check if session exists
   * 2. If exists: send `/exit` TUI command for graceful shutdown
   * 3. Wait 2s for OpenCode to process the exit command
   * 4. Re-check session: if still running, force-kill via tmux kill-session
   * 5. If session did not exist: attempt kill anyway (cleanup stale sessions)
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    try {
      // Step 1: Check if the tmux session currently exists
      const exists = await hasSession(sessionName);
      if (exists) {
        // Step 2: Send /exit command for graceful TUI shutdown [D1-006]
        await sendKeys(sessionName, OPENCODE_EXIT_COMMAND, true);

        // Step 3: Wait for OpenCode to process the exit command
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Step 4: Check if session still exists; force-kill if needed [D1-007]
        const stillExists = await hasSession(sessionName);
        if (stillExists) {
          await killSession(sessionName);
        }
      } else {
        // Step 5: Session does not exist, attempt kill anyway (cleanup stale tmux sessions)
        await killSession(sessionName);
      }

      console.log(`Stopped OpenCode session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error stopping OpenCode session: ${errorMessage}`);
      throw error;
    }
  }
}
