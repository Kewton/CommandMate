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
import {
  isCodexPromptReady,
  getCodexActiveDialog,
  getCodexLifecycleDialog,
  CODEX_HOOKS_REVIEW_ANCHORS,
  stripAnsi,
} from '../detection/cli-patterns';
import { findShellPromptTail } from '../detection/tool-liveness';
import {
  CODEX_UPDATE_DIALOG_KEYS,
  codexUpdateDialogAnswerKey,
  resolveCodexUpdateDialogPolicy,
} from '@/config/codex-update-dialog-config';
import { createLogger } from '@/lib/logger';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  CODEX_DIALOG_SETTLE_MS,
} from '@/config/cli-tool-timing-config';
import { SessionStartUnavailableError } from '../session/session-start-error';

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

/**
 * Extra polls `waitForReady` may spend waiting out `npm install -g
 * @openai/codex` under the `update` policy (Issue #2068).
 *
 * Two minutes on top of the ordinary window, and only when the operator has
 * asked for the update: the launch this budget belongs to is one the human
 * requested, and the alternative to waiting is returning "not ready" while an
 * install the server started is still running. The install itself took 2 s
 * measured (codex-cli 0.149.1 -> 0.151.0, warm npm cache, 2026-08-31); the size
 * of the budget is for a cold cache on a slow link, and it is never spent under
 * any other policy.
 */
const CODEX_UPDATE_INSTALL_MAX_ATTEMPTS = 120;

/** Timeout for waiting for prompt before sending a message */
const CODEX_PROMPT_WAIT_TIMEOUT_MS = 15000;

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
 *
 * Re-verified on codex-cli 0.148.0 for Issue #1829, against the objection that
 * the dialog's own footer says `Press enter to confirm`. With the trust hashes
 * invalidated and Auto-Yes off, a session launched onto this dialog reached
 * `› Ask Codex to do anything` and then ran the message it was sent — on the
 * `'3'` alone. The footer and the number key are not exclusive: the number
 * selects AND confirms, Enter confirms the highlighted option. That is also why
 * a trailing Enter is so costly here — the number having already advanced the
 * screen, the Enter lands on the NEXT one, which is precisely how a pane ends up
 * two screens deep in the hooks review UI.
 */
const CODEX_HOOKS_REVIEW_DECLINE_KEY = '3';

/**
 * How many times `waitForReady` may press `esc` to climb out of codex's hooks
 * review screens (Issue #1829).
 *
 * Two is the depth of the UI — detail -> list -> closed — and the cap exists
 * because the alternative is one press per poll: 30 keystrokes into whatever is
 * really on screen if the classifier is ever wrong about a frame. Two spare
 * presses cover a redraw landing between capture and send.
 */
const CODEX_HOOKS_SCREEN_MAX_ESCAPES = 4;

/**
 * Whether the pane is sitting on the hooks review dialog.
 *
 * Position-independent on purpose, unlike `getCodexActiveDialog`: the only
 * caller checks `isCodexPromptReady` first and returns when a genuine prompt
 * exists, so residual dialog text above a live prompt is never reached, and a
 * one-shot guard stops the key being sent twice. Callers OUTSIDE this launch
 * sequence must use `getCodexLifecycleDialog` instead, which is position-based.
 *
 * The dialog has to be handled here rather than in `getCodexActiveDialog`, which
 * classifies it as `null`: its wording matches none of that function's three
 * anchors (`Skip until next version` / `Do you trust` / `Press enter to
 * continue`). Measured consequence of leaving it alone, on a pane with the
 * generated `hooks.json` present: `isCodexPromptReady` stays false for the full
 * 30-attempt window and the session is then handed to `sendMessage` still
 * sitting on the dialog. Every launch, because "continue without trusting" is
 * not remembered — verified by relaunching and getting the same screen.
 *
 * The anchors themselves live in `detection/cli-patterns` (Issue #1829): the
 * Auto-Yes poller has to recognise the same screen in order to keep its hands
 * off it, and two copies of the anchors would be two chances to disagree about
 * what this dialog is.
 *
 * @param output - ANSI-stripped pane capture
 * @returns True when both anchors of the dialog are present
 * @see CODEX_HOOKS_REVIEW_ANCHORS
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
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    // Check if Codex is installed
    const codexAvailable = await this.isInstalled();
    if (!codexAvailable) {
      throw new SessionStartUnavailableError(this.name, 'Codex CLI is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Check if session already exists
    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName);

      // Issue #2070: this branch used to return unconditionally, and that is
      // the second half of the reported bug. codex's own "1. Update now"
      // replaces codex with `npm install` and exits; `Ctrl+C` twice quits it; a
      // crash does the same. The tmux session survives all three, so `exists`
      // stays true and the launch was skipped for a pane that had nothing but a
      // shell prompt in it — leaving `kill-session` by hand as the only
      // recovery. When the tool is gone we fall THROUGH and re-send the launch
      // command into the same pane.
      if (await this.isToolLive(sessionName, { confirm: true })) {
        logger.info('codex-session-sessionname');
        return;
      }
      logger.warn('codex-session-relaunch', { sessionName });
    }

    // Issue #1760: everything the previous codex process reported through this
    // (worktreeId, instanceId) belongs to a session that no longer exists, and
    // the key is reused verbatim by the one about to be created. Without this
    // fence the old process's last `user_prompt_submit` reads as the new one's
    // and a brand-new session publishes `running` before anyone has typed into
    // it (#1723).
    //
    // Issue #2070: also on the RELAUNCH path, and for exactly the same reason.
    // The pane is the same pane, but the process is not the same process, and
    // the events the dead one filed under this key must not be read as the new
    // one's. (Contrast opencode's live-reuse branch, which deliberately does
    // NOT fence: there the process is the same one.)
    beginAgentSession({ worktreeId, cliToolId: CODEX_CLI_TOOL_ID, instanceId });

    try {
      if (!exists) {
        // Create tmux session. Codex is inline-rendered, so its transcript lives in
        // the pane scrollback — depth comes from the shared TMUX_HISTORY_LIMIT
        // default (Issue #1624), do not re-hardcode it here.
        await createSession({
          sessionName,
          workingDirectory: worktreePath,
        });

        // Wait a moment for the session to be created
        await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));
      }

      // Issue #1760: hand this session its correlation keys, writing codex's
      // hooks config first if it is not already there. codex has no
      // `--settings`, so the keys ride in environment assignments on the launch
      // line and the hook commands read them back — which is what tells `codex`
      // from `codex-2` in one worktree, since `cwd` is identical for both.
      //
      // Falls back to the bare command on any failure and when
      // `CM_AGENT_HOOKS_INJECT=0`; a session that starts without hooks is the
      // pre-#1760 status quo, and a session that fails to start is not.
      const launchCommand = buildAgentLaunchCommandLine({
        target: { worktreeId, cliToolId: CODEX_CLI_TOOL_ID, instanceId },
        executablePath: this.command,
        worktreePath,
      });

      // Issue #2068: re-send the SAME launch line into the SAME pane, for the
      // one case where a launch legitimately has to happen twice — codex's own
      // `1. Update now` replaces codex with `npm install -g @openai/codex` and
      // exits, so the session start has to survive its agent quitting halfway
      // through it. The fence is re-applied for the reason #2070 gives on the
      // relaunch path: the pane is the same pane, the process is not the same
      // process, and events the dead one filed under this key must not be read
      // as the new one's.
      const relaunchIntoSamePane = async (): Promise<void> => {
        beginAgentSession({ worktreeId, cliToolId: CODEX_CLI_TOOL_ID, instanceId });
        await sendKeys(sessionName, launchCommand, true);
        await new Promise((resolve) => setTimeout(resolve, CODEX_INIT_WAIT_MS));
      };

      // Start Codex CLI in interactive mode
      await sendKeys(sessionName, launchCommand, true);

      // Wait for Codex to initialize
      await new Promise((resolve) => setTimeout(resolve, CODEX_INIT_WAIT_MS));

      // Poll until Codex interactive prompt is ready
      // Handles trust dialog and update notification automatically
      await this.waitForReady(sessionName, { relaunch: relaunchIntoSamePane });

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
   *
   * @param sessionName - tmux session name
   * @param options.relaunch - Re-send the launch line into this same pane.
   *   Supplied by {@link launchSession} and used only after the update dialog
   *   has been answered with `1` — by this method under the `update` policy of
   *   `config/codex-update-dialog-config`, or by a human under `ask`.
   */
  private async waitForReady(
    sessionName: string,
    options?: { relaunch?: () => Promise<void> }
  ): Promise<void> {
    // Issue #892: one-shot guards. capturePane(50) keeps a dismissed dialog in
    // scrollback, so a key must be sent at most once per dialog -- otherwise the
    // update branch re-sends "2" every poll and the live prompt gets "222...".
    let updateDialogHandled = false;
    let trustDialogHandled = false;
    let hooksReviewHandled = false;
    let hooksScreenEscapes = 0;

    // Issue #2068. Resolved once per launch rather than per poll: the operator
    // does not get to change their mind halfway through one session start, and
    // one reading is one fewer thing that can differ between the frame that saw
    // the dialog and the frame that answers it.
    const updatePolicy = resolveCodexUpdateDialogPolicy();
    const updateAnswerKey = codexUpdateDialogAnswerKey(updatePolicy);

    /** Whether this launch has had codex's update dialog in front of it. */
    let updateDialogSeen = false;
    /** Whether the post-update relaunch has already been issued (once only). */
    let relaunchIssued = false;
    /**
     * The poll budget, which the `update` policy is allowed to raise.
     *
     * Re-read every iteration, so raising it mid-loop extends the window rather
     * than being ignored. `npm install -g @openai/codex` took 2 s on the machine
     * this was measured on; the budget is sized for a slow network, and it is
     * spent only when the operator has asked for the update.
     */
    let maxAttempts = CODEX_INIT_MAX_ATTEMPTS;

    for (let i = 0; i < maxAttempts; i++) {
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

        // Issue #2068: codex answered `1. Update now` and quit.
        //
        // Reached only after this launch has actually SEEN the update dialog,
        // which is what makes reading a shell prompt here safe: the same row is
        // on the pane for the whole window between `createSession` and the
        // launch line landing, and that window is over by the time codex has
        // painted a dialog. Whoever pressed `1` -- this method under the
        // `update` policy, or the human under `ask` -- the pane now holds
        // codex's three update rows and a live shell, so the launch line goes
        // back into it. Once: a `1` that did not lead to a working codex must
        // not turn into a relaunch loop.
        //
        // `findShellPromptTail` rather than {@link isToolLive}, and the
        // difference is measured: `npm install` prints three rows, so the dead
        // `› 1. Update now` option row is still inside the shared rule's
        // 12-row alive window and vetoes the exit. See that function's docblock.
        if (
          updateDialogSeen &&
          !relaunchIssued &&
          options?.relaunch &&
          findShellPromptTail(output, this.livenessSpec()) !== null
        ) {
          relaunchIssued = true;
          maxAttempts = Math.max(maxAttempts, i + 1 + CODEX_INIT_MAX_ATTEMPTS);
          // The relaunched codex meets its own trust / hooks screens, and they
          // are new screens rather than the ones already answered.
          //
          // `updateDialogHandled` is deliberately NOT reset. A successful update
          // means the relaunched codex is the latest version and shows no dialog
          // at all; a FAILED one (no network, an npm prefix the operator cannot
          // write) puts the identical dialog back, and answering `1` a second
          // time would quit codex again with the one relaunch already spent.
          // Left alone, the dialog simply stays on the pane where `detectPrompt`
          // reports it and the human can answer it.
          trustDialogHandled = false;
          hooksReviewHandled = false;
          hooksScreenEscapes = 0;
          logger.info('codex-relaunched-after-update', { sessionName, policy: updatePolicy });
          await options.relaunch();
          continue;
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

        // Issue #1829: back out of the two screens the hooks dialog leads to.
        // Confirming its option 1 -- which the Auto-Yes poller did on two live
        // sessions, and which a human can do too -- opens a review UI whose only
        // exits are `t` and `esc`. `t` is out: it writes `[hooks.state…]` into
        // the operator's own ~/.codex/config.toml, the grant Issue #1760
        // declined on their behalf. So `esc`, once per poll until the screens
        // are gone. Before this, nothing sent either key: the whole 30-attempt
        // window elapsed, waitForReady returned as if ready, and the session was
        // left parked there -- reported as `running`, because neither screen
        // carries an option, a confirm footer or a thinking indicator.
        const hooksScreen = getCodexLifecycleDialog(output);
        if (
          (hooksScreen === 'hooks-list' || hooksScreen === 'hooks-detail') &&
          hooksScreenEscapes < CODEX_HOOKS_SCREEN_MAX_ESCAPES
        ) {
          await sendSpecialKey(sessionName, 'Escape');
          hooksScreenEscapes++;
          logger.info('codex-hooks-screen-escaped');
          await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
          continue;
        }

        // Issue #892: classify the bottom-most ACTIVE dialog by position. A dialog
        // whose text is only residual scrollback above a genuine prompt returns
        // null here, so no stray key is sent after it has been dismissed.
        const activeDialog = getCodexActiveDialog(output);

        // Handle update notification BEFORE trust dialog check.
        // Update notification shows: › 1. Update now / 2. Skip / 3. Skip until next version
        // followed by "Press enter to continue".
        //
        // Issue #2068: which key that is, is now the operator's to decide. It
        // was '2' (Skip) from Issue #890 until this Issue measured what '2'
        // actually does -- nothing, to `$CODEX_HOME/version.json` -- so the
        // dialog came back on every single launch and the operator could never
        // choose the update, because the server had always already chosen. The
        // default is now '3' (Skip until next version), which persists.
        // See `config/codex-update-dialog-config` for the measurement table.
        if (activeDialog === 'update') {
          updateDialogSeen = true;

          if (updateAnswerKey === null) {
            // `ask`. Send nothing and keep polling: the dialog stays on the
            // pane, so `detectPrompt` reports it as the multiple-choice prompt
            // it is and PromptPanel offers the human all three options. Falls
            // through the remaining branches deliberately -- the dialog's own
            // "Press enter to continue" footer must NOT be answered either,
            // which is the pre-existing precedence this branch keeps by
            // continuing before the `press-enter` check below.
            await new Promise((resolve) => setTimeout(resolve, CODEX_POLL_INTERVAL_MS));
            continue;
          }

          if (!updateDialogHandled) {
            // Issue #890: Codex confirms a numbered selection instantly (no Enter).
            // Appending Enter (sendEnter=true) would land on the NEXT screen as a
            // stray keypress -- an empty submit on the main prompt, or worst case the
            // default "1. Update now" confirm if the key was dropped during a re-render.
            // Send the digit alone and let the next poll observe the result.
            await sendKeys(sessionName, updateAnswerKey, false);
            updateDialogHandled = true;
            if (updateAnswerKey === CODEX_UPDATE_DIALOG_KEYS.update) {
              // codex is about to become `npm install`. The prompt this method
              // is waiting for belongs to a process that does not exist yet.
              maxAttempts = Math.max(maxAttempts, i + 1 + CODEX_UPDATE_INSTALL_MAX_ATTEMPTS);
            }
            logger.info('codex-update-dialog-answered', {
              sessionName,
              policy: updatePolicy,
              key: updateAnswerKey,
            });
            await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
            continue;
          }
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

    // Issue #2070: the pane exists, but does the AGENT? codex's "1. Update now"
    // replaces it with `npm install` and exits, `Ctrl+C` twice quits it, a crash
    // does the same — and the send that follows used to sit in the readiness
    // wait until it timed out, leaving `kill-session` by hand as the only
    // recovery. Relaunches into the same pane when the tool is gone; costs one
    // `capture-pane` when it is not.
    await this.relaunchIfToolExited(worktreeId, instanceId);

    try {
      // Verify Codex is at prompt state before sending
      await this.waitForPrompt(sessionName);

      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'codex',
        // Issue #1933: the tool describes its own composer; the sender no
        // longer keys three module-level tables on the id.
        composer: this.describeComposer(),
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
