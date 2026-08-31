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
  sendSpecialKeys,
  killSession,
  capturePane,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import {
  COPILOT_PROMPT_PATTERN,
  isCopilotSelectionFrame,
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
import { TUI_SESSION_CREATE_WAIT_MS, TUI_INTERRUPT_SETTLE_MS, COPILOT_EXIT_WAIT_MS } from '@/config/cli-tool-timing-config';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import { COPILOT_LAUNCH_COMMAND } from '@/lib/hooks/sources/copilot/hook-settings';
import { COPILOT_CLI_TOOL_ID } from '@/lib/hooks/sources/copilot/tool-id';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { SessionStartUnavailableError } from '../session/session-start-error';

const logger = createLogger('cli-tools/copilot');

/** Interval for polling prompt detection */
const COPILOT_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const COPILOT_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const COPILOT_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Copilot CLI slash commands that open a picker.
 *
 * Sending one is not like sending a message: the picker takes the composer
 * away, so anything typed afterwards lands in the picker's own search field and
 * any stray Enter/`n`/`x` is a keystroke the picker acts on. (Measured while
 * capturing the frames for Issue #1895: text sent into an open `/session`
 * picker created a session. `/session` is also the one picker `esc` does not
 * close.) That is why this branch sends the command, waits for positive
 * evidence that the picker is up, and then stops.
 *
 * All eleven commands #1913 measured on 1.0.80 are listed. The set was
 * `model`/`agent`/`theme`, and the note left in its place said to widen it "once
 * the pattern actually matches 1.0.80 frames" -- which is what Issue #1895 did:
 * {@link isCopilotSelectionFrame} matches all eleven of the live frames in
 * `tests/unit/lib/detection/fixtures/copilot-picker-1895/`, so the wait now
 * returns on evidence in ~300ms instead of expiring at 5s. Widening was cheap
 * only because of that; each entry still buys a wait, so this stays the eleven
 * that were opened and captured rather than a guess about the rest of the
 * catalogue.
 *
 * Issue #1906 is what made any of it live. Until then `send-user-message.ts` and
 * the terminal route both bypassed this method with a raw `sendKeys` + delayed
 * Enter, so this branch — and `waitForPrompt`'s folder-trust answer (#1886) —
 * were unreachable in production. Both bypasses are gone; every path that types
 * a message at copilot comes through here.
 */
const SELECTION_LIST_COMMANDS = new Set([
  'model',
  'agent',
  'theme',
  'permissions',
  'skills',
  'mcp',
  'settings',
  'statusline',
  'subagents',
  'resume',
  'session',
]);

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
 * The TUI command that ends a Copilot session (Issue #1905).
 *
 * Copilot 1.0.80 accepts several spellings — `/exit`, `Ctrl+C` twice and
 * `Ctrl+D` all end the process, and a bare `exit` submitted from the composer
 * does too (measured; the Issue's premise that it merely becomes a chat message
 * is wrong for this version). The slash form is the documented one and the only
 * one that cannot be mistaken for a prompt, so it is what is sent.
 */
export const COPILOT_EXIT_COMMAND = '/exit';

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
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Issue #1907: resolved once, and the same resolution decides both whether to
    // start at all and what to type. Asking `isInstalled()` and then launching a
    // hardcoded command is how `gh copilot` came to be sent to machines that had
    // no copilot: the answer and the action have to come from one measurement.
    const resolved = await resolveCopilotExecutable();
    if (!resolved) {
      throw new SessionStartUnavailableError(this.name, `GitHub Copilot CLI is not installed. ${COPILOT_INSTALL_HINT}`);
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
        logger.info('copilot-session-exists');
        return;
      }
      logger.warn('copilot-session-relaunch', { sessionName });
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
    //
    // Issue #2070: reached on the RELAUNCH path too — the pane is the same one,
    // but the process is not, and the dead process's events must not be read as
    // the new one's.
    beginAgentSession({ worktreeId, cliToolId: COPILOT_CLI_TOOL_ID, instanceId });

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
   * Issue #1906 is the first change that lets a GUI/CLI send reach this wait, so
   * what it actually costs was measured (copilot 1.0.80, private tmux socket,
   * `tmux -L`):
   *
   * - **Composer on screen — idle or mid-response: ~0 ms.** copilot keeps drawing
   *   `❯` at column 0 while it is Working, the loop captures BEFORE its first
   *   sleep, and `COPILOT_PROMPT_PATTERN` matches immediately. A whole
   *   `sendMessage` measured 338 ms end to end, verification included.
   * - **Composer gone — a dialog is up: the full 15 s, then it sends anyway.**
   *   Measured against a session parked on copilot's own `Asked user …` question:
   *   the window expired and the body was typed into the QUESTION's input line,
   *   which is single-line, so a four-line message arrived as
   *   `ping oneping twoping three…`.
   *
   * That second case is #559's objection, and it is real — but it is not a
   * reason to skip this method, because skipping it is what produced the same
   * outcome in 0 ms instead of 15 s. What keeps it out of production is the layer
   * above: `sendUserMessage` and the terminal route both consult
   * `isPromptWaiting` (#1708/#1737) and refuse before reaching here.
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
   * Polls the terminal output for {@link isCopilotSelectionFrame}.
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
        // 50 rows is bottom-anchored (`-S -50 -E -`), which is the half of the
        // pane `isCopilotSelectionFrame` reads. Issue #1895.
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (isCopilotSelectionFrame(output.split('\n'))) {
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

    // Issue #2070: the pane exists, but does the AGENT? An agent that quit,
    // updated itself or crashed leaves its tmux session behind, and the send
    // that followed used to sit in the readiness wait until it timed out —
    // leaving `kill-session` by hand as the only recovery. Relaunches into the
    // same pane when the tool is gone; costs one `capture-pane` when it is not.
    await this.relaunchIfToolExited(worktreeId, instanceId);

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
        composer: this.describeComposer(),
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
   * 3. Wait for prompt recovery with extended timeout
   *
   * Steps 3 and 4 of the original flow -- wait up to 5s for the picker, then
   * send Enter if it appeared -- are gone (Issue #1895). `/model` opens a picker
   * only when it is given NO argument; with one it switches in place and prints
   * `● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this
   * session.` (measured on 1.0.80: the status bar carries the new model within
   * ~300ms and the composer is back). An unknown id prints the list of valid
   * ids and changes nothing -- also no picker. So the wait could only ever
   * expire, and the `C-m` it guarded was a bare Enter aimed at whatever was on
   * screen 5 seconds after a switch that had already finished.
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
      // Send /model <modelName> command with Enter. An argument means an
      // in-place switch, never a picker (Issue #1895).
      await sendKeys(sessionName, `/model ${modelName}`, true);

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
   * Issue #1905 is the first change to reach this method from the GUI / CLI at
   * all: `POST /api/worktrees/:id/kill-session` used to call `lib/tmux`'s
   * `killSession` directly, and the only other caller (the Assistant session
   * route) does not allow copilot. Two things were wrong here as a result.
   *
   * 1. The body and Enter were batched into one `send-keys <body> C-m`. The
   *    repository moved off that shape for message sends in #1471 because ink
   *    TUIs swallow the trailing `C-m` as part of a bracketed paste; the exit
   *    command is the same keystroke sequence and had been left behind.
   * 2. `TUI_EXIT_WAIT_MS` (500 ms) was shorter than the shutdown takes on
   *    copilot 1.0.80 — 11 measured samples ran 1.006 s to 2.193 s — so the
   *    tmux kill always landed mid-shutdown. See {@link COPILOT_EXIT_WAIT_MS}.
   *
   * The `Ctrl+C` first is kept: it interrupts an in-flight generation so the
   * composer is accepting input by the time the command is typed. tmux kill
   * still runs unconditionally afterwards, as the fallback.
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Optional agent instance ID (defaults to primary)
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    try {
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+C to interrupt any running operation
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, TUI_INTERRUPT_SETTLE_MS));

        // Type the exit command, then submit it as a separate tmux command.
        await sendKeys(sessionName, COPILOT_EXIT_COMMAND, false);
        await new Promise((resolve) => setTimeout(resolve, COPILOT_TEXT_INPUT_DELAY_MS));
        await sendSpecialKeys(sessionName, ['Enter']);

        await new Promise((resolve) => setTimeout(resolve, COPILOT_EXIT_WAIT_MS));
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
