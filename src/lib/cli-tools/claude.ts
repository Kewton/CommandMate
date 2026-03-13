/**
 * Claude Code CLI tool implementation
 * Wraps existing claude-session functionality into the ICLITool interface
 */

import { BaseCLITool } from './base';
import type { CLIToolType, IImageCapableCLITool } from './types';
import {
  isClaudeInstalled,
  isClaudeRunning,
  startClaudeSession,
  sendMessageToClaude,
  stopClaudeSession,
  type ClaudeSessionOptions,
} from '../session/claude-session';

/**
 * Claude Code CLI tool implementation
 * Uses existing claude-session module for compatibility
 */
export class ClaudeTool extends BaseCLITool implements IImageCapableCLITool {
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
    const options: ClaudeSessionOptions = {
      worktreeId,
      worktreePath,
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
   * Indicates this tool supports image attachments
   * Issue #474: IImageCapableCLITool implementation
   */
  supportsImage(): true {
    return true;
  }

  /**
   * Send a message with an attached image to Claude session
   * Issue #474: Appends image path as markdown reference
   *
   * @param worktreeId - Worktree ID
   * @param message - Message text
   * @param imagePath - Absolute path to the image file
   */
  async sendMessageWithImage(worktreeId: string, message: string, imagePath: string): Promise<void> {
    const imageMarkdown = `\n![](${imagePath})`;
    const fullMessage = message ? `${message}${imageMarkdown}` : imageMarkdown;
    await this.sendMessage(worktreeId, fullMessage);
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
