/**
 * Vibe Local CLI tool implementation (stub)
 * Issue #368: Added as 4th CLI tool option
 *
 * NOTE: This is a stub implementation. Full implementation requires
 * technical investigation (Task 3.1) to determine:
 * - Execution command name
 * - Startup arguments
 * - Prompt detection patterns
 * - Status detection patterns
 *
 * Implementation pattern follows gemini.ts as reference.
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  killSession,
} from '../tmux';

/**
 * Vibe Local CLI tool implementation
 * Manages vibe-local sessions using tmux
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
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      console.log(`Started Vibe Local session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start Vibe Local session: ${errorMessage}`);
    }
  }

  /**
   * Send a message to vibe-local session
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
      const escapedMessage = message.replace(/'/g, "'\\''");
      await sendKeys(sessionName, `echo '${escapedMessage}' | vibe-local`, true);
      console.log(`Sent message to Vibe Local session: ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send message to Vibe Local: ${errorMessage}`);
    }
  }

  /**
   * Kill vibe-local session
   */
  async killSession(worktreeId: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);

    try {
      const killed = await killSession(sessionName);
      if (killed) {
        console.log(`Stopped Vibe Local session: ${sessionName}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error stopping Vibe Local session: ${errorMessage}`);
      throw error;
    }
  }
}
