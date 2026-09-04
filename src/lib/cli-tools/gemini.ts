/**
 * Gemini CLI tool implementation
 * Provides integration with Google's Gemini CLI in interactive mode
 *
 * @remarks Issue #368: Rewritten from non-interactive pipe mode to interactive REPL mode.
 * Previous implementation used `echo 'msg' | gemini` which caused the process to exit
 * immediately, making response polling impossible. Now launches `gemini` in interactive
 * mode within tmux (same approach as Claude/Codex).
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKey,
  killSession,
  capturePane,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { GEMINI_PANE_HEIGHT } from './capture-spec';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { GEMINI_PROMPT_PATTERN, stripAnsi } from '../detection/cli-patterns';
import { GEMINI_CLI_TOOL_ID } from '@/lib/hooks/sources';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import { createLogger } from '@/lib/logger';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_INTERRUPT_SETTLE_MS,
  TUI_EXIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { missingToolError } from './install-hints';

const logger = createLogger('cli-tools/gemini');

/**
 * Extract error message from unknown error type (DRY)
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Gemini CLI to initialize after launch (banner + auth + dialog) */
const GEMINI_INIT_WAIT_MS = 6000;

/**
 * Gemini runs in a 200-line tmux pane and keeps the prompt near the top.
 *
 * Declared in `./capture-spec` since Issue #1933 and re-exported here so every
 * existing importer is unchanged. It moved for the same reason
 * `OPENCODE_PANE_HEIGHT` moved to `@/config/tmux-pane-config` in #1906: the
 * status probe needs the number and must not have to import the tool for it.
 */
export { GEMINI_PANE_HEIGHT };

/** Interval for polling trust dialog / prompt detection */
const GEMINI_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const GEMINI_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const GEMINI_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Gemini CLI tool implementation
 * Manages Gemini interactive sessions using tmux
 */
export class GeminiTool extends BaseCLITool {
  readonly id: CLIToolType = 'gemini';
  readonly name = 'Gemini CLI';
  readonly command = 'gemini';

  /**
   * Check if Gemini session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Gemini session for a worktree
   * Launches `gemini` in interactive REPL mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Check if Gemini is installed
    const geminiAvailable = await this.isInstalled();
    if (!geminiAvailable) {
      throw missingToolError(this);
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName);

      // Issue #2070: this branch used to return unconditionally. A tmux session
      // outlives the agent that was launched into it — a quit, a self-update, a
      // crash — and the launch was then skipped for a pane holding nothing but a
      // shell prompt, which left `kill-session` by hand as the only recovery.
      // When the tool is gone we fall THROUGH and re-send the launch command
      // into the same pane.
      if (await this.isToolLive(sessionName, { confirm: true })) {
        logger.info('gemini-session-sessionname');
        return;
      }
      logger.warn('gemini-session-relaunch', { sessionName });
    }

    // Issue #1762: fence this instance's structured events off from the process
    // that used to hold the same (worktree, tool, instance) key. On the creation
    // path only — the reuse branch above has already returned — and before the
    // pane exists, so no live pane is ever judged against a stale generation.
    // Bumped even if the launch below then fails: falling back to the screen
    // scraper is always safe, trusting a dead session's events is not.
    //
    // Issue #2070: reached on the RELAUNCH path too — the pane is the same one,
    // but the process is not, and the dead process's events must not be read as
    // the new one's.
    beginAgentSession({ worktreeId, cliToolId: GEMINI_CLI_TOOL_ID, instanceId });

    try {
      // Issue #2070: creation only. On the relaunch path the pane already
      // exists and holds the transcript of the process that died in it; the
      // launch command is re-sent into that same pane.
      if (!exists) {
        // Create tmux session. Scrollback depth comes from the shared
        // TMUX_HISTORY_LIMIT default (Issue #1624) — do not re-hardcode it here.
        await createSession({
          sessionName,
          workingDirectory: worktreePath,
        });

        // Wait a moment for the session to be created
        await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));
      }

      // Start Gemini CLI in interactive mode (no flags = interactive REPL).
      //
      // Issue #1762 hands this worktree its own hooks config, merged into any
      // `.gemini/settings.json` that is already there; Issue #1846 moved that
      // write inside `prepareLaunch`, where it belongs — the worktree path is
      // now part of the launch context, so the second entry point this file
      // used to call (`injectGeminiHookSettings`) is gone.
      //
      // The rendered line prefixes `CM_HOOK_URL`, which is what tells the
      // receiver which instance an event came from — `.gemini/settings.json` is
      // per worktree and cannot. `CM_AGENT_HOOKS_INJECT=0` returns the bare
      // command, unchanged from before these Issues. Fail-open throughout: a
      // config that cannot be written costs the events and nothing else.
      const launchCommand = buildAgentLaunchCommandLine({
        target: { worktreeId, cliToolId: GEMINI_CLI_TOOL_ID, instanceId },
        executablePath: this.command,
        worktreePath,
      });
      await sendKeys(sessionName, launchCommand, true);

      // Wait for Gemini to initialize (minimum wait for banner/auth)
      await new Promise((resolve) => setTimeout(resolve, GEMINI_INIT_WAIT_MS));

      // Poll until Gemini interactive prompt is ready
      // Handles trust dialog automatically if encountered
      await this.waitForReady(sessionName);

      logger.info('started-gemini-session:sessionname');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Gemini session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Gemini CLI to become ready (prompt visible).
   * Handles trust dialog automatically if encountered.
   * Polls until GEMINI_PROMPT_PATTERN is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    let trustDialogHandled = false;
    for (let i = 0; i < GEMINI_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, GEMINI_PANE_HEIGHT);
        // Strip ANSI escape codes before pattern matching
        // (Gemini TUI uses 24-bit color codes that break regex matching)
        const output = stripAnsi(rawOutput);

        // Check if interactive prompt is ready
        if (GEMINI_PROMPT_PATTERN.test(output)) {
          logger.info('gemini-prompt-detected');
          return;
        }

        // Handle trust dialog if not yet handled
        if (!trustDialogHandled && output.includes('Do you trust this folder?')) {
          await sendSpecialKey(sessionName, 'Enter');
          trustDialogHandled = true;
          logger.info('auto-trusted-folder-for');
          // Continue polling for prompt after trust dialog
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, GEMINI_POLL_INTERVAL_MS));
    }
    logger.info('gemini-prompt-detection');
  }

  /**
   * Wait for Gemini prompt before sending a message.
   * Used by sendMessage to ensure Gemini is ready to accept input.
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < GEMINI_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, GEMINI_PANE_HEIGHT);
        const output = stripAnsi(rawOutput);
        if (GEMINI_PROMPT_PATTERN.test(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('gemini-prompt-not');
  }

  /**
   * Send a message to Gemini interactive session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session exists
    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `Gemini session ${sessionName} does not exist. Start the session first.`
      );
    }

    // Issue #2070: the pane exists, but does the AGENT? An agent that quit,
    // updated itself or crashed leaves its tmux session behind, and the send
    // that followed used to sit in the readiness wait until it timed out —
    // leaving `kill-session` by hand as the only recovery. Relaunches into the
    // same pane when the tool is gone; costs one `capture-pane` when it is not.
    await this.relaunchIfToolExited(worktreeId, instanceId);

    try {
      // Verify Gemini is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'gemini',
        composer: this.describeComposer(),
      });

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-gemini-session:sessionna');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Gemini: ${errorMessage}`);
    }
  }

  /**
   * Kill Gemini session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    try {
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+C to interrupt any running operation
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, TUI_INTERRUPT_SETTLE_MS));

        // Send /quit to exit Gemini gracefully
        await sendKeys(sessionName, '/quit', true);
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-gemini-session:sessionname');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
