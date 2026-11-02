/**
 * Vibe Local CLI tool implementation
 * Provides integration with vibe-local (vibe-coder) in interactive mode
 *
 * @remarks Issue #368: Rewritten from non-interactive pipe mode to interactive REPL mode.
 * Previous implementation used `echo 'msg' | vibe-local` which caused the process to exit
 * immediately with "(Cancelled)" + "Goodbye!", making response polling impossible.
 * Now launches `vibe-local -y` in interactive mode within tmux (same approach as Claude/Codex/Gemini).
 */

import { BaseCLITool } from './base';
import { OLLAMA_MODEL_PATTERN, isValidVibeLocalContextWindow, type CLIToolType } from './types';
import {
  capturePane,
  sendSpecialKey,
} from '../tmux/tmux';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { isVibeLocalComposerReady } from '../detection/tools/vibe-local/readiness';
import { detectSessionStatus, isGeneratingStatus } from '../detection/status-detector';
import {
  confirmedDialogRefusal,
  createDialogConfirmation,
  readBeforeDeadline,
} from './prompt-wait-dialog';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { getDbInstance } from '../db/db-instance';
import { getWorktreeById } from '../db';
import { createLogger } from '@/lib/logger';
import {
  TUI_INTERRUPT_SETTLE_MS,
  TUI_EXIT_WAIT_MS,
  VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import { withLaunchScreenCleared } from '@/lib/session/launch-screen';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('cli-tools/vibe-local');

/**
 * Wait for vibe-local to initialize after launch.
 * vibe-local shows a permission check prompt, banner, and model loading.
 */
const VIBE_LOCAL_INIT_WAIT_MS = 5000;

/**
 * How long a send waits for vibe-local's input prompt (Issue #4040).
 *
 * Measured on vibe-local 1.3.3 (`vibe-local -y`, isolated `HOME`, private tmux
 * socket, model `qwen3-coder:30b` not loaded in Ollama before each run): the
 * empty `ctx:N% ❯` row was up 1.15 s, 0.62 s and 0.60 s after the launch
 * keystroke — vibe-local loads the model on the first message, not at launch.
 * gemini's and codex's 15 s therefore covers it with room to spare.
 */
const VIBE_LOCAL_PROMPT_WAIT_TIMEOUT_MS = 15000;

/** Interval between the send's readiness polls (Issue #4040). */
const VIBE_LOCAL_PROMPT_POLL_INTERVAL_MS = 500;

/** Scrollback rows plus the visible pane in a readiness capture (`-S -200 -E -`). */
const VIBE_LOCAL_PROMPT_CAPTURE_LINES = 200;

/**
 * Whether {@link VibeLocalTool}'s prompt wait counts this frame towards giving
 * up on a dialog (Issue #4084): the detector reports an active prompt — what
 * the re-check under the input lock refuses — and no turn is being generated.
 * Unlike copilot's wait, there is no folder-trust dialog here to leave out:
 * this wait answers none.
 */
function isVibeLocalWaitDialog(output: string): boolean {
  const status = detectSessionStatus(output, 'vibe-local');
  return status.hasActivePrompt && !isGeneratingStatus(status);
}

/**
 * Vibe Local CLI tool implementation
 * Manages vibe-local interactive sessions using tmux
 */
export class VibeLocalTool extends BaseCLITool {
  readonly id: CLIToolType = 'vibe-local';
  readonly name = 'Vibe Local';
  readonly command = 'vibe-local';

  /**
   * Start a new vibe-local session for a worktree
   * Launches `vibe-local -y` in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    await this.requireInstalled();

    const { sessionName, exists, live } = await this.resolveLaunchPane(worktreeId, worktreePath, instanceId, {
      logger,
      liveAction: 'vibe-local-session-exists',
      relaunchAction: 'vibe-local-session-relaunch',
    });
    if (live) return;

    // Issue #1759 / #2444: the one line every tool's creation path owes the
    // rest of the system. vibe-local emits no structured events, so the
    // generation fence itself is inert here — but `beginAgentSession` is also
    // where a superseded session's chat rows are retired, and vibe-local was
    // the only tool that never called it. Placed after the healthy-reuse
    // `return` above and before the pane is touched, exactly as codex places
    // its call: a reuse is the same process and must archive nothing, a
    // relaunch into this same pane is a new one and must.
    beginAgentSession({ worktreeId, cliToolId: this.id, instanceId });

    try {
      // Issue #2070: creation only. On the relaunch path the pane already
      // exists and holds the transcript of the process that died in it; the
      // launch command is re-sent into that same pane.
      if (!exists) {
        await this.createLaunchPane(sessionName, worktreePath);
      }

      // Read Ollama model and context window preferences from DB
      // [SEC-001] Re-validate model name at point of use (defense-in-depth)
      // [S1-005] DB direct access follows existing vibeLocalModel pattern;
      // future DIP refactoring should pass these as startSession() arguments.
      let vibeLocalCommand = 'vibe-local -y';
      try {
        const db = getDbInstance();
        const wt = getWorktreeById(db, worktreeId);
        if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
          vibeLocalCommand += ` -m ${wt.vibeLocalModel}`;
        }
        // [C2-008] contextWindow from the same wt object (no additional DB call)
        const ctxWindow = wt?.vibeLocalContextWindow;
        // [SEC-002] Defense-in-depth: re-validate at point of use
        // [S4-001] Number() cast for additional safety in template literal
        if (isValidVibeLocalContextWindow(ctxWindow)) {
          vibeLocalCommand += ` --context-window ${Number(ctxWindow)}`;
        }
      } catch {
        // DB read failure is non-fatal; use defaults
      }

      // Start vibe-local in interactive mode with auto-approve (-y)
      // -y flag skips the permission confirmation prompt
      // Issue #3981: in one writer's turn of the input lock.
      await this.typeLaunchLines(sessionName, [withLaunchScreenCleared(vibeLocalCommand)]);

      // Wait for vibe-local to initialize (banner + model loading)
      await new Promise((resolve) => setTimeout(resolve, VIBE_LOCAL_INIT_WAIT_MS));

      logger.info('started-vibe-local-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start Vibe Local session: ${errorMessage}`);
    }
  }

  /**
   * Send a message to vibe-local interactive session
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
    await this.requireSession('Vibe Local', worktreeId, instanceId, { relaunch: true });

    try {
      // Issue #4040: nothing is typed (the two Enters included) until the
      // newest prompt row is up and empty — a relaunch or a fresh launch is
      // still drawing its banner when the first send arrives.
      await this.waitForPrompt(sessionName);

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper. vibe-local's IME mode needs TWO Enter presses (first Enter
      // inserts a newline, the second submits), preserved via submitEnterCount: 2
      // + the same inter-press wait (VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'vibe-local',
        // Issue #1933: the double Enter is `ComposerSpec.submitEnterCount`, so
        // the IME quirk is declared once on the tool rather than re-passed by
        // the one call site that knew about it.
        composer: this.describeComposer(),
        interEnterWaitMs: VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS,
        // Issue #4040: the same test, of the newest frame read under the input lock.
        readiness: { label: 'Vibe Local', isReady: isVibeLocalComposerReady },
      });

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-vibe-local-session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      // Issue #4031: the cause keeps a failed `load-buffer`'s code (`classifySendFailure`).
      throw new Error(`Failed to send message to Vibe Local: ${errorMessage}`, { cause: error });
    }
  }

  /**
   * Wait for vibe-local's input prompt before a send (Issue #4040).
   *
   * {@link isVibeLocalComposerReady} is the test — the newest `ctx:N% ❯` row
   * empty with only the footer below it (or a turn being generated under it),
   * never "the row is somewhere on the pane": the scrollback keeps every old
   * one.
   *
   * Issue #4084: a dialog (`hasActivePrompt`, not while a turn is being
   * generated) ends the wait only once it is confirmed — seen on 2 reads in a
   * row spanning `PROMPT_WAIT_DIALOG_CONFIRM_MS` (2 s), the count copilot's
   * wait uses (#4067) — and is then refused as `prompt-waiting` at once, on the
   * wait's own reads. A dialog read once (a frame mid-paint) and then gone does
   * not refuse the send; it used to end the wait on that one read. A dialog
   * that opens after the wait is still refused by the shared sender's re-read
   * under the input lock, on one read. No capture is waited for past the
   * window: one still running at the deadline is not used.
   *
   * @throws Error (`Vibe Local prompt not ready`) when the prompt did not come
   *   up within {@link VIBE_LOCAL_PROMPT_WAIT_TIMEOUT_MS}; nothing was typed
   * @throws Error coded `prompt-waiting` ({@link confirmedDialogRefusal}) for a
   *   confirmed dialog; nothing was typed
   */
  private async waitForPrompt(sessionName: string): Promise<void> {
    const deadline = Date.now() + VIBE_LOCAL_PROMPT_WAIT_TIMEOUT_MS;
    const dialog = createDialogConfirmation();
    while (Date.now() < deadline) {
      let confirmed = false;
      try {
        const output = await readBeforeDeadline(
          () => capturePane(sessionName, VIBE_LOCAL_PROMPT_CAPTURE_LINES),
          deadline
        );
        if (output === null) break;
        if (isVibeLocalComposerReady(output)) return;
        confirmed = dialog.observe(isVibeLocalWaitDialog(output));
      } catch (error: unknown) {
        // Capture may fail - continue polling. Not a dialog read: the run restarts.
        dialog.reset();
        logger.debug('vibe-local-prompt-capture-failed', { sessionName, error: getErrorMessage(error) });
      }
      if (confirmed) {
        logger.warn('vibe-local-prompt-wait-dialog', { sessionName, reads: dialog.reads });
        throw confirmedDialogRefusal(sessionName, 'Vibe Local');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(VIBE_LOCAL_PROMPT_POLL_INTERVAL_MS, remaining)));
    }
    logger.info('vibe-local-prompt-not-detected');
    throw new Error('Vibe Local prompt not ready: timed out waiting for the input prompt before sending');
  }

  /**
   * Kill vibe-local session
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    await this.requestExitAndKill(worktreeId, instanceId, {
      logger,
      stoppedAction: 'stopped-vibe-local-session',
      requestExit: async (sessionName) => {
        // Send Ctrl+C to interrupt any running operation
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, TUI_INTERRUPT_SETTLE_MS));

        // Send Ctrl+C again to ensure exit
        await sendSpecialKey(sessionName, 'C-c');
        await new Promise((resolve) => setTimeout(resolve, TUI_EXIT_WAIT_MS));
      },
    });
  }
}
