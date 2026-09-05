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
  getSessionWorkingDirectory,
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
import {
  acquireAgentUpdateLock,
  releaseAgentUpdateLock,
  type UpdatableAgentTool,
} from '@/lib/updates';
import { createLogger } from '@/lib/logger';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources';
import { shouldTrustCodexHooks } from '@/lib/hooks/sources/codex/hooks-config';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  CODEX_DIALOG_SETTLE_MS,
} from '@/config/cli-tool-timing-config';
import { missingToolError } from './install-hints';

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

/**
 * The tool id this module takes {@link acquireAgentUpdateLock} for
 * (Issue #2068 x #2069).
 *
 * Annotated rather than inferred so the compiler checks the one thing a literal
 * could get wrong: that `'codex'` is still a member of #2069's
 * `UpdatableAgentTool`. If that union is ever renamed or narrowed, this fails
 * the build instead of silently taking a lock nothing else takes.
 */
const CODEX_UPDATE_LOCK_TOOL: UpdatableAgentTool = 'codex';

/** Timeout for waiting for prompt before sending a message */
const CODEX_PROMPT_WAIT_TIMEOUT_MS = 15000;

/**
 * Screen 1, option 3: "Continue without trusting (hooks won't run)".
 *
 * The `CM_CODEX_HOOK_TRUST=never` answer since Issue #2315, and the default
 * answer before it. It leaves the hooks inert and the screen scraper doing what
 * it did before Issue #1760 — and, crucially, codex does not remember it: there
 * is no "asked and refused" state, only a grant, so this key buys one launch.
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
 * Screen 1, option 2: "Trust all and continue" (Issue #2315).
 *
 * The default answer now, gated on {@link shouldTrustCodexHooks} — which
 * withholds it from any worktree carrying its own `.codex/hooks.json`, the one
 * case where "all" could mean a repository's hooks rather than the operator's.
 * That function carries the whole of the argument for reversing #1760 here.
 *
 * This is the half of the fix that makes the dialog stop coming back: codex
 * records the grant as `[hooks.state."…:<event>:0:0"] trusted_hash`, so the
 * screen appears once rather than every launch. It only holds because the other
 * half — `hooks/sources/codex/relay-install` — stopped the generated file's
 * bytes moving between checkouts and invalidating that very hash.
 */
const CODEX_HOOKS_REVIEW_TRUST_KEY = '2';

/**
 * Screen 1, option 1: "Review hooks", which opens the list (Issue #2315).
 *
 * The second attempt on screen 1, never the first. A numbered option is a
 * position in a menu codex is free to renumber between versions, and this method
 * has already been re-pinned twice for exactly that kind of drift (#890, #1829).
 * The two screens *below* this one announce their own keys in a footer that
 * `getCodexLifecycleDialog` matches — `Press t to trust all;` and
 * `Press t to trust;` — so descending into the list turns a guess about
 * numbering into a key the screen itself named.
 */
const CODEX_HOOKS_REVIEW_LIST_KEY = '1';

/**
 * `t` — "trust", the key screens 2 and 3 print in their own footers.
 *
 * Sent literally: `sendKeys` hands a bare string to `tmux send-keys`, which
 * resolves key NAMES before characters, and a single letter that happens to
 * match one would be sent as something else entirely.
 */
const CODEX_HOOKS_TRUST_KEY = 't';

/**
 * How many keys `waitForReady` may spend on ONE hooks screen before it stops
 * pressing (Issue #1829, reworked for #2315).
 *
 * The number that matters is per screen, and the counter resets whenever the
 * classification changes — which is the fix. #1829 spent a fixed budget of 4
 * across the whole launch, so a pane that legitimately walked screen 1 -> 2 -> 3
 * could exhaust it on the way down and park on the last one for good; that is
 * one of the two ways the reported session ended up stuck. Progress now buys
 * more attempts, and only a screen that will not respond at all runs out.
 *
 * Three per screen, because each screen has at most two keys worth trying
 * (`2` then `1` on the review dialog; `t` or `esc` below it) plus one spare for
 * a redraw landing between the capture and the send.
 */
const CODEX_HOOKS_SCREEN_MAX_ATTEMPTS = 3;

/** The three screens codex's hook review can put in front of a launch. */
type CodexHooksScreen = 'hooks-review' | 'hooks-list' | 'hooks-detail';

/**
 * Which screen was last acted on, and how many keys it has cost.
 *
 * Carried across polls by the caller so the per-screen budget above can reset on
 * progress rather than counting down over a whole launch.
 */
interface CodexHooksScreenState {
  screen: CodexHooksScreen | null;
  attempts: number;
}

/** A fresh {@link CodexHooksScreenState}. */
function newHooksScreenState(): CodexHooksScreenState {
  return { screen: null, attempts: 0 };
}

/**
 * Whether the pane is sitting on the hooks review dialog.
 *
 * Position-independent, which is why Issue #2315 stopped branching on it.
 * `waitForReady` now classifies with `getCodexLifecycleDialog`, and the reason
 * is the shape the reported session was found in: screen 1's text stays in
 * scrollback while the pane sits on screen 3, so this predicate answers `true`
 * for a frame whose active screen is a different one, and the key it selected
 * was the key for the screen that had already been left. Kept as the
 * position-INDEPENDENT question ("has this pane ever shown the dialog?"), which
 * is a different question from "what is on it now".
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
      throw missingToolError(this);
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
      // Issue #2315: the provenance check happens here, where the worktree path
      // is, and not inside the polling loop — a repository that ships its own
      // `.codex/hooks.json` is one whose review dialog this server must not
      // answer with "trust all".
      await this.waitForReady(sessionName, {
        relaunch: relaunchIntoSamePane,
        trustHooks: shouldTrustCodexHooks(worktreePath),
      });

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
   * @param options.trustHooks - Whether the hook review may be answered with
   *   *trust* (Issue #2315). Decided by {@link shouldTrustCodexHooks} from the
   *   worktree path, which this method does not have; passing it in keeps the
   *   provenance check next to the directory it is a check about.
   */
  private async waitForReady(
    sessionName: string,
    options?: { relaunch?: () => Promise<void>; trustHooks?: boolean }
  ): Promise<void> {
    const trustHooks = options?.trustHooks ?? false;
    // Issue #892: one-shot guards. capturePane(50) keeps a dismissed dialog in
    // scrollback, so a key must be sent at most once per dialog -- otherwise the
    // update branch re-sends "2" every poll and the live prompt gets "222...".
    let updateDialogHandled = false;
    let trustDialogHandled = false;
    // Issue #2315: one budget per hooks screen, reset whenever the screen
    // changes, in place of #1829's single launch-wide escape count.
    const hooksScreenState = newHooksScreenState();

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
     * Whether this launch holds #2069's in-flight update lock (Issue #2068).
     *
     * Taken only when the `update` policy actually sends `1`. Released in two
     * places, and both are needed: at the relaunch below, which is the earliest
     * point at which the install is OBSERVABLY over (the shell prompt came
     * back), and in the `finally` around this whole loop, which is what makes
     * "the lock is never left held" true rather than merely usual -- a hung
     * install, a capture that throws, the window expiring, or an early return
     * all leave through it.
     */
    let updateLockHeld = false;
    /**
     * The poll budget, which the `update` policy is allowed to raise.
     *
     * Re-read every iteration, so raising it mid-loop extends the window rather
     * than being ignored. `npm install -g @openai/codex` took 2 s on the machine
     * this was measured on; the budget is sized for a slow network, and it is
     * spent only when the operator has asked for the update.
     */
    let maxAttempts = CODEX_INIT_MAX_ATTEMPTS;

    try {
      for (let i = 0; i < maxAttempts; i++) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Issue #2315: the hooks screens are judged BEFORE readiness, and the
        // order is load-bearing. `isCodexPromptReady` answers true for
        // `CODEX_HOOKS_STUCK_PANE` — the shape both #1829 sessions were found
        // in — because a genuine composer line IS in the frame; it is simply
        // buried under two review screens that codex painted after it. Ready
        // first would return on that frame and hand `sendMessage` a pane whose
        // keystrokes go to the review UI. `getCodexLifecycleDialog` cannot make
        // the opposite mistake: its window starts BELOW the bottom-most prompt
        // line, so it names a hooks screen only when that screen is what the
        // pane is actually showing.
        const lifecycleScreen = getCodexLifecycleDialog(output);
        if (
          lifecycleScreen === 'hooks-review' ||
          lifecycleScreen === 'hooks-list' ||
          lifecycleScreen === 'hooks-detail'
        ) {
          const sent = await this.answerCodexHooksScreen(
            sessionName,
            lifecycleScreen,
            hooksScreenState,
            trustHooks
          );
          if (sent) {
            await new Promise((resolve) => setTimeout(resolve, CODEX_DIALOG_SETTLE_MS));
            continue;
          }
        }

        // Check if the genuine interactive input prompt is ready.
        // Issue #892: isCodexPromptReady() is position-based -- a genuine "› " line
        // below stale dialog scrollback IS ready, while an active dialog (option
        // line "› 1." as the bottom element) is not.
        if (isCodexPromptReady(output)) {
          logger.info('codex-prompt-detected');
          return;
        }

        // Issue #2068: the pane fell back to a shell after the update dialog.
        //
        // ## What the guard actually says, which is wider than `update`
        //
        // `updateDialogSeen` is set by the update branch below on EVERY policy,
        // `skip` included -- so this reads: "this launch has had codex's update
        // dialog in front of it, and the pane is now a bare shell". The case it
        // exists for is the operator's own `1`: sent by this method under the
        // `update` policy, or by a human in PromptPanel under `ask`, either way
        // codex is replaced by `npm install` and exits, and the launch line has
        // to go back in for the session start to mean anything.
        //
        // It is deliberately NOT narrowed to those two policies. Under `skip` or
        // `skip-until-next-version` a shell can only appear here if codex died
        // for some other reason inside the same 30 s window, and re-sending the
        // launch line is the right answer to that too -- it is what Issue #2070's
        // recovery does at the next `sendMessage`, done at the launch instead of
        // a send later. Narrowing would buy nothing and would cost a second
        // condition to keep correct.
        //
        // Two properties keep this safe, and neither of them is the policy:
        //
        //  - **position in the launch.** A pane shows a bare shell for the whole
        //    window between `createSession` and the launch line landing, and no
        //    frame in that window can have had a dialog painted on it yet, so
        //    `updateDialogSeen` is still false there.
        //  - **once.** A `1` that did not lead to a working codex must not turn
        //    into a relaunch loop, so `relaunchIssued` spends the recovery.
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
          hooksScreenState.screen = null;
          hooksScreenState.attempts = 0;
          // Issue #2068 x #2069: the shell prompt IS the completion signal for
          // an install this process cannot await, so release here rather than
          // holding #2069's lock for the rest of the (up to two-minute) window
          // and refusing an update nobody is running any more.
          if (updateLockHeld) {
            updateLockHeld = false;
            releaseAgentUpdateLock(CODEX_UPDATE_LOCK_TOOL);
            logger.info('codex-update-lock-released', { sessionName });
          }
          logger.info('codex-relaunched-after-update', { sessionName, policy: updatePolicy });
          await options.relaunch();
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
            // Issue #2068 x #2069: `1` makes this pane a THIRD writer of one
            // `npm install -g @openai/codex`, beside `POST /api/agents/update`
            // and `commandmate agents update`. Take the in-flight lock BEFORE
            // the key, because after it there is nothing to take it for -- codex
            // has already replaced itself with the installer and this server
            // cannot call it back.
            //
            // Not taken for `2` / `3`: those answer the dialog without
            // installing anything, so a concurrent update is none of their
            // business and holding the lock would block it for no reason.
            let keyToSend = updateAnswerKey;
            if (
              keyToSend === CODEX_UPDATE_DIALOG_KEYS.update &&
              !acquireAgentUpdateLock(CODEX_UPDATE_LOCK_TOOL)
            ) {
              // Somebody else is already installing this exact package.
              //
              // Falling back to `3` rather than sending nothing, and rather than
              // sending `2`:
              //
              //  - **not `1`.** Two `npm install -g` runs on one global prefix
              //    can leave a half-written `node_modules/@openai/codex`, and
              //    the relaunch below would then type the launch line into a
              //    pane where `codex` no longer resolves -- with the one
              //    relaunch already spent, so nothing recovers it.
              //  - **not "send nothing".** The pane would sit on the dialog for
              //    the rest of the window and `startSession` would hand
              //    `sendMessage` a session with no prompt in it. `ask` chooses
              //    that deliberately; an operator who asked for `update` did not.
              //  - **`3` rather than `2`.** The version this dialog offers is
              //    the version the other process is installing, so recording it
              //    as `dismissed_version` is true rather than merely quiet -- and
              //    `2` is the answer Issue #2068 exists to stop sending, because
              //    it persists nothing and the dialog returns next launch.
              keyToSend = CODEX_UPDATE_DIALOG_KEYS['skip-until-next-version'];
              logger.warn('codex-update-dialog-yielded-to-running-update', {
                sessionName,
                policy: updatePolicy,
                requestedKey: updateAnswerKey,
                key: keyToSend,
              });
            } else if (keyToSend === CODEX_UPDATE_DIALOG_KEYS.update) {
              updateLockHeld = true;
            }

            // Issue #890: Codex confirms a numbered selection instantly (no Enter).
            // Appending Enter (sendEnter=true) would land on the NEXT screen as a
            // stray keypress -- an empty submit on the main prompt, or worst case the
            // default "1. Update now" confirm if the key was dropped during a re-render.
            // Send the digit alone and let the next poll observe the result.
            await sendKeys(sessionName, keyToSend, false);
            updateDialogHandled = true;
            if (keyToSend === CODEX_UPDATE_DIALOG_KEYS.update) {
              // codex is about to become `npm install`. The prompt this method
              // is waiting for belongs to a process that does not exist yet.
              maxAttempts = Math.max(maxAttempts, i + 1 + CODEX_UPDATE_INSTALL_MAX_ATTEMPTS);
            }
            logger.info('codex-update-dialog-answered', {
              sessionName,
              policy: updatePolicy,
              key: keyToSend,
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
    } finally {
      // Issue #2068 x #2069: the backstop. The install this lock covers runs
      // inside tmux, so nothing here can await it -- the relaunch branch
      // releases on the one signal that says it finished, and everything else
      // arrives here. Without this, a codex that never comes back would leave
      // the marker set for the life of the server and every later update, from
      // any of the three routes, would be refused.
      if (updateLockHeld) {
        updateLockHeld = false;
        releaseAgentUpdateLock(CODEX_UPDATE_LOCK_TOOL);
        logger.warn('codex-update-lock-released-unfinished', { sessionName });
      }
    }
  }

  /**
   * Send the one key that gets this pane off the hooks screen it is on
   * (Issue #2315).
   *
   * ## Why a state machine and not a budget
   *
   * codex's hook review is three screens deep, and #1829's recovery counted its
   * `esc` presses across the whole launch. A pane that walked all three could
   * therefore run out on the way down and park on the last one — which is one
   * half of what the reported session was doing. The count here is per screen
   * and resets the moment the classification changes, so descending costs
   * nothing and only a screen that ignores its own documented key runs out.
   *
   * ## Which key
   *
   * When `trust` is granted the answer is the one that ends the review for good:
   * `2` on the launch dialog, `t` on either screen below it. codex records that
   * as a `trusted_hash` in the operator's `~/.codex/config.toml`, so the dialog
   * appears once instead of on every launch — the decline it replaces was never
   * remembered, which is why "度々" was the Issue's word for this.
   *
   * When it is withheld — `CM_CODEX_HOOK_TRUST=never`, or a worktree carrying
   * its own `.codex/hooks.json` — it is the pre-#2315 path: `3`, then `esc`.
   *
   * The launch dialog gets a second, different key on its second attempt.
   * Numbered options are a menu position codex is free to renumber (this method
   * has been re-pinned for that twice already), so if `2`/`3` did not move the
   * screen, `1` descends into the list, whose footer NAMES the key that closes
   * it and which `getCodexLifecycleDialog` matched to get here.
   *
   * @param sessionName - tmux session name
   * @param screen - The bottom-most active hooks screen, from `getCodexLifecycleDialog`
   * @param state - Per-screen budget, carried across polls by the caller
   * @param trust - Whether trust may be granted, from {@link shouldTrustCodexHooks}
   * @returns True when a key was sent, false when this screen's budget is spent
   */
  private async answerCodexHooksScreen(
    sessionName: string,
    screen: CodexHooksScreen,
    state: CodexHooksScreenState,
    trust: boolean
  ): Promise<boolean> {
    if (state.screen !== screen) {
      // Progress. The pane moved, so the previous screen's spent attempts say
      // nothing about this one.
      state.screen = screen;
      state.attempts = 0;
    }
    if (state.attempts >= CODEX_HOOKS_SCREEN_MAX_ATTEMPTS) {
      logger.warn('codex-hooks-screen-unresponsive', { sessionName, screen, trust });
      return false;
    }
    const attempt = ++state.attempts;

    if (screen === 'hooks-review') {
      const key =
        attempt === 1
          ? trust
            ? CODEX_HOOKS_REVIEW_TRUST_KEY
            : CODEX_HOOKS_REVIEW_DECLINE_KEY
          : CODEX_HOOKS_REVIEW_LIST_KEY;
      // Issue #890: the number selects AND confirms. A trailing Enter would land
      // on the screen this key just opened.
      await sendKeys(sessionName, key, false);
      logger.info('codex-hooks-review-answered', { sessionName, key, attempt, trust });
      return true;
    }

    if (trust) {
      // `t`, the key screens 2 and 3 print in their own footers. Literal, so
      // tmux sends the character rather than resolving it as a key name.
      await sendKeys(sessionName, CODEX_HOOKS_TRUST_KEY, false, { literal: true });
      logger.info('codex-hooks-screen-trusted', { sessionName, screen, attempt });
      return true;
    }

    await sendSpecialKey(sessionName, 'Escape');
    logger.info('codex-hooks-screen-escaped', { sessionName, screen, attempt });
    return true;
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
    // Issue #2315: the hooks review can come back AFTER the launch is over --
    // `waitForReady` runs once and is long gone by then. Issue #1829's two live
    // sessions were found in exactly that shape (`CODEX_HOOKS_STUCK_PANE`: a
    // ready prompt in scrollback with the review screens below it), and until
    // now nothing owned it: every send timed out here and threw, session after
    // session, with `kill-session` by hand as the only way out. The same state
    // machine the launch uses gets the pane back.
    const hooksScreenState = newHooksScreenState();
    /** Resolved lazily — one tmux call, and only if a hooks screen shows up. */
    let trustHooks: boolean | null = null;

    while (Date.now() - startTime < CODEX_PROMPT_WAIT_TIMEOUT_MS) {
      try {
        const rawOutput = await capturePane(sessionName, 50);
        const output = stripAnsi(rawOutput);

        // Before readiness, for the reason `waitForReady` gives: a review screen
        // painted OVER a live composer leaves `isCodexPromptReady` true, and
        // returning there types the user's message into the review UI.
        const screen = getCodexLifecycleDialog(output);
        if (screen === 'hooks-review' || screen === 'hooks-list' || screen === 'hooks-detail') {
          if (trustHooks === null) {
            // The pane's own directory, for the same reason `relaunchIfToolExited`
            // asks tmux for it: `sendMessage` is handed a worktree id, not a path,
            // and the pane knows where it is actually running.
            const worktreePath = await getSessionWorkingDirectory(sessionName);
            trustHooks = worktreePath !== null && shouldTrustCodexHooks(worktreePath);
          }
          await this.answerCodexHooksScreen(sessionName, screen, hooksScreenState, trustHooks);
        } else if (isCodexPromptReady(output)) {
          // Issue #890/#892: position-based guard so a residual update/trust dialog
          // ("› 1. ...") is never mistaken for a ready prompt -- yet a genuine "› "
          // prompt below stale dialog scrollback IS accepted.
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
