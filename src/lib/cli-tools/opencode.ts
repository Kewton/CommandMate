/**
 * OpenCode CLI tool implementation
 * Issue #379: Provides integration with OpenCode TUI in interactive mode
 *
 * @remarks Follows the same tmux-based pattern as Claude/Codex/Gemini/VibeLocal tools.
 * - startSession: launches `opencode` TUI in tmux
 * - sendMessage: sends text via tmux send-keys + Enter
 * - killSession: sends `/exit` command then falls back to tmux kill-session
 * - interrupt(): inherits BaseCLITool default (Escape key) [D2-008]
 *
 * ## Structured events (Issue #1763, Epic #1720 Phase 4-5)
 *
 * opencode is the one supported agent that does not push lifecycle events at
 * CommandMate: it is *subscribed to*. #1758 §5.1.2 measured that the plain TUI
 * serves the same HTTP API `opencode serve` does once it is given `--port`, so
 * the whole of the launch change is that flag — no second process, no pid to
 * track, no orphan to reap, and `killSession`'s `/exit`, the init wait and
 * `reconcileExistingSession` are all untouched.
 *
 * What is added around it is three calls into
 * `@/lib/hooks/sources/opencode/runtime`: reserve a port before the launch
 * command is built, attach the event stream once the TUI is up, and release
 * both when the pane is killed. Every one of them is fail-open — a session that
 * starts without structured events is the pre-#1763 status quo, and the screen
 * scraper keeps deciding for it exactly as before.
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  killSession,
  exactTarget,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { ensureOpencodeConfig } from './opencode-config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@/lib/logger';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  attachOpencodeEventStream,
  opencodeTarget,
  releaseOpencodeEventStream,
  reserveOpencodeServerPort,
  resumeOpencodeEventStream,
} from '@/lib/hooks/sources/opencode/runtime';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  OPENCODE_EXIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';

const logger = createLogger('cli-tools/opencode');

const execFileAsync = promisify(execFile);

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
 * OpenCode tmux pane height (rows).
 * Set to 200 to expand the TUI content area (~190 visible lines),
 * allowing most responses to be captured in a single tmux capture-pane.
 * OpenCode runs in alternate screen mode with no scrollback buffer,
 * so only visible rows are capturable.
 */
export const OPENCODE_PANE_HEIGHT = 200;

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
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new OpenCode session for a worktree
   * Launches `opencode` TUI in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    const opencodeAvailable = await this.isInstalled();
    if (!opencodeAvailable) {
      throw new Error('OpenCode is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    const target = opencodeTarget(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName, {
        windowWidth: 80,
        windowHeight: OPENCODE_PANE_HEIGHT,
      });
      // Issue #1763: the pane outlived this process (a CommandMate restart), so
      // the subscription that used to watch it is gone while its server is
      // still listening. Recovered from the recorded port, health-checked, and
      // skipped silently when there is nothing there. NOT a new generation —
      // the pane is the same one, and fencing here would discard a still-valid
      // verdict on every reconnect.
      await resumeOpencodeEventStream(target, worktreePath);
      logger.info('opencode-session-sessionname');
      return;
    }

    // Issue #1759 (S8) / #1763: everything the previous opencode process
    // reported through this (worktreeId, instanceId) belongs to a session that
    // no longer exists, and the key is reused verbatim by the one about to be
    // created. On the creation path only, before the pane exists, and even if
    // the launch then fails — falling back to the scraper is always safe.
    beginAgentSession(target);

    try {
      // Generate opencode.json if not present (non-fatal on failure)
      await ensureOpencodeConfig(worktreePath);

      // Create tmux session. Scrollback depth comes from the shared
      // TMUX_HISTORY_LIMIT default (Issue #1624) — do not re-hardcode it here.
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));

      // Resize tmux window to 80 columns (hide sidebar for clean capture-pane output)
      // [SEC-001] Uses execFile (not exec) to prevent shell meta-character injection via sessionName
      try {
        await execFileAsync('tmux', [
          // Issue #1156: exact-match target so resize never leaks to a prefix-colliding instance
          'resize-window', '-t', exactTarget(sessionName),
          '-x', '80', '-y', String(OPENCODE_PANE_HEIGHT),
        ]);
      } catch {
        // Non-fatal: resize may fail in some environments
      }

      // Issue #1763: pick the port before the command is built. The TUI is its
      // own HTTP server once `--port` is passed (#1758 §5.1.2), and CommandMate
      // assigns the number because opencode's `--port 0` is not an OS-assigned
      // port — it tries 4096 first and only then falls back to an ephemeral one
      // that nothing can read back (§5.9). Null means "no structured events",
      // and the launch below is then the pre-#1763 bare command.
      await reserveOpencodeServerPort(target, worktreePath);

      // Start OpenCode TUI. `buildAgentLaunchCommandLine` asks the tool's own
      // `AgentEventSource` for the plan (S3/S4/S5) and never throws. opencode's
      // environment is empty — it is the one source with no correlation
      // variable, because CommandMate holds the connection (#1846).
      const launchCommand = buildAgentLaunchCommandLine({
        target,
        executablePath: this.command,
        worktreePath,
      });
      await sendKeys(sessionName, launchCommand, true);

      // Wait for OpenCode to initialize (GPU model loading via Ollama)
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_INIT_WAIT_MS));

      // Issue #1763: subscribe once the server has had the same time to come up
      // that the TUI has. Health-checked first, so an opencode too old to know
      // `--port` costs one probe and nothing else.
      await attachOpencodeEventStream(target);

      logger.info('started-opencode-session:sessionname');
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
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `OpenCode session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'opencode',
      });

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-opencode-session:session');
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
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Issue #1763: stop watching before the pane goes, so the stream is not
    // reconnecting to a server that is being shut down. Also gives the port
    // back — the pane is what held it. Never throws.
    await releaseOpencodeEventStream(opencodeTarget(worktreeId, instanceId));

    try {
      // Step 1: Check if the tmux session currently exists
      const exists = await hasSession(sessionName);
      if (exists) {
        // Step 2: Send /exit command for graceful TUI shutdown [D1-006]
        await sendKeys(sessionName, OPENCODE_EXIT_COMMAND, true);

        // Step 3: Wait for OpenCode to process the exit command
        await new Promise((resolve) => setTimeout(resolve, OPENCODE_EXIT_WAIT_MS));

        // Step 4: Check if session still exists; force-kill if needed [D1-007]
        const stillExists = await hasSession(sessionName);
        if (stillExists) {
          await killSession(sessionName);
        }
      } else {
        // Step 5: Session does not exist, attempt kill anyway (cleanup stale tmux sessions)
        await killSession(sessionName);
      }

      // Issue #405: Invalidate cache after session kill
      invalidateCache(sessionName);

      logger.info('stopped-opencode-session:sessionname');
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
