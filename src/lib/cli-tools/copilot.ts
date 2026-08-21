/**
 * Copilot CLI tool implementation
 * Issue #545: Provides integration with GitHub Copilot CLI
 *
 * Copilot CLI is a standalone executable (`brew install copilot-cli`,
 * `npm i -g @github/copilot`), NOT a gh extension — the `gh-copilot` extension
 * this module was written against is a different, retired product, and `gh`'s
 * own `copilot` command is a preview wrapper that *downloads* the standalone
 * binary when `PATH` has none. So the base command is `copilot` and `gh copilot`
 * is only the fallback for a machine whose copy gh downloaded for itself
 * (Issue #1907).
 *
 * isInstalled() is overridden to require positive evidence — an executable that
 * answers `--version` — rather than the absence of an error from a help screen.
 * See `./copilot-executable`, which also keeps execFile (not exec) for security
 * [SEC4-001].
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
import { invalidateCache } from '../tmux/tmux-capture-cache';
import {
  COPILOT_PROMPT_PATTERN,
  COPILOT_SELECTION_LIST_PATTERN,
  COPILOT_SEPARATOR_PATTERN,
  COPILOT_FOLDER_TRUST_ANSWER_KEY,
  isCopilotFolderTrustDialog,
  stripAnsi,
} from '../detection/cli-patterns';
import { resolveCopilotExecutable } from './copilot-executable';
import type { CopilotExecutable } from './copilot-executable';
import {
  COPILOT_TEXT_INPUT_DELAY_MS,
  COPILOT_SEND_ENTER_DELAY_MS,
  COPILOT_MODEL_SWITCH_TIMEOUT_MS,
  COPILOT_INSTALL_HINT,
} from '@/config/copilot-constants';
import { TUI_SESSION_CREATE_WAIT_MS, TUI_INTERRUPT_SETTLE_MS, TUI_EXIT_WAIT_MS } from '@/config/cli-tool-timing-config';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import { COPILOT_LAUNCH_COMMAND } from '@/lib/hooks/sources/copilot/hook-settings';
import { COPILOT_CLI_TOOL_ID } from '@/lib/hooks/sources/copilot/tool-id';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/copilot');

/** Interval for polling prompt detection */
const COPILOT_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const COPILOT_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const COPILOT_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Copilot CLI slash commands that trigger a selection list UI.
 * These commands open an interactive picker after execution.
 * When sending these, we must wait for the selection list to appear
 * before allowing further input, to prevent text leaking into the search field.
 *
 * Issue #1913 measured the pickers on copilot 1.0.80 in a private tmux socket.
 * Eleven commands open one: model, agent, theme, permissions, skills, mcp,
 * settings, statusline, subagents, resume, session. The set below was NOT
 * widened to cover the other eight, because the wait they would enter is
 * already broken on this version and widening it would only add latency:
 *
 *   `COPILOT_SELECTION_LIST_PATTERN` matches none of the eleven frames — not
 *   even the three listed here. `/model` renders `❯  Search models…` with
 *   U+2026, so `Search\s+\w+\.\.\.` misses it, and every picker footer spells
 *   the verbs in lower case (`↑/↓ to navigate · enter to select · esc to
 *   cancel`), so `Enter to (?:select|confirm)` misses them too. So
 *   `waitForSelectionList` burns its full 5s window and returns false for every
 *   entry in this set.
 *
 * Fixing the pattern belongs to the detection layer (`cli-patterns.ts`, the
 * #1885 / #1886 line of work); this branch is additionally unreachable today
 * because `send-user-message.ts` bypasses `CopilotTool.sendMessage` (#1906).
 * Widen this set once the pattern actually matches 1.0.80 frames.
 */
const SELECTION_LIST_COMMANDS = new Set(['model', 'agent', 'theme']);

/**
 * The composer row, matched one line at a time (Issue #1907).
 *
 * `COPILOT_PROMPT_PATTERN` is written for whole frames, where its `\s` can match
 * the newline that follows a bare `❯`; against a single line there is nothing
 * after the glyph for it to match. Anchored at column 0, which is where copilot
 * draws the composer and where it draws nothing else — while a dialog is up the
 * row is removed from the frame entirely (Issue #1886).
 */
const COPILOT_COMPOSER_ROW_PATTERN = /^[>❯](?:\s|$)/;

/**
 * Copilot CLI tool implementation
 * Manages GitHub Copilot interactive sessions using tmux
 *
 * command = 'copilot': the standalone executable, which is what both supported
 * installers put on PATH. It used to be `gh`, from the days when copilot was the
 * `gh-copilot` extension (Issue #1907).
 *
 * isInstalled() overrides BaseCLITool because `which copilot` is not enough
 * evidence on its own and because gh's downloaded copy is deliberately off PATH.
 * [DR1-004][SEC4-001]
 */
export class CopilotTool extends BaseCLITool {
  readonly id: CLIToolType = 'copilot';
  readonly name = 'Copilot';
  readonly command = 'copilot';

  /**
   * Check if GitHub Copilot CLI is available.
   *
   * Issue #1907: this used to be `gh --version` followed by `gh copilot --help`,
   * both of which exit 0 on a machine with no copilot at all — `copilot` is a
   * preview command built into gh, and its help says it will *download* the CLI
   * if none is installed. The badge was wrong and, worse, `startSession` then
   * typed `gh copilot` into the pane and the download ran there.
   *
   * Delegates to {@link resolveCopilotExecutable}, which answers with positive
   * evidence only: an executable file that exits 0 on `--version` and prints a
   * version string.
   *
   * @returns True when a copilot executable was found and answered
   */
  async isInstalled(): Promise<boolean> {
    return (await resolveCopilotExecutable()) !== null;
  }

  /**
   * The command line that starts the resolved copilot in a pane.
   *
   * `PATH` first (Issue #1907). `gh copilot` is reached only for a copy gh
   * downloaded for itself: it is not on PATH by design, and gh prefers PATH, so
   * gh runs exactly the file that was probed. Because the probe already proved
   * that file exists, this branch cannot trigger gh's download either.
   */
  private launchExecutable(resolved: CopilotExecutable): string {
    return resolved.source === 'path' ? this.command : COPILOT_LAUNCH_COMMAND;
  }

  /**
   * Check if Copilot session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Copilot session for a worktree
   * Launches copilot in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Issue #1907: resolved once, and the same resolution decides both whether to
    // start at all and what to type. Asking `isInstalled()` and then launching a
    // hardcoded command is how `gh copilot` came to be sent to machines that had
    // no copilot: the answer and the action have to come from one measurement.
    const resolved = await resolveCopilotExecutable();
    if (!resolved) {
      throw new Error(`GitHub Copilot CLI is not installed. ${COPILOT_INSTALL_HINT}`);
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName);
      logger.info('copilot-session-exists');
      return;
    }

    // Issue #1761: fence this session off from the previous copilot process's
    // events. The state is keyed by (worktree, tool, instance), a key the new
    // session reuses verbatim, so without this the old process's last
    // `user_prompt_submit` reads as the new one's and a session publishes
    // `running` before anybody has typed into it (#1723).
    //
    // Creation path only — the reuse branch above has already returned — and
    // before the pane exists, so no live pane is ever judged against a stale
    // generation. Outside the try, so a launch that then fails is still fenced:
    // falling back to the scraper is always safe, trusting a dead session's
    // events is not.
    beginAgentSession({ worktreeId, cliToolId: COPILOT_CLI_TOOL_ID, instanceId });

    try {
      // Create tmux session. Scrollback depth comes from the shared
      // TMUX_HISTORY_LIMIT default (Issue #1624) — do not re-hardcode it here.
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));

      // Issue #1761: hand this session its hook configuration, so structured
      // lifecycle events and Auto-Yes adjudication exist without the operator
      // having edited ~/.copilot/settings.json by hand.
      //
      // The returned command is the resolved executable with two environment
      // assignments in front of it. Copilot's config is one file for the whole
      // machine, so unlike Claude's `--settings` it cannot carry the correlation
      // keys — they ride in the environment and the hook reads them when it
      // fires. See `lib/hooks/sources/copilot/hook-settings`.
      //
      // Fails open in every branch: with `CM_AGENT_HOOKS_INJECT=0`, or with a
      // settings file that cannot be read or written, this is the bare launch
      // command and nothing else.
      const launchCommand = buildAgentLaunchCommandLine({
        target: { worktreeId, cliToolId: COPILOT_CLI_TOOL_ID, instanceId },
        executablePath: this.launchExecutable(resolved),
        worktreePath,
      });

      // Start Copilot CLI in interactive mode
      await sendKeys(sessionName, launchCommand, true);

      // Issue #1907: no blind sleep before this. The 4-second one that used to
      // sit here was a guess at how long copilot takes to paint (measured on
      // 1.0.80: banner at ~1.3 s, folder-trust dialog at ~2.5 s), and it was
      // load-bearing only because it hid the shell prompt from the first poll.
      // `waitForReady` now recognises copilot's own composer rather than any
      // `❯`, so it can start looking immediately and stop as soon as the pane is
      // really ready.
      await this.waitForReady(sessionName);

      logger.info('started-copilot-session', {
        executableSource: resolved.source,
        version: resolved.version,
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Copilot session: ${errorMessage}`);
    }
  }

  /**
   * Answer copilot's "Confirm folder trust" dialog when the pane is sitting on
   * it (Issue #1886).
   *
   * Sends the session-only option (`1. Yes`) and nothing else. Option 2 ("Yes,
   * and remember this folder for future sessions") writes `trustedFolders` into
   * `~/.copilot/config.json`, one file shared by every checkout on the machine,
   * so `isCopilotFolderTrustDialog` refuses the frame outright if the list is
   * ever reordered and `1` is no longer the session-only choice -- the same rule
   * that makes codex's launch decline its hooks-review dialog (Issue #1760):
   * CommandMate answers on the operator's behalf only where the answer does not
   * write the operator's config.
   *
   * `sendEnter=false` because 1.0.80 confirms on the digit alone (measured on a
   * live pane); a trailing Enter would land as an empty submit on the composer
   * that the dismissal reveals.
   *
   * The capture cache is dropped afterwards because the cached frame is now
   * wrong in a way that blocks work: a consumer reading the dialog frame reports
   * `waiting`, and the send guard refuses a `waiting` session for as long as
   * that entry lives.
   *
   * @param sessionName - tmux session name
   * @param output - ANSI-stripped pane capture
   * @returns True when the dialog was found and answered
   */
  private async answerFolderTrustDialog(sessionName: string, output: string): Promise<boolean> {
    if (!isCopilotFolderTrustDialog(output)) {
      return false;
    }
    await sendKeys(sessionName, COPILOT_FOLDER_TRUST_ANSWER_KEY, false);
    invalidateCache(sessionName);
    logger.info('copilot-folder-trust-answered');
    return true;
  }

  /**
   * Whether copilot's own composer is drawn on the pane (Issue #1907).
   *
   * `COPILOT_PROMPT_PATTERN` alone answers "is there a `❯` or `>` at column 0",
   * and a great many shell prompts are exactly that. That was harmless while a
   * fixed 4-second sleep stood between the launch keystroke and the first poll;
   * with the sleep gone, the very first capture is the shell echoing the launch
   * command, and on any `❯`-prefixed prompt (starship, pure, agnoster) it would
   * read as ready — the session would be declared started before copilot had
   * drawn anything, and the message would be typed into a booting TUI.
   *
   * So readiness needs a signal that belongs to copilot rather than to whoever
   * owns the pane. Measured on 1.0.80 at production geometry, copilot draws its
   * composer as three rows: a full-width rule, the `❯` row, another full-width
   * rule. Nothing else on the boot path has that shape — not the shell, not the
   * banner-only frame, and not the folder-trust dialog, whose option rows are
   * boxed and whose neighbours are dialog text (see
   * `tests/fixtures/copilot-launch-boot-1080.ts`).
   *
   * A false negative here is the pre-existing behaviour: the loop times out,
   * logs, and the launch continues. A false positive is a message typed into a
   * shell, so the check is deliberately the strict one.
   *
   * @param output - ANSI-stripped pane capture (box drawing still present)
   */
  private isComposerDrawn(output: string): boolean {
    const lines = output.split('\n');
    for (let i = 1; i < lines.length - 1; i++) {
      if (!COPILOT_COMPOSER_ROW_PATTERN.test(lines[i])) continue;
      if (
        COPILOT_SEPARATOR_PATTERN.test(lines[i - 1].trimEnd()) &&
        COPILOT_SEPARATOR_PATTERN.test(lines[i + 1].trimEnd())
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Wait for Copilot CLI to become ready (prompt visible).
   *
   * Readiness is asserted by seeing the composer, never by a dialog's absence:
   * copilot draws `❯` at column 0 and removes that row entirely while a dialog
   * is up, so a `COPILOT_PROMPT_PATTERN` match is a real input prompt and never
   * an option row. Do NOT feed this check a `stripBoxDrawing`ed frame -- that
   * turns the trust dialog's `│ ❯ 1. Yes` into `❯ 1. Yes` and the dialog starts
   * reading as ready (both halves are pinned in the Issue #1886 tests).
   *
   * Issue #1886: on an untrusted git repository copilot shows the folder-trust
   * dialog before anything else runs, and nothing in that frame matches the
   * composer -- so this loop used to burn its whole 30-second window and then
   * hand `sendMessage` a session still parked on the dialog. Answer it once and
   * keep polling for the composer on the normal cadence; no extra sleep, and the
   * one-shot guard means a frame that somehow still shows the dialog cannot draw
   * a second digit.
   *
   * Issue #1907 tightened "composer visible" from `COPILOT_PROMPT_PATTERN` to
   * {@link isComposerDrawn}, because with the launch path's blind sleep gone the
   * first frame this sees is the shell that has just echoed the launch command.
   * Both halves of the #1886 contract still hold: the boxed dialog has no `❯` at
   * column 0, and a `stripBoxDrawing`ed dialog's `❯ 1. Yes` has dialog text
   * either side of it rather than copilot's rules.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    let trustDialogHandled = false;
    for (let i = 0; i < COPILOT_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Check if copilot's own composer is on screen
        if (this.isComposerDrawn(output)) {
          logger.info('copilot-prompt-detected');
          return;
        }

        if (!trustDialogHandled && (await this.answerFolderTrustDialog(sessionName, output))) {
          trustDialogHandled = true;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, COPILOT_POLL_INTERVAL_MS));
    }
    logger.info('copilot-prompt-detection-timeout');
  }

  /**
   * Wait for Copilot prompt before sending a message.
   * Used by sendMessage to ensure Copilot is ready to accept input.
   *
   * @param sessionName - tmux session name
   * @param timeoutMs - Optional timeout in ms (default: COPILOT_PROMPT_WAIT_TIMEOUT_MS)
   */
  private async waitForPrompt(sessionName: string, timeoutMs: number = COPILOT_PROMPT_WAIT_TIMEOUT_MS): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    let trustDialogHandled = false;
    while (Date.now() - startTime < timeoutMs) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (COPILOT_PROMPT_PATTERN.test(output)) {
          return;
        }
        // Issue #1886: `startSession` returns early for a session that already
        // exists, so a pane adopted from outside CommandMate -- or one whose
        // trust dialog nobody answered -- arrives here still sitting on it.
        // Unlike codex's, this method only logs on timeout and lets the send
        // proceed, which types the message body INTO the dialog; the body's
        // digits are option selections there, so a message containing `2` picks
        // "Yes, and remember this folder" and writes the operator's
        // machine-global ~/.copilot/config.json. Answer it here for the same
        // reason the launch path does, rather than leaving the worse outcome.
        if (!trustDialogHandled && (await this.answerFolderTrustDialog(sessionName, output))) {
          trustDialogHandled = true;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('copilot-prompt-not-detected');
  }

  /**
   * Extract slash command name from a message (e.g., "/model" → "model").
   * Returns null if the message is not a slash command.
   */
  private extractSlashCommand(message: string): string | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;
    const match = trimmed.match(/^\/(\S+)/);
    return match ? match[1] : null;
  }

  /**
   * Wait for the selection list to appear after sending a selection list command.
   * Polls the terminal output for COPILOT_SELECTION_LIST_PATTERN.
   *
   * @returns true if selection list was detected, false if timed out
   */
  private async waitForSelectionList(sessionName: string): Promise<boolean> {
    const maxWaitMs = 5000;
    const pollInterval = 300;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (COPILOT_SELECTION_LIST_PATTERN.test(output)) {
          logger.info('copilot-selection-list-detected');
          return true;
        }
      } catch {
        // Capture may fail - continue polling
      }
    }
    logger.info('copilot-selection-list-not-detected-timeout');
    return false;
  }

  /**
   * Send a message to Copilot interactive session
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
        `Copilot session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Verify Copilot is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Check if this is a slash command that triggers a selection list
      const slashCmd = this.extractSlashCommand(message);
      if (slashCmd && SELECTION_LIST_COMMANDS.has(slashCmd)) {
        // For selection list commands: send text + Enter, then wait for
        // the selection list to appear. Do NOT send additional input after.
        await sendKeys(sessionName, message, true);
        await this.waitForSelectionList(sessionName);
        invalidateCache(sessionName);
        logger.info('sent-selection-list-command-to-copilot', { command: slashCmd });
        return;
      }

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      // Copilot's own text-input / post-Enter delays are preserved. The selection
      // list slash-command branch above is intentionally NOT routed through here.
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'copilot',
        textInputWaitMs: COPILOT_TEXT_INPUT_DELAY_MS,
        verifyDelayMs: COPILOT_SEND_ENTER_DELAY_MS,
      });

      // Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-copilot-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Copilot: ${errorMessage}`);
    }
  }

  /**
   * Send /model command to switch the AI model in Copilot session.
   * Issue #576: Supports --model option for commandmate send.
   *
   * Flow:
   * 1. Verify session exists
   * 2. Send `/model <modelName>` + Enter
   * 3. Wait for selection list to appear
   * 4. If selection list detected, send Enter to confirm
   * 5. Wait for prompt recovery with extended timeout
   *
   * @param worktreeId - Worktree ID
   * @param modelName - Model name to switch to
   */
  async sendModelCommand(worktreeId: string, modelName: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session exists
    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `Copilot session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Send /model <modelName> command with Enter
      await sendKeys(sessionName, `/model ${modelName}`, true);

      // Wait for selection list to appear
      const selectionListDetected = await this.waitForSelectionList(sessionName);

      // If selection list appeared, send Enter to confirm the selection
      if (selectionListDetected) {
        await sendSpecialKey(sessionName, 'C-m');
      }

      // Wait for prompt recovery with extended timeout for model switching
      await this.waitForPrompt(sessionName, COPILOT_MODEL_SWITCH_TIMEOUT_MS);

      // Invalidate cache after model switch
      invalidateCache(sessionName);

      logger.info('copilot-model-switched', { model: modelName });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to switch Copilot model to ${modelName}: ${errorMessage}`);
    }
  }

  /**
   * Kill Copilot session
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

        // Send exit to close gracefully
        await sendKeys(sessionName, 'exit', true);
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-copilot-session');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
