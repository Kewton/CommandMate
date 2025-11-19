/**
 * Claude Code CLI tool implementation
 * Wraps existing claude-session functionality into the ICLITool interface
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  isClaudeInstalled,
  isClaudeRunning,
  startClaudeSession,
  sendMessageToClaude,
  stopClaudeSession,
  type ClaudeSessionOptions,
} from '../claude-session';

/**
 * Claude Code CLI tool implementation
 * Uses existing claude-session module for compatibility
 */
export class ClaudeTool extends BaseCLITool {
  readonly id: CLIToolType = 'claude';
  readonly name = 'Claude Code';
  readonly command = 'claude';

  /**
   * Check if Claude CLI is installed
   * Uses existing isClaudeInstalled function for compatibility
   */
  async isInstalled(): Promise<boolean> {
    return await isClaudeInstalled();
  }

  /**
   * Check if Claude session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string): Promise<boolean> {
    return await isClaudeRunning(worktreeId);
  }

  /**
   * Start a new Claude session for a worktree
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    // Get base URL from environment or use default
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

    const options: ClaudeSessionOptions = {
      worktreeId,
      worktreePath,
      baseUrl,
    };

    await startClaudeSession(options);
  }

  /**
   * Send a message to Claude session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string): Promise<void> {
    await sendMessageToClaude(worktreeId, message);
  }

  /**
   * Kill Claude session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string): Promise<void> {
    await stopClaudeSession(worktreeId);
  }
}
