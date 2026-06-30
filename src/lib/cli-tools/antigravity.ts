/**
 * Antigravity CLI tool implementation (Issue #988, Phase A)
 * Provides integration with the Antigravity `agy` CLI (v1.0.14).
 *
 * agy renders an INLINE TUI (scrollback retained, like Codex/Gemini — NOT an
 * alternate-screen app like OpenCode/Copilot). Its layout is:
 *   conversation area (grows downward) | bare "> " input box | status bar
 * The status bar reads "? for shortcuts ... <model>" when idle and
 * "esc to cancel ..." while generating. Patterns confirmed on a real machine.
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
import { detectAndResendIfPastedText } from '../pasted-text-helper';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { stripAnsi } from '../detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_MESSAGE_PROCESSED_WAIT_MS,
  TUI_EXIT_WAIT_MS,
} from '@/config/cli-tool-timing-config';

const logger = createLogger('cli-tools/antigravity');

/**
 * Extract error message from unknown error type (DRY).
 * Same pattern as codex.ts / claude-session.ts getErrorMessage().
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * Idle REPL footer marker. agy shows "? for shortcuts" in the status bar ONLY
 * when the input prompt is live and ready — not during the startup trust dialog
 * (which shows "↑/↓ Navigate · enter Confirm") nor while generating (which shows
 * "esc to cancel"). So this is a reliable "ready" signal. (Confirmed on machine.)
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
 * Decide whether agy is at a genuine, ready input prompt.
 * The idle footer is present AND no trust dialog is awaiting confirmation.
 */
function isAntigravityReady(output: string): boolean {
  return (
    ANTIGRAVITY_READY_FOOTER_PATTERN.test(output) &&
    !ANTIGRAVITY_TRUST_DIALOG_PATTERN.test(output)
  );
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
   */
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Check if agy is installed
    const available = await this.isInstalled();
    if (!available) {
      throw new Error('Antigravity CLI (agy) is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      logger.info('antigravity-session-exists');
      return;
    }

    try {
      // Create tmux session with large history buffer for agy output
      // (agy is inline-rendered and retains scrollback, like Codex)
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
        historyLimit: 50000,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));

      // Start agy in interactive mode
      await sendKeys(sessionName, 'agy', true);

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
   * selection. Polls until the idle footer is detected or max attempts reached.
   */
  private async waitForReady(sessionName: string): Promise<void> {
    // One-shot guard: capturePane keeps the dismissed dialog in scrollback, so
    // Enter must be sent at most once per dialog.
    let trustDialogHandled = false;
    for (let i = 0; i < ANTIGRAVITY_INIT_MAX_ATTEMPTS; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Ready: idle footer present and no trust dialog pending.
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

    try {
      // Verify agy is at a ready prompt before sending
      await this.waitForPrompt(sessionName);

      // Send message text (without Enter)
      await sendKeys(sessionName, message, false);

      // Wait a moment for the text to be typed
      await new Promise((resolve) => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));

      // Send Enter key separately
      await sendSpecialKey(sessionName, 'C-m');

      // Wait a moment for the message to be processed
      await new Promise((resolve) => setTimeout(resolve, TUI_MESSAGE_PROCESSED_WAIT_MS));

      // Detect [Pasted text] and resend Enter for multi-line messages
      if (message.includes('\n')) {
        await detectAndResendIfPastedText(sessionName);
      }

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
