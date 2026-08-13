/**
 * Codex CLI tool implementation
 * Provides integration with OpenAI's Codex CLI
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
import { isCodexPromptReady, getCodexActiveDialog, stripAnsi } from '../detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources';
import {
  beginAgentSession,
  prepareAgentLaunch,
} from '@/lib/session/agent-session-lifecycle';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  CODEX_DIALOG_SETTLE_MS,
} from '@/config/cli-tool-timing-config';

const logger = createLogger('cli-tools/codex');

/**
 * Extract error message from unknown error type (DRY)
 * Same pattern as claude-session.ts getErrorMessage()
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for Codex CLI to initialize after launch */
const CODEX_INIT_WAIT_MS = 3000;

/** Interval for polling trust dialog / prompt detection */
const CODEX_POLL_INTERVAL_MS = 1000;

/** Max attempts for initialization polling (30 * 1000ms = 30s total window) */
const CODEX_INIT_MAX_ATTEMPTS = 30;

/** Timeout for waiting for prompt before sending a message */
const CODEX_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Anchors of codex's "Hooks need review" dialog (Issue #1760, measured on
 * codex-cli 0.147.0):
 *
 * ```
 *  Hooks need review
 *  5 hooks are new or changed.
 *  Hooks can run outside the sandbox after you trust them.
 *
 * > 1. Review hooks
 *   2. Trust all and continue
 *   3. Continue without trusting (hooks won't run)
 * ```
 *
 * It has to be handled here rather than in `getCodexActiveDialog`, which
 * classifies it as `null`: its wording matches none of that function's three
 * anchors (`Skip until next version` / `Do you trust` / `Press enter to
 * continue`). Measured consequence of leaving it alone, on a pane with the
 * generated `hooks.json` present: `isCodexPromptReady` stays false for the full
 * 30-attempt window and the session is then handed to `sendMessage` still
 * sitting on the dialog. Every launch, because "continue without trusting" is
 * not remembered — verified by relaunching and getting the same screen.
 *
 * Both strings are required so a "hooks" mention elsewhere cannot select an
 * option on a live prompt.
 */
const CODEX_HOOKS_REVIEW_ANCHORS = ['Hooks need review', 'Continue without trusting'] as const;

/**
 * Option 3, "Continue without trusting (hooks won't run)".
 *
 * Not option 2. Trusting writes `[hooks.state."<file>:<event>:0:0"]` entries
 * into the operator's own `~/.codex/config.toml` — the file that carries, among
 * other things, the `notify` command a Computer Use integration runs — and
 * granting that on someone's behalf is not this server's call. So a session
 * starts with the hooks inert and the screen scraper doing exactly what it did
 * before Issue #1760; the human enables them once through codex's own review
 * screen, or an operator sets `CM_CODEX_HOOK_TRUST=bypass`.
 *
 * Sent alone, like the other numbered dialogs (Issue #890): codex confirms a
 * numbered selection instantly, and a trailing Enter would land on the next
 * screen. Verified live — the prompt was ready on the following poll.
 */
const CODEX_HOOKS_REVIEW_DECLINE_KEY = '3';

/**
 * Whether the pane is sitting on the hooks review dialog.
 *
 * Position-independent on purpose, unlike `getCodexActiveDialog`: the only
 * caller checks `isCodexPromptReady` first and returns when a genuine prompt
 * exists, so residual dialog text above a live prompt is never reached, and a
 * one-shot guard stops the key being sent twice.
 *
 * @param output - ANSI-stripped pane capture
 * @returns True when both anchors of the dialog are present
 */
export function isCodexHooksReviewDialog(output: string): boolean {
  return CODEX_HOOKS_REVIEW_ANCHORS.every((anchor) => output.includes(anchor));
}

/**
 * Codex CLI tool implementation
 * Manages Codex sessions using tmux
 */
export class CodexTool extends BaseCLITool {
  readonly id: CLIToolType = 'codex';
  readonly name = 'Codex CLI';
  readonly command = 'codex';

  /**
   * Check if Codex session is running for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns True if session is running
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new Codex session for a worktree
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Check if Codex is installed
    const codexAvailable = await this.isInstalled();
    if (!codexAvailable) {
      throw new Error('Codex CLI is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName);
      logger.info('codex-session-sessionname');
      return;
    }

    // Issue #1760: everything the previous codex process reported through this
    // (worktreeId, instanceId) belongs to a session that no longer exists, and
    // the key is reused verbatim by the one about to be created. Without this
    // fence the old process's last `user_prompt_submit` reads as the new one's
    // and a brand-new session publishes `running` before anyone has typed into
    // it (#1723).
    //
    // Creation path only — the reuse branch above has already returned — and
    // before `createSession`, so no live pane is ever matched against a stale
    // generation. Bumped even when the launch then fails: falling back to the
    // scraper is always safe, trusting a dead session's events is not.
    beginAgentSession({ worktreeId, cliToolId: CODEX_CLI_TOOL_ID, instanceId });

    try {
      // Create tmux session. Codex is inline-rendered, so its transcript lives in
      // the pane scrollback — depth comes from the shared TMUX_HISTORY_LIMIT
      // default (Issue #1624), do not re-hardcode it here.
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));

      // Issue #1760: hand this session its correlation keys, writing codex's
      // hooks config first if it is not already there. codex has no
      // `--settings`, so the keys ride in environment assignments on the launch
      // line and the hook commands read them back — which is what tells `codex`
      // from `codex-2` in one worktree, since `cwd` is identical for both.
      //
      // Falls back to the bare command on any failure and when
      // `CM_AGENT_HOOKS_INJECT=0`; a session that starts without hooks is the
      // pre-#1760 status quo, and a session that fails to start is not.
      const launchCommand = prepareAgentLaunch(
        { worktreeId, cliToolId: CODEX_CLI_TOOL_ID, instanceId },
        this.command
      ).command;

      // Start Codex CLI in interactive mode
      await sendKeys(sessionName, launchCommand, true);

      // Wait for Codex to initialize
      await new Promise((resolve) => setTimeout(resolve, CODEX_INIT_WAIT_MS));

      // Poll until Codex interactive prompt is ready
      // Handles trust dialog and update notification automatically
      await this.waitForReady(sessionName);

      logger.info('started-codex-session:sessionname');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Codex session: ${errorMessage}`);
    }
  }

  /**
   * Wait for Codex CLI to become ready (prompt visible).
   * Handles trust dialog ("Do you trust the contents of this directory?")
   * and update notification automatically by sending Enter/number keys.
   * Polls until a genuine interactive prompt is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    // Issue #892: one-shot guards. capturePane(50) keeps a dismissed dialog in
    // scrollback, so a key must be sent at most once per dialog -- otherwise the
    // update branch re-sends "2" every poll and the live prompt gets "222...".
    let updateDialogHandled = false;
    let trustDialogHandled = false;
    let hooksReviewHandled = false;
    for (let i = 0; i < CODEX_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Check if the genuine interactive input prompt is ready.
        // Issue #892: isCodexPromptReady() is position-based -- a genuine "› " line
        // below stale dialog scrollback IS ready, while an active dialog (option
        // line "› 1." as the bottom element) is not.
        if (isCodexPromptReady(output)) {
          logger.info('codex-prompt-detected');
          return;
        }

        // Issue #1760: "Hooks need review". Reached only when no genuine prompt
        // exists (the check above returned), so this cannot fire on a live
        // prompt, and the one-shot guard stops a second key on a re-render.
        // Declines: granting trust would write the operator's config.toml.
        if (!hooksReviewHandled && isCodexHooksReviewDialog(output)) {
          await sendKeys(sessionName, CODEX_HOOKS_REVIEW_DECLINE_KEY, false);
          hooksReviewHandled = true;
          logger.info('codex-hooks-review-declined');
          await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
          continue;
        }

        // Issue #892: classify the bottom-most ACTIVE dialog by position. A dialog
        // whose text is only residual scrollback above a genuine prompt returns
        // null here, so no stray key is sent after it has been dismissed.
        const activeDialog = getCodexActiveDialog(output);

        // Handle update notification BEFORE trust dialog check.
        // Update notification shows: › 1. Update now / 2. Skip / 3. Skip until next version
        // followed by "Press enter to continue". Must send "2" (Skip) to avoid
        // triggering npm install which kills the Codex process.
        if (activeDialog === 'update' && !updateDialogHandled) {
          // Issue #890: Codex confirms a numbered selection instantly (no Enter).
          // Appending Enter (sendEnter=true) would land on the NEXT screen as a
          // stray keypress -- an empty submit on the main prompt, or worst case the
          // default "1. Update now" confirm if "2" was dropped during a re-render.
          // Send "2" alone and let the next poll observe the result.
          await sendKeys(sessionName, '2', false);
          updateDialogHandled = true;
          logger.info('skipped-codex-update');
          await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
          continue;
        }

        // Handle "Press enter to continue" (genuine press-enter screens only).
        // Numbered selection dialogs are dismissed by the number key above, so this
        // branch is reached only when no number selection is pending.
        if (activeDialog === 'press-enter') {
          await sendSpecialKey(sessionName, 'Enter');
          logger.info('dismissed-codex-notification');
          await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
          continue;
        }

        // Handle trust dialog: "Do you trust the contents of this directory?"
        // Options: › 1. Yes, continue / 2. No, quit
        if (activeDialog === 'trust' && !trustDialogHandled) {
          // Issue #890: number-key selection confirms instantly; no trailing Enter.
          await sendKeys(sessionName, '1', false);
          trustDialogHandled = true;
          logger.info('auto-trusted-folder-for');
          await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
          continue;
        }
      } catch {
        // Capture may fail during initialization - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, CODEX_POLL_INTERVAL_MS));
    }
    logger.info('codex-prompt-detection');
  }

  /**
   * Wait for Codex prompt before sending a message.
   * Used by sendMessage to ensure Codex is ready to accept input.
   *
   * Issue #892: throws on timeout instead of falling through. The previous version
   * only logged and returned, so sendMessage typed the message regardless of
   * readiness -- the exact path that let "222..." (or an empty submit) reach the
   * session when detection failed. A failed readiness check must STOP the send.
   *
   * @throws Error when the genuine input prompt is not detected within the timeout
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;
    while (Date.now() - startTime < CODEX_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);
        // Issue #890/#892: position-based guard so a residual update/trust dialog
        // ("› 1. ...") is never mistaken for a ready prompt -- yet a genuine "› "
        // prompt below stale dialog scrollback IS accepted.
        if (isCodexPromptReady(output)) {
          return;
        }
      } catch {
        // Capture may fail - continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger.info('codex-prompt-not');
    throw new Error(
      'Codex prompt not ready: timed out waiting for the input prompt before sending'
    );
  }

  /**
   * Send a message to Codex session
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
        `Codex session ${sessionName} does not exist. Start the session first.`
      );
    }

    try {
      // Verify Codex is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'codex',
      });

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-codex-session:sessionnam');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to Codex: ${errorMessage}`);
    }
  }

  /**
   * Kill Codex session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    try {
      // Send Ctrl+D to exit Codex gracefully
      const exists = await hasSession(sessionName);
      if (exists) {
        // Send Ctrl+D (ASCII 4)
        await sendSpecialKey(sessionName, 'C-d');

        // Wait a moment for Codex to exit
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      }

      // Kill the tmux session
      const killed = await killSession(sessionName);

      if (killed) {
        logger.info('stopped-codex-session:sessionname');
      }
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }
}
