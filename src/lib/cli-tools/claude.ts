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
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    return await isClaudeRunning(worktreeId, instanceId);
  }

  /**
   * Start a new Claude session for a worktree
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   * @param instanceId - Optional agent instance ID (defaults to primary)
   */
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    const options: ClaudeSessionOptions = {
      worktreeId,
      worktreePath,
      instanceId,
    };

    await startClaudeSession(options);
  }

  /**
   * Send a message to Claude session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   * @param instanceId - Optional agent instance ID (defaults to primary)
   */
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    await sendMessageToClaude(worktreeId, message, instanceId);
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
   * @param instanceId - Optional agent instance ID (defaults to primary)
   */
  async sendMessageWithImage(worktreeId: string, message: string, imagePath: string, instanceId?: string): Promise<void> {
    const imageMarkdown = `\n![](${imagePath})`;
    const fullMessage = message ? `${message}${imageMarkdown}` : imageMarkdown;
    await this.sendMessage(worktreeId, fullMessage, instanceId);
  }

  /**
   * Kill Claude session
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Optional agent instance ID (defaults to primary)
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    await stopClaudeSession(worktreeId, instanceId);
  }
}
