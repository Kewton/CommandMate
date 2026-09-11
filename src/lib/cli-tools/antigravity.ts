/**
 * Antigravity CLI tool implementation (Issue #988, Phase A)
 * Provides integration with the Antigravity `agy` CLI (v1.0.14).
 *
 * agy renders an INLINE TUI (scrollback retained, like Codex/Gemini — NOT an
 * alternate-screen app like OpenCode/Copilot). Its layout is:
 *   conversation area (grows downward) | bare "> " input box | status bar
 * The status bar reads "? for shortcuts ... <model>" when idle and
 * "esc to cancel ..." while generating. Patterns confirmed on a real machine.
 * agy 1.2.1 leaves the idle half of that bar blank after a turn that used a
 * tool (Issue #2478), so readiness is read off the input box — see
 * {@link isAntigravityReady}.
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  sendKeys,
  killSession,
  sendSpecialKey,
  capturePane,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import {
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  ANTIGRAVITY_SEPARATOR_PATTERN,
  detectThinking,
  stripAnsi,
} from '../detection/cli-patterns';
import { normalizeFrame } from '../detection/tools/frame';
import { ANTIGRAVITY_CLI_TOOL_ID } from '@/lib/hooks/sources';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import { createLogger } from '@/lib/logger';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_EXIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { missingToolError } from './install-hints';

const logger = createLogger('cli-tools/antigravity');

/**
 * Extract error message from unknown error type (DRY).
 * Same pattern as codex.ts / claude-session.ts getErrorMessage().
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single-quote a value for safe embedding in a shell command typed into a
 * tmux pane (Issue #989). Unlike other CLI tools, agy's `--model` is a
 * launch-time flag whose value (e.g. "Gemini 3.1 Pro (High)") must be typed
 * into the pane's shell prompt before agy itself starts, so it needs to be
 * quoted the same way a user would quote it at a real terminal.
 * Embedded single quotes are escaped as '\'' (close, escaped quote, reopen).
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wait for agy to initialize after launch (mirrors CODEX_INIT_WAIT_MS). */
const ANTIGRAVITY_INIT_WAIT_MS = 3000;

/** Interval for polling trust dialog / prompt readiness. */
const ANTIGRAVITY_POLL_INTERVAL_MS = 1000;

/** Wait after handling the trust dialog before re-polling. */
const ANTIGRAVITY_DIALOG_SETTLE_MS = 500;

/** Max attempts for initialization polling (30 * 1000ms = 30s window). */
const ANTIGRAVITY_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for the prompt before sending a message. */
const ANTIGRAVITY_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * agy's own word for "idle", drawn on the status row under the input box
 * ("? for shortcuts … <model>"). While generating the same row reads "esc to
 * cancel"; the trust screen and the dialogs draw their own footers instead.
 *
 * Issue #2478: sufficient, no longer required. agy 1.2.1 does not redraw it
 * after a turn that used a tool — the row keeps only the right-aligned model
 * label (`tests/fixtures/antigravity-live-2478/after-tool-turn.txt`) — and a
 * send that waited for it timed out on every later turn of that session.
 */
const ANTIGRAVITY_READY_FOOTER_PATTERN = /\?\s+for\s+shortcuts/;

/**
 * Startup trust dialog marker (Issue #988). On first access to an untrusted
 * folder agy shows:
 *   Do you trust the contents of this project?
 *   > Yes, I trust this folder   <- default-selected option
 *     No, exit
 *   ↑/↓ Navigate · enter Confirm
 * "Yes, I trust this folder" is the default selection, so a single Enter confirms
 * it. (Confirmed on machine.)
 */
const ANTIGRAVITY_TRUST_DIALOG_PATTERN = /Do you trust the contents of this project\?/;

/**
 * Read agy's input box off the bottom of a frame (Issue #2478).
 *
 * agy draws the box — a bare `>` between two rules, its status row under the
 * lower one — as the last thing on the screen, and everything else it can show
 * either replaces the box (the permission dialogs, the trust screen, the
 * post-answer survey) or is drawn below it (the `/model` picker, the slash
 * command popup, `/feedback`'s category menu). So a frame that ENDS in the box
 * is one whose input box is live, and a `>` row with more than the status row
 * under it is not a box anyone can type into.
 *
 * This is stricter than the status detector's `promptPattern.test(lastLines)`
 * (`detection/tools/antigravity/detect.ts`), which accepts the `>` anywhere in
 * the 15-row tail: the detector tells `/feedback`'s menu apart only in the
 * shared generic prompt step that runs before it, and this check does not run
 * that step. The rows between the `>` and the lower rule may be blank — agy
 * 1.2.1 leaves the box three rows tall after a tool turn.
 *
 * @param contentLines - ANSI-stripped rows, trailing blank rows dropped
 * @returns The status row under the box ('' when agy drew none), or null when
 *   the frame does not end in the box
 */
function readInputBoxStatusRow(contentLines: readonly string[]): string | null {
  const rows = contentLines.map((row) => row.trim());
  const isRule = (i: number): boolean => i >= 0 && ANTIGRAVITY_SEPARATOR_PATTERN.test(rows[i]);
  const skipBlank = (from: number): number => {
    let i = from;
    while (i >= 0 && rows[i] === '') i--;
    return i;
  };

  let i = rows.length - 1;
  let statusRow = '';
  if (i >= 0 && !isRule(i)) {
    statusRow = rows[i];
    i = skipBlank(i - 1);
  }
  if (!isRule(i)) return null;
  i = skipBlank(i - 1);
  if (i < 0 || !ANTIGRAVITY_PROMPT_PATTERN.test(rows[i])) return null;
  return isRule(skipBlank(i - 1)) ? statusRow : null;
}

/**
 * Decide whether a typed message would land in agy's input box (Issue #2478).
 *
 * Read on the status detector's evidence (`detection/tools/antigravity/detect.ts`)
 * over the status detector's frame (`normalizeFrame`: ANSI stripped, padding
 * dropped, the same 15-row tail):
 *
 *  1. No agy screen is up: the `Switch Model` / `↑/↓ Navigate` test its
 *     `beforePrompt` makes (every branch after that test answers `waiting` or
 *     `running`, so it covers the numbered dialogs too), and the trust
 *     question. Both over the tail — with the pane 1000 rows tall the whole
 *     transcript is in the capture, and a quoted question anywhere in it used
 *     to block every send.
 *  2. The frame ends in the input box ({@link readInputBoxStatusRow}).
 *  3. agy is not generating. `? for shortcuts` on the status row settles it —
 *     kept as a sufficient signal so a thought summary such as "Generating the
 *     specified file" left in the tail cannot block a send the pre-#2478 rule
 *     allowed. Without it, `afterThinking`'s reading: no spinner, `Generating`
 *     or `esc to cancel` in the tail. The box stays on screen while agy
 *     generates, so 2 alone would not do.
 *
 * Before #2478 the footer was required and the detector never read it, so the
 * two disagreed on every frame agy 1.2.1 draws after a tool turn.
 *
 * @param output - A captured pane, raw or ANSI-stripped
 * @returns True when the input box is live and agy is idle
 */
export function isAntigravityReady(output: string): boolean {
  const frame = normalizeFrame(output);
  if (ANTIGRAVITY_SELECTION_LIST_PATTERN.test(frame.lastLines)) return false;
  if (ANTIGRAVITY_TRUST_DIALOG_PATTERN.test(frame.lastLines)) return false;

  const statusRow = readInputBoxStatusRow(frame.contentLines);
  if (statusRow === null) return false;
  if (ANTIGRAVITY_READY_FOOTER_PATTERN.test(statusRow)) return true;
  return !detectThinking('antigravity', frame.lastLines);
}

/**
 * Antigravity CLI tool implementation.
 * Manages `agy` sessions using tmux.
 */
export class AntigravityTool extends BaseCLITool {
  readonly id: CLIToolType = 'antigravity';
  readonly name = 'Antigravity CLI';
  readonly command = 'agy';

  /**
   * Check if an Antigravity session is running for a worktree.
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Antigravity session for a worktree.
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   * @param model - Issue #989: Model to launch with (`agy --model <model>`).
   *   agy has no in-session model-switch command, so this only takes effect
   *   when starting a brand-new session; the caller must not pass a model
   *   for a session that is already running.
   */
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string, model?: string): Promise<void> {
    // Check if agy is installed
    const available = await this.isInstalled();
    if (!available) {
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
        logger.info('antigravity-session-exists');
        return;
      }
      logger.warn('antigravity-session-relaunch', { sessionName });
    }

    // Issue #1762: fence this instance's structured events off from the process
    // that used to hold the same (worktree, tool, instance) key. Creation path
    // only — the reuse branch above has already returned — and before the pane
    // exists. Bumped even if the launch below then fails.
    //
    // Issue #2070: reached on the RELAUNCH path too — the pane is the same one,
    // but the process is not, and the dead process's events must not be read as
    // the new one's.
    beginAgentSession({ worktreeId, cliToolId: ANTIGRAVITY_CLI_TOOL_ID, instanceId });

    try {
      // Issue #2070: creation only. On the relaunch path the pane already
      // exists and holds the transcript of the process that died in it; the
      // launch command is re-sent into that same pane.
      if (!exists) {
        // Create tmux session with large history buffer for agy output
        // (agy is inline-rendered and retains scrollback, like Codex)
        // Scrollback depth comes from the shared TMUX_HISTORY_LIMIT default
        // (Issue #1624) — do not re-hardcode it here.
        await createSession({
          sessionName,
          workingDirectory: worktreePath,
        });

        // Wait a moment for the session to be created
        await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));
      }

      // Start agy in interactive mode, optionally pinned to a model.
      //
      // Issue #1762: the launch merges CommandMate's named hook into
      // `~/.gemini/config/hooks.json` — agy's single global config, shared with
      // gemini's tree and with whatever the user has in it — and prefixes
      // `CM_HOOK_URL`. That variable is the *only* correlation channel agy has:
      // its payloads carry no `cwd`, its hooks run in `~/.gemini/config`, and
      // one file serves every worktree on the machine. `--model` is appended
      // after the rendered line, so the env assignments stay in front of the
      // command. `CM_AGENT_HOOKS_INJECT=0` returns bare `agy`, unchanged.
      const base = buildAgentLaunchCommandLine({
        target: { worktreeId, cliToolId: ANTIGRAVITY_CLI_TOOL_ID, instanceId },
        executablePath: this.command,
        worktreePath,
      });
      const launchCommand = model ? `${base} --model ${shellSingleQuote(model)}` : base;
      await sendKeys(sessionName, launchCommand, true);

      // Wait for agy to initialize
      await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_INIT_WAIT_MS));

      // Poll until the interactive prompt is ready (handles the trust dialog)
      await this.waitForReady(sessionName);

      logger.info('started-antigravity-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Antigravity session: ${errorMessage}`);
    }
  }

  /**
   * Wait for agy to become ready (input prompt live).
   * Handles the first-run trust dialog ("Do you trust the contents of this
   * project?") by sending Enter to confirm the default "Yes, I trust this folder"
   * selection. Polls until {@link isAntigravityReady} or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    // One-shot guard: capturePane keeps the dismissed dialog in scrollback, so
    // Enter must be sent at most once per dialog.
    let trustDialogHandled = false;
    for (let i = 0; i < ANTIGRAVITY_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Ready: the input box is live and no agy screen covers it.
        if (isAntigravityReady(output)) {
          logger.info('antigravity-prompt-detected');
          return;
        }

        // Trust dialog: confirm the default "Yes, I trust this folder" with Enter.
        if (!trustDialogHandled && ANTIGRAVITY_TRUST_DIALOG_PATTERN.test(output)) {
          await sendSpecialKey(sessionName, 'Enter');
          trustDialogHandled = true;
          logger.info('auto-trusted-folder-for-antigravity');
          await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_DIALOG_SETTLE_MS));
          continue;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_POLL_INTERVAL_MS));
    }
    logger.info('antigravity-prompt-detection-timeout');
  }

  /**
   * Wait for agy's prompt before sending a message.
   * Mirrors CodexTool.waitForPrompt: throws on timeout so a failed readiness
   * check STOPS the send rather than typing into a non-ready TUI.
   *
   * @throws Error when the input prompt is not detected within the timeout
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < ANTIGRAVITY_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        if (isAntigravityReady(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('antigravity-prompt-not-ready');
    throw new Error(
      'Antigravity prompt not ready: timed out waiting for the input prompt before sending'
    );
  }

  /**
   * Send a message to the Antigravity session.
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
        `Antigravity session ${sessionName} does not exist. Start the session first.`
      );
    }

    // Issue #2070: the pane exists, but does the AGENT? An agent that quit,
    // updated itself or crashed leaves its tmux session behind, and the send
    // that followed used to sit in the readiness wait until it timed out —
    // leaving `kill-session` by hand as the only recovery. Relaunches into the
    // same pane when the tool is gone; costs one `capture-pane` when it is not.
    await this.relaunchIfToolExited(worktreeId, instanceId);

    try {
      // Verify agy is at a ready prompt before sending
      await this.waitForPrompt(sessionName);

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'antigravity',
        composer: this.describeComposer(),
      });

      // Invalidate cache after sending message (required so the poller re-reads)
      invalidateCache(sessionName);

      logger.info('sent-message-to-antigravity-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Antigravity: ${errorMessage}`);
    }
  }

  /**
   * Kill the Antigravity session.
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    try {
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+D to exit agy gracefully
        await sendSpecialKey(sessionName, 'C-d');

        // Wait a moment for agy to exit
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      // Invalidate cache so a later session reusing the name starts clean
      invalidateCache(sessionName);

      if (killed) {
        logger.info('stopped-antigravity-session');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
