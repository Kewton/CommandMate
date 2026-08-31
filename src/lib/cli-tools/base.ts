/**
 * Base implementation for CLI tools
 * Provides common functionality for all CLI tool implementations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ICLITool, CLIToolType } from './types';
import { resolveSessionName } from './session-name';
import {
  getSessionWorkingDirectory,
  reconcileSessionGeometry,
  sendSpecialKey,
  type SessionGeometryOptions,
} from '../tmux/tmux';
import { resolveComposerSpec } from './composer-spec';
import { resolveCaptureSpec } from './capture-spec';
import { resolveGracefulExitSpec } from './graceful-exit';
import { resolveLivenessSpec } from './liveness-spec';
import { probeSessionLiveness } from './session-liveness';
import { reportSessionStartFailure } from './start-availability';
import { createLogger } from '../logger';
import type {
  CaptureSpec,
  ComposerSpec,
  GracefulExitSpec,
  NavigationKeySpec,
  ToolLivenessSpec,
} from '../../types/cli-tool-contracts';
import { NAVIGATION_KEY_VALUES } from '../../types/terminal-keys';
import { LIVENESS_CONFIRM_DELAY_MS } from '../../config/cli-tool-timing-config';

const execAsync = promisify(exec);

const logger = createLogger('cli-tools/base');

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
   * ## Where the reporting itself lives
   *
   * In `./start-availability` (Issue #2022), not inline here. It is still the
   * only line in the repository that calls `notifySessionStartFailurePush`, and
   * it is still fire-and-forget behind an `await import()` for the reasons that
   * module's docblock spells out. It moved so that a caller which never creates
   * a tmux session — Assistant Chat, which spawns `claude -p` directly and so
   * never reaches this method — can report through the same one窓口 instead of
   * opening a second.
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
      reportSessionStartFailure(
        {
          worktreeId,
          cliToolId: this.id,
          instanceId,
          toolName: this.name,
        },
        error
      );
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

  /**
   * Describe how this tool's pane is read for "did the TOOL exit?"
   * (Issue #2070).
   *
   * Answered from `./liveness-spec`, the §4 D4 shape every other `describe…` /
   * `…Spec` method on this class takes. A tool overrides it only if its pane
   * needs a rule the table cannot express.
   *
   * @returns This tool's {@link ToolLivenessSpec}
   */
  livenessSpec(): ToolLivenessSpec {
    return resolveLivenessSpec(this.id);
  }

  /**
   * Whether this tool is still the thing drawing `sessionName`'s pane
   * (Issue #2070).
   *
   * Two callers. The reuse branch of every `launchSession`, where a `false`
   * means the launch command has to be re-sent into the pane instead of the
   * branch returning as if nothing were wrong; and
   * {@link relaunchIfToolExited}, which is how a `sendMessage` finds out that
   * there is nothing to type into. Deliberately NOT `isRunning` — see that
   * method's docblock for the three callers that read `isRunning` as "does the
   * pane exist?".
   *
   * ## Why the reuse branch confirms twice
   *
   * `confirm: true` re-reads the pane after {@link LIVENESS_CONFIRM_DELAY_MS}
   * and requires BOTH readings to say the tool is gone. There is a window in
   * which a pane legitimately shows a bare shell and nothing else: between
   * `createSession` and the launch line landing, i.e. exactly when a second
   * `startSession` for the same worktree can arrive. One reading cannot tell
   * that window from a dead session, and getting it wrong types a launch
   * command into a live agent's composer. Two readings a second apart can: a
   * booting pane has painted by the second one.
   *
   * The status poll (`worktree-status-helper`) does NOT confirm — it publishes a
   * dot, and a dot that is briefly wrong during a launch is the pre-existing
   * behaviour of claude's own health check. Nothing is relaunched off it.
   *
   * @param sessionName - tmux session name
   * @param options.confirm - Re-read once before returning false
   * @returns True when the tool is (or may still be) there
   */
  protected async isToolLive(
    sessionName: string,
    options?: { confirm?: boolean }
  ): Promise<boolean> {
    const spec = this.livenessSpec();
    const first = await probeSessionLiveness(sessionName, spec);
    if (first.alive) return true;
    if (!options?.confirm) return false;

    await new Promise((resolve) => setTimeout(resolve, LIVENESS_CONFIRM_DELAY_MS));
    const second = await probeSessionLiveness(sessionName, spec);
    if (second.alive) {
      logger.info('session:liveness-confirm-recovered', {
        cliToolId: this.id,
        firstReason: first.reason,
      });
      return true;
    }
    logger.warn('session:tool-exited', { cliToolId: this.id, reason: second.reason });
    return false;
  }

  /**
   * Relaunch this tool if its pane has fallen back to the shell, so the send
   * about to happen has an agent to reach (Issue #2070).
   *
   * ## Why this is in `sendMessage` and not in `isRunning`
   *
   * `isRunning` is the natural place — it is what `POST .../send` consults
   * before deciding to start a session, and `isClaudeRunning` has folded a
   * health check into it since MF-S3-001. Measured against the callers, though,
   * `isRunning` is load-bearing as **"does the pane exist?"** for three of them,
   * and narrowing it would break all three:
   *
   *   - `POST .../terminal` calls it and says so in a comment — "the ICLITool
   *     spelling of the `hasSession` check this used to make directly". A false
   *     there 404s the terminal view for the very pane the operator wants to
   *     look at to see what happened;
   *   - `POST .../kill-session` skips any target whose `isRunning` is false, so
   *     Stop would silently do nothing on a dead-tool pane;
   *   - `killWorktreeSession` (repository delete / sync cleanup) does the same,
   *     leaking the tmux session.
   *
   * (All three are already true of claude, and have been since MF-S3-001. This
   * Issue does not make them worse; a widened `isRunning` would have made them
   * seven times as likely to be hit. Giving `ICLITool` a separate
   * "does the pane exist?" verb and moving those three onto it is the right
   * repair, and it is a change to `src/app/api/**` and `src/lib/session-cleanup.ts`,
   * which is a different Issue's diff.)
   *
   * So the recovery hangs off the send instead, where the question really is
   * "is there an agent to type into?" — and it reuses {@link startSession}, so
   * the relaunch is the same one the explicit start path takes, including the
   * two-reading confirmation and the event-generation fence.
   *
   * Fails open in every branch: a live tool costs one `capture-pane`, and a
   * pane whose directory tmux cannot report falls through to the pre-#2070
   * behaviour (the send proceeds and the tool's own readiness wait reports the
   * failure). A tool that IS gone pays the confirmation delay once, inside
   * `launchSession`.
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  protected async relaunchIfToolExited(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    // One reading, not two. This is a cheap filter, not the decision: the
    // authoritative gate is the confirmed check inside `launchSession`'s reuse
    // branch, which runs a moment later and refuses to relaunch a pane that has
    // painted in between. Confirming here as well would put two seconds in front
    // of every recovery and buy nothing.
    if (await this.isToolLive(sessionName)) return;

    // The pane's own directory, not the worktree row's. `sendMessage` is not
    // given a path, and asking tmux is both simpler than a DB lookup and more
    // truthful: it is the directory the relaunched agent will actually run in,
    // whatever the database now says about a worktree that may have moved.
    const worktreePath = await getSessionWorkingDirectory(sessionName);
    if (worktreePath === null) {
      logger.warn('session:relaunch-skipped-no-path', { cliToolId: this.id, worktreeId });
      return;
    }

    logger.info('session:relaunch-before-send', { cliToolId: this.id, sessionName });
    await this.startSession(worktreeId, worktreePath, instanceId);
  }

  /**
   * Declare the keys this tool's terminal UI may send (Issue #2046).
   *
   * The default IS the pre-#2046 global list, verbatim: the twelve navigation
   * keys plus the codex pager's `q` that `NAVIGATION_KEY_VALUES` has published
   * since #1017, and no leader. claude / codex / copilot / gemini / antigravity
   * / vibe-local all take it unchanged, which is the point of putting it here
   * rather than copying a literal into six classes — there is no per-tool list
   * to drift, so "the six existing tools' key sets did not change" is true by
   * construction and not merely by review.
   * `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts` asserts it
   * against `NAVIGATION_KEY_VALUES` anyway, because a future edit could still
   * add an override to one of the six.
   *
   * opencode overrides it. Nothing else does.
   *
   * @returns This tool's {@link NavigationKeySpec}
   */
  navigationKeys(): NavigationKeySpec {
    return { keys: NAVIGATION_KEY_VALUES, leaderKey: null };
  }
}
