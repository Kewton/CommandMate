/**
 * Base implementation for CLI tools
 * Provides common functionality for all CLI tool implementations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ICLITool, CLIToolType } from './types';
import { sendSpecialKey } from '../tmux';

const execAsync = promisify(exec);

/**
 * Abstract base class for CLI tools
 * Implements common functionality and defines abstract methods for specific implementations
 */
export abstract class BaseCLITool implements ICLITool {
  abstract readonly id: CLIToolType;
  abstract readonly name: string;
  abstract readonly command: string;

  /**
   * Check if CLI tool is installed
   * Uses 'which' command to check if the tool is available in PATH
   */
  async isInstalled(): Promise<boolean> {
    try {
      await execAsync(`which ${this.command}`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate session name for a worktree
   * Format: mcbd-{cli_tool_id}-{worktree_id}
   *
   * @param worktreeId - Worktree ID
   * @returns Session name
   */
  getSessionName(worktreeId: string): string {
    return `mcbd-${this.id}-${worktreeId}`;
  }

  // Abstract methods that must be implemented by subclasses
  abstract isRunning(worktreeId: string): Promise<boolean>;
  abstract startSession(worktreeId: string, worktreePath: string): Promise<void>;
  abstract sendMessage(worktreeId: string, message: string): Promise<void>;
  abstract killSession(worktreeId: string): Promise<void>;

  /**
   * Interrupt processing by sending Escape key
   * Default implementation: send Escape key to tmux session
   *
   * @param worktreeId - Worktree ID
   */
  async interrupt(worktreeId: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId);
    await sendSpecialKey(sessionName, 'Escape');
  }
}
