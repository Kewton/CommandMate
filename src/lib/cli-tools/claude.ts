/**
 * Claude Code CLI tool implementation
 * Wraps existing claude-session functionality into the ICLITool interface
 */

import { BaseCLITool } from './base';
import type { CLIToolType, IImageCapableCLITool } from './types';
import type { NavigationKeySpec } from '@/types/cli-tool-contracts';
import { CLAUDE_NAVIGATION_KEY_VALUES } from '@/types/terminal-keys';
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
   * Declare the base pad plus `s` (Issue #2297).
   *
   * The one screen that needs it is `/model`, whose footer reads
   * `Enter to set as default · s to use this session only · Esc to cancel`
   * (measured on 2.1.259 and 2.1.260 at the production 200x1000 geometry). On
   * that overlay `Enter` rewrites `model` in `~/.claude/settings.json`
   * (Issue #1495), so before this Issue the chat surface's dialog card could
   * send the key that changes the user's global default and had no way at all to
   * send the key that does not.
   *
   * The rest of the declaration is `NAVIGATION_KEY_VALUES`, untouched — see
   * {@link CLAUDE_NAVIGATION_KEY_VALUES} for why `s` is not simply added to the
   * shared pad (it is a live binding on copilot's session picker, and a bare
   * letter in opencode's composer).
   */
  navigationKeys(): NavigationKeySpec {
    return { keys: CLAUDE_NAVIGATION_KEY_VALUES, leaderKey: null };
  }

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
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
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
