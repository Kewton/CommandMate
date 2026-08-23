/**
 * Base implementation for CLI tools
 * Provides common functionality for all CLI tool implementations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ICLITool, CLIToolType } from './types';
import { deriveSessionSuffix } from './types';
import { validateSessionName } from './validation';
import { reconcileSessionGeometry, sendSpecialKey, type SessionGeometryOptions } from '../tmux/tmux';
import { resolveComposerSpec } from './composer-spec';
import { resolveCaptureSpec } from './capture-spec';
import { resolveGracefulExitSpec } from './graceful-exit';
import type {
  CaptureSpec,
  ComposerSpec,
  GracefulExitSpec,
} from '@/types/cli-tool-contracts';

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
   * Generate session name for a worktree (Issue #868: instance-aware)
   *
   * Format:
   * - Primary instance (instanceId omitted or === cliToolId): `mcbd-{cli_tool_id}-{worktree_id}`
   *   (unchanged — backward-compatible anchor)
   * - Additional instance: `mcbd-{cli_tool_id}-{worktree_id}-{suffix}`
   *
   * T2.3: Added validation to prevent command injection (MF4-001)
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @returns Session name
   * @throws Error if the resulting session name is invalid
   */
  getSessionName(worktreeId: string, instanceId?: string): string {
    const base = `mcbd-${this.id}-${worktreeId}`;
    if (!instanceId || instanceId === this.id) {
      validateSessionName(base);
      return base;
    }
    const suffix = deriveSessionSuffix(instanceId, this.id);
    const sessionName = suffix ? `${base}-${suffix}` : base;
    validateSessionName(sessionName);
    return sessionName;
  }

  // Abstract methods that must be implemented by subclasses
  abstract isRunning(worktreeId: string, instanceId?: string): Promise<boolean>;
  abstract startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void>;
  abstract sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void>;
  abstract killSession(worktreeId: string, instanceId?: string): Promise<void>;

  /** Repair geometry when reusing a tmux session that predates the current defaults. */
  protected async reconcileExistingSession(
    sessionName: string,
    options?: SessionGeometryOptions,
  ): Promise<void> {
    await reconcileSessionGeometry(sessionName, options);
  }

  /**
   * Interrupt processing by sending Escape key
   * Default implementation: send Escape key to tmux session
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  async interrupt(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    await sendSpecialKey(sessionName, 'Escape');
  }

  /**
   * Describe this tool's input box (Issue #1933, §6.3).
   *
   * The default is claude's — a marked input line at the bottom of the pane, a
   * twelve-row read-back, one Enter, and the composer emptied before the body
   * is typed. Every tool's answer is resolved from `./composer-spec`, which is
   * where the values that used to be three module-level tables inside
   * `submit-verified-sender.ts` now live; a tool overrides this method when its
   * box is not describable that way.
   *
   * @returns This tool's {@link ComposerSpec}
   */
  describeComposer(): ComposerSpec {
    return resolveComposerSpec(this.id);
  }

  /**
   * Describe how this tool is asked to quit (Issue #1933, §13.2).
   *
   * The default is claude's: one Ctrl-D, then the generic TUI shutdown window.
   * The sequence is a DESCRIPTION — `killSession()` still sends its own
   * measured keystrokes, and the conformance suite pins that the two agree.
   *
   * @returns This tool's {@link GracefulExitSpec}
   */
  gracefulExitSequence(): GracefulExitSpec {
    return resolveGracefulExitSpec(this.id);
  }

  /**
   * Describe what a status capture of this tool must ask tmux for
   * (Issue #1933, §10.12).
   *
   * @returns This tool's {@link CaptureSpec}
   */
  captureSpec(): CaptureSpec {
    return resolveCaptureSpec(this.id);
  }
}
