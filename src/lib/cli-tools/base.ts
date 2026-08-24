/**
 * Base implementation for CLI tools
 * Provides common functionality for all CLI tool implementations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ICLITool, CLIToolType } from './types';
import { resolveSessionName } from './session-name';
import { reconcileSessionGeometry, sendSpecialKey, type SessionGeometryOptions } from '../tmux/tmux';
import { resolveComposerSpec } from './composer-spec';
import { resolveCaptureSpec } from './capture-spec';
import { resolveGracefulExitSpec } from './graceful-exit';
import type {
  CaptureSpec,
  ComposerSpec,
  GracefulExitSpec,
} from '../../types/cli-tool-contracts';

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
   * Issue #1984: 規則の本体は `./session-name` に移した。名前だけが欲しい呼び出し側
   * （`ws-server.ts` など）が、7 ツールの実装グラフごと import せずに済むようにするため。
   * ここは委譲だけを行い、規則は 1 箇所に保つ。
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @returns Session name
   * @throws Error if the resulting session name is invalid
   */
  getSessionName(worktreeId: string, instanceId?: string): string {
    return resolveSessionName(this.id, worktreeId, instanceId);
  }

  // Abstract methods that must be implemented by subclasses
  abstract isRunning(worktreeId: string, instanceId?: string): Promise<boolean>;
  abstract sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void>;
  abstract killSession(worktreeId: string, instanceId?: string): Promise<void>;

  /**
   * Launch this tool's session. Implemented by every tool; called by nobody but
   * {@link startSession}.
   *
   * `protected` on purpose (Issue #2009): the public entry point below is the
   * ONE place a start failure becomes a notification decision, and a caller that
   * could reach the launch directly would be a hole in it.
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @param model - Model to launch with; only antigravity honours it (#989)
   */
  protected abstract launchSession(
    worktreeId: string,
    worktreePath: string,
    instanceId?: string,
    model?: string
  ): Promise<void>;

  /**
   * Start this tool's session, reporting a failure exactly once (Issue #2009).
   *
   * ## Why the seam is here and not at the seven throw sites
   *
   * #2000 made "the session refused to start" reach a phone, and wired it at the
   * single place that established the fact: `claude-session`'s
   * `SessionStartFailedError`. Measured on this tree that was also the ONLY
   * place — the other six tools detect their own start failures and throw a bare
   * `Error`, so six of seven agents failed silently. Copying the #2000 call into
   * the other six would have made the eighth tool a new silent one, which is the
   * failure mode the Issue names ("片方だけ直る改修").
   *
   * So the call moved up one level, to the one method every tool inherits and
   * every caller goes through — the two API routes that start sessions, and
   * anything added later. A tool author cannot forget it, because there is
   * nothing left to remember: implement {@link launchSession} and the reporting
   * is already wired.
   *
   * ## Fire-and-forget, and a deferred import
   *
   * The notification is NOT awaited. Web push fans out to every registered
   * device, and holding a 503 open for that would make a failed start slower to
   * report than a successful one. `notifySessionStartFailurePush` contains its
   * own failures, and the `.catch` here is the belt for the import itself.
   *
   * `await import()` rather than a static import, for the reason Issue #1984
   * gives on `CLIToolManager.stopPollers`: `push/failure-push-notifier` pulls
   * the database and `web-push` behind it, and every one of the seven tool
   * modules loads THIS file. Deferring it to the failure path keeps the
   * cli-tools graph the size #1984 cut it down to.
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @param model - Model to launch with; only antigravity honours it (#989)
   * @throws Whatever {@link launchSession} threw — unchanged, after reporting
   */
  async startSession(
    worktreeId: string,
    worktreePath: string,
    instanceId?: string,
    model?: string
  ): Promise<void> {
    try {
      await this.launchSession(worktreeId, worktreePath, instanceId, model);
    } catch (error: unknown) {
      void import('../push/failure-push-notifier')
        .then(({ notifySessionStartFailurePush }) =>
          notifySessionStartFailurePush({
            worktreeId,
            cliToolId: this.id,
            instanceId,
            toolName: this.name,
            error,
          })
        )
        .catch(() => {});
      throw error;
    }
  }

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
