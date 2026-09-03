/**
 * Command Code CLI tool implementation (Issue #2250, Epic #2249 Phase A).
 *
 * Integration with the Command Code CLI (`commandcode`, measured against
 * v1.40.1). Command Code renders an INLINE TUI — `#{alternate_on}` is 0 and the
 * pane keeps its scrollback, like codex and agy, unlike claude v2 / opencode /
 * copilot — with a claude-shaped bottom-pinned composer:
 *
 * ```text
 * ❯ <echoed prompt>
 * ✻ Thought for 1 second [ctrl+o to expand]
 * ⠶ <reply>
 *  ✻ Worked for 2s
 * ────────────────────────  ← rule
 * ❯ Ask your question...    ← composer
 * ────────────────────────  ← rule
 *   ? for shortcuts · taste on
 * ```
 *
 * ## The executable is `commandcode`, not `cmd`
 *
 * The package ships four bins — `cmd`, `cmdc`, `command-code`, `commandcode`.
 * `cmd` collides with Windows' shell and reads as CommandMate's own name in a
 * log line, so the unambiguous spelling is the one CommandMate launches
 * (Epic #2249 決定 1).
 *
 * ## The launch line lives in one place
 *
 * {@link buildCommandCodeLaunchCommand} is the only thing that renders it. Phase
 * B (#2251) replaces its body with `buildAgentLaunchCommandLine` so hooks and
 * `CM_HOOK_URL` are prefixed the way agy's and copilot's are; keeping the string
 * in one function is what makes that a one-line change instead of a hunt.
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKeys,
  killSession,
  capturePane,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import {
  stripAnsi,
  findCommandCodeChromeStart,
  COMMAND_CODE_THINKING_PATTERN,
} from '../detection/cli-patterns';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  COMMAND_CODE_INIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { SessionStartUnavailableError } from '../session/session-start-error';

const logger = createLogger('cli-tools/command-code');

/** The executable CommandMate launches. See the module docblock for why not `cmd`. */
export const COMMAND_CODE_COMMAND = 'commandcode';

/**
 * Launch flags, in the order Epic #2249 決定 2 fixed them.
 *
 * - `--trust` skips the first-run "do you trust this folder?" confirmation, so a
 *   worktree CommandMate just created does not park the session on a dialog no
 *   one is watching.
 * - `--skip-onboarding` skips the taste-onboarding walkthrough, which is the
 *   same class of unattended-launch blocker (#2131's `wait` sat on claude's
 *   onboarding dialog for three hours).
 * - `--no-auto-update` because a background self-update restarts the agent, and
 *   a restart is what killed Auto-Yes the last time an agent did it.
 */
export const COMMAND_CODE_LAUNCH_FLAGS: readonly string[] = [
  '--trust',
  '--skip-onboarding',
  '--no-auto-update',
] as const;

/** `/exit` — Command Code's own quit command. */
export const COMMAND_CODE_EXIT_COMMAND = '/exit';

/**
 * Render the shell line that starts Command Code in a pane.
 *
 * The single seam Phase B (#2251) replaces: today it is the bare executable plus
 * {@link COMMAND_CODE_LAUNCH_FLAGS}, and the hooks Issue swaps the body for
 * `buildAgentLaunchCommandLine({ target, executablePath, worktreePath })` so the
 * `CM_HOOK_URL` assignment lands in front of the command. Callers — the launch
 * path here and `tests/unit/cli-tools/command-code.test.ts` — go through this
 * function so neither has to be edited when that happens.
 *
 * @param executablePath - The `commandcode` binary (overridable for tests)
 * @returns The command line to type at the pane's shell prompt
 */
export function buildCommandCodeLaunchCommand(
  executablePath: string = COMMAND_CODE_COMMAND
): string {
  return [executablePath, ...COMMAND_CODE_LAUNCH_FLAGS].join(' ');
}

/** Interval for polling composer readiness. */
const COMMAND_CODE_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s window). */
const COMMAND_CODE_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for the composer before sending a message. */
const COMMAND_CODE_PROMPT_WAIT_TIMEOUT_MS = 15000;

/** Rows of pane tail the readiness probe reads. */
const COMMAND_CODE_READINESS_CAPTURE_LINES = 50;

/**
 * Whether Command Code is sitting at a live, empty-of-work composer.
 *
 * Structural rather than textual, for the reason
 * {@link findCommandCodeChromeStart} spells out: the composer block is drawn
 * only when the agent is accepting input. While a permission dialog is up the
 * whole block is replaced by the dialog (`dialog-create-file.txt` has one rule
 * and no composer), and while a turn runs the status row sits above the block —
 * hence the second condition.
 *
 * The footer's `? for shortcuts` is deliberately NOT the signal: it is only the
 * DEFAULT permission mode's spelling of that row (see
 * `COMMAND_CODE_MODE_INDICATOR_PATTERN`), so a session started in plan or
 * auto-accept mode would never look ready.
 *
 * @param rawOutput - A captured pane, ANSI intact
 * @returns True when the composer is on screen and no turn is in flight
 */
export function isCommandCodeReady(rawOutput: string): boolean {
  const lines = rawOutput.split('\n');
  const chromeStart = findCommandCodeChromeStart(lines);
  if (chromeStart < 0) return false;
  return !COMMAND_CODE_THINKING_PATTERN.test(stripAnsi(rawOutput));
}

/**
 * Command Code CLI tool implementation.
 * Manages `commandcode` sessions using tmux.
 */
export class CommandCodeTool extends BaseCLITool {
  readonly id: CLIToolType = 'command-code';
  readonly name = 'Command Code CLI';
  readonly command = COMMAND_CODE_COMMAND;

  /**
   * Check if a Command Code session is running for a worktree.
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @returns True if session is running
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Command Code session for a worktree.
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  protected async launchSession(
    worktreeId: string,
    worktreePath: string,
    instanceId?: string
  ): Promise<void> {
    const available = await this.isInstalled();
    if (!available) {
      throw new SessionStartUnavailableError(
        this.name,
        'Command Code CLI (commandcode) is not installed or not in PATH'
      );
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName);

      // Issue #2070's shape: a tmux session outlives the agent that was launched
      // into it, and skipping the launch for a pane holding nothing but a shell
      // prompt leaves `kill-session` by hand as the only recovery.
      if (await this.isToolLive(sessionName, { confirm: true })) {
        logger.info('command-code-session-exists');
        return;
      }
      logger.warn('command-code-session-relaunch', { sessionName });
    }

    try {
      if (!exists) {
        // Inline-rendered, so the pane keeps scrollback; depth comes from the
        // shared TMUX_HISTORY_LIMIT default (Issue #1624).
        await createSession({
          sessionName,
          workingDirectory: worktreePath,
        });
        await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));
      }

      await sendKeys(sessionName, buildCommandCodeLaunchCommand(this.command), true);

      await new Promise((resolve) => setTimeout(resolve, COMMAND_CODE_INIT_WAIT_MS));

      await this.waitForReady(sessionName);

      logger.info('started-command-code-session');
    } catch (error: unknown) {
      throw new Error(`Failed to start Command Code session: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Poll until the composer block is drawn.
   *
   * No dialog is answered here: `--trust` and `--skip-onboarding` are what
   * remove the two startup dialogs Command Code has, so a launch that still
   * parks on one is a launch whose flags did not take effect — and blind-firing
   * Enter at an unmeasured dialog is how #1928 describes an Auto-Yes accident.
   * A timeout logs and returns; the send path's own wait is what refuses.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    for (let i = 0; i < COMMAND_CODE_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, COMMAND_CODE_READINESS_CAPTURE_LINES);
        if (isCommandCodeReady(rawOutput)) {
          logger.info('command-code-prompt-detected');
          return;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, COMMAND_CODE_POLL_INTERVAL_MS));
    }
    logger.info('command-code-prompt-detection-timeout');
  }

  /**
   * Wait for the composer before sending a message.
   * Mirrors CodexTool.waitForPrompt: throws on timeout so a failed readiness
   * check STOPS the send rather than typing into a non-ready TUI.
   *
   * @throws Error when the composer is not detected within the timeout
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < COMMAND_CODE_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, COMMAND_CODE_READINESS_CAPTURE_LINES);
        if (isCommandCodeReady(rawOutput)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('command-code-prompt-not-ready');
    throw new Error(
      'Command Code prompt not ready: timed out waiting for the composer before sending'
    );
  }

  /**
   * Send a message to the Command Code session.
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `Command Code session ${sessionName} does not exist. Start the session first.`
      );
    }

    // Issue #2070: the pane exists, but does the AGENT? Relaunches into the same
    // pane when the tool is gone; costs one `capture-pane` when it is not.
    await this.relaunchIfToolExited(worktreeId, instanceId);

    try {
      await this.waitForPrompt(sessionName);

      // Issue #1471: body/Enter separation + read-back submit verification.
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'command-code',
        composer: this.describeComposer(),
      });

      // Required so the poller re-reads instead of answering from the 5s cache.
      invalidateCache(sessionName);

      logger.info('sent-message-to-command-code-session');
    } catch (error: unknown) {
      throw new Error(`Failed to send message to Command Code: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Kill the Command Code session.
   *
   * `/exit` typed and submitted as SEPARATE tmux commands, the shape #1905
   * settled on for opencode: `/` opens Command Code's slash-command menu, and a
   * `C-m` arriving inside the same `send-keys` is consumed by that menu rather
   * than by the composer. Measured on 1.40.1 — the separated form exits the
   * agent and drops the pane back to its shell.
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    try {
      const exists = await hasSession(sessionName);
      if (exists) {
        await sendKeys(sessionName, COMMAND_CODE_EXIT_COMMAND, false);
        await new Promise((resolve) => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));
        await sendSpecialKeys(sessionName, ['Enter']);
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      }

      const killed = await killSession(sessionName);

      // So a later session reusing the name starts clean.
      invalidateCache(sessionName);

      if (killed) {
        logger.info('stopped-command-code-session');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
