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
  sendKeys,
  sendSpecialKey,
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
  TUI_INTERRUPT_SETTLE_MS,
  TUI_EXIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { withLaunchScreenCleared } from '@/lib/session/launch-screen';
import { getErrorMessage } from '@/lib/errors';
import { decideLaunchDialog, GEMINI_TRUST_LAUNCH_DIALOG, launchDialogWarning } from './launch-dialog';
import { beginLaunchWindow, endLaunchWindow, recordLaunchDialogPress } from './launch-window';
import {
  answerUnderInstanceInputLock,
  instanceInputLaunchReadMark,
} from '@/lib/session/instance-input-lock';

const logger = createLogger('cli-tools/gemini');

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

/**
 * How long the launch window stays open after the trust Enter when the wait
 * runs out first (review of #3776): gemini takes about 2 s to draw its restart
 * line, and until then the answered dialog still reads as `press` — a poller
 * free to answer it would type `1` into the restarted gemini.
 */
const GEMINI_TRUST_SETTLE_MS = 5000;

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
   * Start a new Gemini session for a worktree
   * Launches `gemini` in interactive REPL mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Check if Gemini is installed
    await this.requireInstalled();

    const { sessionName, exists, live } = await this.resolveLaunchPane(worktreeId, worktreePath, instanceId, {
      logger,
      liveAction: 'gemini-session-exists',
      relaunchAction: 'gemini-session-relaunch',
    });
    if (live) return;

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
        await this.createLaunchPane(sessionName, worktreePath);
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
      // Issue #3776: from the launch line to the end of `waitForReady`, the
      // trust dialog is this launch's to answer; the Auto-Yes poller leaves it.
      beginLaunchWindow(sessionName);
      try {
        // Issue #3975: the launch line is one writer's turn, so a send's body
        // already in the pane is not run as part of it. Only the keys: the
        // waits below stay outside the lock, where a send waiting for the
        // prompt cannot be held behind them.
        // Issue #3981: through the one launch-key writer every tool shares.
        await this.typeLaunchLines(sessionName, [withLaunchScreenCleared(launchCommand)]);

        // Wait for Gemini to initialize (minimum wait for banner/auth)
        await new Promise((resolve) => setTimeout(resolve, GEMINI_INIT_WAIT_MS));

        // Poll until Gemini interactive prompt is ready
        // Handles trust dialog automatically if encountered
        await this.waitForReady(sessionName);
      } finally {
        endLaunchWindow(sessionName);
      }

      logger.info('started-gemini-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Gemini session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Gemini CLI to become ready (prompt visible).
   * Handles trust dialog automatically if encountered.
   * Polls until GEMINI_PROMPT_PATTERN is detected or max attempts reached.
   *
   * Issue #3776: the trust dialog gets its Enter only while the cursor is on
   * `1. Trust folder` ({@link GEMINI_TRUST_LAUNCH_DIALOG}); on any other row,
   * or on a screen that looks like the dialog but no longer reads as it, nothing
   * is sent and the launch logs why, once per reason.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    let trustDialogHandled = false;
    let trustPressedAt: number | null = null;
    const loggedDecisions = new Set<string>();
    for (let i = 0; i < GEMINI_INIT_MAX_ATTEMPTS; i++) {
      try {
        // Issue #3975: taken before the read the trust Enter is decided on.
        const readMark = instanceInputLaunchReadMark();
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
        if (!trustDialogHandled) {
          const decision = decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, output);
          if (decision.action === 'press') {
            // Issue #3975: the Enter as an `exclusive` writer, so it never lands
            // inside a send's body, paste or Enter; a send that came between
            // the read and the lock makes the dialog be read again first.
            const pressed = await answerUnderInstanceInputLock(
              sessionName,
              readMark,
              async () => {
                const again = decideLaunchDialog(
                  GEMINI_TRUST_LAUNCH_DIALOG,
                  stripAnsi(await capturePane(sessionName, GEMINI_PANE_HEIGHT))
                );
                return again.action === 'press' && again.key === decision.key;
              },
              () => sendSpecialKey(sessionName, decision.key),
              { mode: 'exclusive' }
            );
            if (pressed.answered) {
              trustDialogHandled = true;
              trustPressedAt = Date.now();
              // Issue #3790: the poller leaves the answered dialog alone even if
              // the window closes before gemini redraws it.
              recordLaunchDialogPress(sessionName, trustPressedAt);
              logger.info('auto-trusted-folder-for-gemini');
              // Continue polling for prompt after trust dialog
            } else {
              // Not answered this poll; the next one reads the screen again.
              logger.info('gemini-trust-answer-skipped', { sessionName, reason: pressed.reason });
            }
          } else {
            const warning = launchDialogWarning(GEMINI_TRUST_LAUNCH_DIALOG, decision);
            if (warning && decision.action !== 'absent' && !loggedDecisions.has(decision.reason)) {
              loggedDecisions.add(decision.reason);
              logger.warn(warning.event, { sessionName, ...warning.fields });
            }
          }
        }
      } catch (error: unknown) {
        // Capture may fail during initialization - continue polling
        logger.debug('gemini-ready-capture-failed', { sessionName, error: getErrorMessage(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, GEMINI_POLL_INTERVAL_MS));
    }
    // The caller closes the launch window when this returns: not before the
    // trust Enter has had time to show gemini's restart line.
    if (trustPressedAt !== null) {
      const settle = GEMINI_TRUST_SETTLE_MS - (Date.now() - trustPressedAt);
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
    }
    logger.info('gemini-prompt-detection');
  }

  /**
   * Wait for Gemini prompt before sending a message.
   * Used by sendMessage to ensure Gemini is ready to accept input.
   *
   * @throws Error (`Gemini prompt not ready`) when the prompt did not appear
   *   within {@link GEMINI_PROMPT_WAIT_TIMEOUT_MS}; nothing was typed
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
      } catch (error: unknown) {
        // Capture may fail - continue polling
        logger.debug('gemini-prompt-capture-failed', { sessionName, error: getErrorMessage(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    // Issue #3981: give up without typing, as codex does. Sending anyway put the
    // body into whatever held the pane (a dialog, a slow start, a shell).
    logger.info('gemini-prompt-not-detected');
    throw new Error(
      'Gemini prompt not ready: timed out waiting for the input prompt before sending'
    );
  }

  /**
   * Send a message to Gemini interactive session
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Issue #2070: the pane exists, but does the AGENT? An agent that quit,
    // updated itself or crashed leaves its tmux session behind, and the send
    // that followed used to sit in the readiness wait until it timed out —
    // leaving `kill-session` by hand as the only recovery. Relaunches into the
    // same pane when the tool is gone; costs one `capture-pane` when it is not.
    await this.requireSession('Gemini', worktreeId, instanceId, { relaunch: true });

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

      logger.info('sent-message-to-gemini-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      // Issue #4031: the cause keeps a failed `load-buffer`'s code (`classifySendFailure`).
      throw new Error(`Failed to send message to Gemini: ${errorMessage}`, { cause: error });
    }
  }

  /**
   * Kill Gemini session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    await this.requestExitAndKill(worktreeId, instanceId, {
      logger,
      stoppedAction: 'stopped-gemini-session',
      requestExit: async (sessionName) => {
        // Send Ctrl+C to interrupt any running operation
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, TUI_INTERRUPT_SETTLE_MS));

        // Send /quit to exit Gemini gracefully
        await sendKeys(sessionName, '/quit', true);
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      },
    });
  }
}
