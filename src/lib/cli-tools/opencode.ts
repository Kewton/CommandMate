/**
 * OpenCode CLI tool implementation
 * Issue #379: Provides integration with OpenCode TUI in interactive mode
 *
 * @remarks Follows the same tmux-based pattern as Claude/Codex/Gemini/VibeLocal tools.
 * - startSession: launches `opencode` TUI in tmux
 * - sendMessage: sends text via tmux send-keys + Enter
 * - killSession: types `/exit` + a separate Enter, then falls back to tmux kill-session
 * - interrupt(): `POST /session/:id/abort` when the port is live (Issue #2034),
 *   else Escape TWICE, 300 ms apart -- one press does not abort (Issue #1894)
 *
 * ## Structured events (Issue #1763, Epic #1720 Phase 4-5)
 *
 * opencode is the one supported agent that does not push lifecycle events at
 * CommandMate: it is *subscribed to*. #1758 §5.1.2 measured that the plain TUI
 * serves the same HTTP API `opencode serve` does once it is given `--port`, so
 * the whole of the launch change is that flag — no second process, no pid to
 * track, no orphan to reap, and `killSession`'s `/exit`, the init wait and
 * `reconcileExistingSession` are all untouched.
 *
 * What is added around it is three calls into
 * `@/lib/hooks/sources/opencode/runtime`: reserve a port before the launch
 * command is built, attach the event stream once the TUI is up, and release
 * both when the pane is killed. Every one of them is fail-open — a session that
 * starts without structured events is the pre-#1763 status quo, and the screen
 * scraper keeps deciding for it exactly as before.
 *
 * ## Session continuity (Issue #2038)
 *
 * opencode is the one supported agent whose conversation is addressable from
 * the command line (`-s` / `-c` / `--fork`, measured on 1.18.22). `killSession`
 * writes the instance's session down while its server can still be asked
 * (`@/lib/session/opencode-session-recall`), and the creation path appends
 * `-s <id>` to the launch line when — and only when — the recorded
 * `Session.directory` is this worktree. The flag is composed HERE rather than in
 * `prepareOpencodeLaunch` so no other tool's launch plan can be reached by it.
 *
 * ## Launch side effects (Issue #1908)
 *
 * Two things this file used to do on the way up are gone. The 15-second sleep
 * between the launch keystroke and `attachOpencodeEventStream` is now a poll for
 * opencode's own composer ({@link OpenCodeTool.waitForReady}), and
 * `ensureOpencodeConfig` no longer writes into the worktree unless the operator
 * opted in — see `./opencode-config`.
 */

import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import type { NavigationKeySpec } from '@/types/cli-tool-contracts';
import {
  OPENCODE_LEADER_KEY,
  OPENCODE_NAVIGATION_KEY_VALUES,
} from '@/types/terminal-keys';
import {
  hasSession,
  createSession,
  capturePane,
  sendKeys,
  sendSpecialKey,
  sendSpecialKeys,
  killSession,
  exactTarget,
} from '../tmux/tmux';
import {
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_SELECTION_LIST_PATTERN,
  stripAnsi,
} from '../detection/cli-patterns';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { ensureOpencodeConfig } from './opencode-config';
import {
  OPENCODE_PANE_HEIGHT,
  OPENCODE_PANE_WIDTH,
  OPENCODE_PANE_WIDTH_ENV,
  OPENCODE_SIDEBAR_MIN_WIDTH,
  resolveOpencodePaneWidth,
} from '@/config/tmux-pane-config';
import { execFile } from 'child_process';
import { basename, extname } from 'path';
import { promisify } from 'util';
import { createLogger } from '@/lib/logger';
import { getMimeTypeByExtension } from '@/config/image-extensions';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  abortOpencodeTurn,
  attachOpencodeEventStream,
  opencodeTarget,
  releaseOpencodeEventStream,
  reserveOpencodeServerPort,
  resumeOpencodeEventStream,
} from '@/lib/hooks/sources/opencode/runtime';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import {
  getOpencodeLaunchSettings,
  opencodePromptSelection,
} from '@/lib/hooks/sources/opencode/launch-settings';
import {
  fetchOpencodeHealth,
  newOpencodeMessageId,
  opencodeFileUrl,
  readOpencodeUserMessage,
  sendOpencodePrompt,
  type OpencodePromptPart,
} from '@/lib/hooks/sources/opencode/client';
import {
  getOpencodeLiveness,
  getOpencodePrimarySession,
} from '@/lib/hooks/sources/opencode/subscription';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import { captureOpencodeSessionMemory } from '@/lib/session/opencode-session-recall';
import {
  recoverOpencodeSessionId,
  withOpencodeResumedSession,
} from '@/lib/session/opencode-session-store';
import { verifyGracefulExit } from './graceful-exit';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  OPENCODE_EXIT_WAIT_MS,
  OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS,
} from '@/config/cli-tool-timing-config';
import { SessionStartUnavailableError } from '../session/session-start-error';

const logger = createLogger('cli-tools/opencode');

const execFileAsync = promisify(execFile);

/**
 * Extract error message from unknown error type (DRY)
 * Same pattern as claude-session.ts / codex.ts / gemini.ts / vibe-local.ts.
 * A shared version exists in src/lib/errors.ts (getErrorMessage), but CLI tool
 * modules use local copies to avoid importing the server-side error module.
 * [D1-002] Future refactoring candidate: extract to BaseCLITool or a shared util.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** OpenCode TUI graceful exit command [D1-006] */
export const OPENCODE_EXIT_COMMAND = '/exit';

/**
 * OpenCode tmux pane height (rows).
 *
 * Defined in `@/config/tmux-pane-config` since Issue #1906 and re-exported here
 * so existing importers are unchanged. It moved because
 * `cli-tools/submit-verified-sender.ts` — which THIS module imports — needs it
 * to size its read-back window.
 */
export { OPENCODE_PANE_HEIGHT };

/**
 * OpenCode tmux pane width (columns).
 *
 * Re-exported from `@/config/tmux-pane-config` alongside the height (Issue
 * #2047) so a caller that needs the geometry gets both from one import.
 */
export { OPENCODE_PANE_WIDTH };

/**
 * {@link resolveOpencodePaneWidth}, plus the one-line operator feedback the
 * pure config module deliberately cannot emit (Issue #2047).
 *
 * `tmux-pane-config.ts` has no imports at all — that is a documented property
 * (#1906), and pulling the logger in there would make every consumer of a
 * constant depend on the logging stack. So the resolver stays silent and the
 * warning lives here, at the two call sites that actually resize a pane.
 *
 * Two things are worth telling the operator, and neither is an error:
 *
 * - the value was DROPPED (not an integer, or outside the accepted bounds), so
 *   the pane they are about to look at is the 80-column default rather than
 *   what they asked for;
 * - the value was ACCEPTED but lands at or above
 *   {@link OPENCODE_SIDEBAR_MIN_WIDTH}, where opencode 1.18.22 paints its
 *   right-hand sidebar into the same rows as the transcript. #2047 measured
 *   what that does to this repo's own readers — a saved "reply" made entirely
 *   of sidebar chrome, a status flip on an aborted turn, and a false idle
 *   composer off the session title. It is still allowed, because an operator
 *   who only ever reads the pane in the browser may want it; it is not silent.
 *
 * @returns Pane width in columns, ready to hand to `resize-window`.
 */
function resolveOpencodePaneWidthChecked(): number {
  const requested = process.env[OPENCODE_PANE_WIDTH_ENV];
  const width = resolveOpencodePaneWidth();

  if (requested !== undefined && String(width) !== requested.trim()) {
    logger.warn('opencode-pane-width-rejected', {
      requested,
      applied: width,
    });
  } else if (width >= OPENCODE_SIDEBAR_MIN_WIDTH) {
    logger.warn('opencode-pane-width-sidebar-visible', {
      width,
      sidebarMinWidth: OPENCODE_SIDEBAR_MIN_WIDTH,
    });
  }

  return width;
}

/**
 * Interval between readiness polls while opencode paints its TUI (Issue #1908).
 *
 * Half of copilot's second (`COPILOT_POLL_INTERVAL_MS`) because the thing being
 * waited for lands at ~3 s: a one-second cadence rounds a 3.0 s launch up to
 * 4 s for no reason, and the poll is one `capture-pane`.
 */
export const OPENCODE_READY_POLL_INTERVAL_MS = 500;

/**
 * Readiness poll attempts — 60 * 500 ms = the same 30-second window copilot's
 * `waitForReady` uses (Issue #1908).
 *
 * Sized off the slow end rather than the typical one. On an unloaded machine the
 * composer is drawn 2.9-3.6 s after the launch keystroke; under the load of six
 * parallel agents the same launch was measured at 24.1 s. The window has to
 * cover that, which is precisely what a fixed wait cannot do — see
 * {@link OpenCodeTool.waitForReady}.
 */
export const OPENCODE_READY_MAX_ATTEMPTS = 60;

/**
 * Scrollback rows to include in a readiness capture.
 *
 * `capturePane(name, n)` is `-S -n -E -`, i.e. n rows of history *plus* the whole
 * visible pane, so every one of the 200 rows in {@link OPENCODE_PANE_HEIGHT} is
 * in the frame regardless of this number. Matches copilot's 50.
 */
const OPENCODE_READY_CAPTURE_LINES = 50;

/**
 * Waits before each read-back of a message just posted to the server (#2035).
 *
 * Delays *before* each attempt, so the first costs nothing — which is the whole
 * ladder in the ordinary case. Measured on 1.18.22 across five posts: the
 * message was readable on the **first** `GET`, 8-23 ms after the POST began, so
 * `prompt_async` answers `204` after the message exists rather than before.
 *
 * The three retries are for the race that measurement did not produce, and they
 * are cheap because the alternative is expensive in one direction only: a
 * `missing` verdict sends the body again over the keyboard, so calling a message
 * missing while it is still being written would deliver it twice. Total worst
 * case 350 ms, inside the HTTP request the operator's send is waiting on.
 */
export const OPENCODE_SEND_READBACK_DELAYS_MS: readonly number[] = [0, 50, 100, 200];

/**
 * The body a tool that cannot attach an image sends instead (Issue #474).
 *
 * Defined here, and imported by `@/lib/session/send-user-message`, because
 * opencode is the one tool where the choice is made **at run time**: every other
 * tool either attaches natively for every session or never does, and their
 * branch is picked once by `isImageCapableCLITool`. opencode's native path needs
 * a server that a given pane may not have (no `--port`, `CM_AGENT_HOOKS_INJECT=0`,
 * a version too old), so {@link OpenCodeTool.sendMessageWithImage} has to be able
 * to produce this degraded form itself. One definition rather than two: the
 * string is what an operator reads in Message History, and a second copy of it
 * here would drift from the one in the send service without anything noticing.
 *
 * @param content - The operator's message; may be empty
 * @param absoluteImagePath - Absolute path to the attachment
 */
export function formatImagePathFallbackMessage(
  content: string,
  absoluteImagePath: string
): string {
  return content
    ? `${content}\n\n[添付画像: ${absoluteImagePath}]`
    : `[添付画像: ${absoluteImagePath}]`;
}

/**
 * OpenCode CLI tool implementation
 * Manages OpenCode interactive sessions using tmux
 */
export class OpenCodeTool extends BaseCLITool {
  readonly id: CLIToolType = 'opencode';
  readonly name = 'OpenCode';
  readonly command = 'opencode';

  /**
   * Declare opencode's key vocabulary (Issue #2046).
   *
   * The base pad plus opencode's own chords: the `C-x` leader, the letters that
   * complete it, and the two control keys that need no leader (`C-p` palette,
   * `C-t` variant cycle). Measured against a live opencode 1.18.22 on an
   * isolated `HOME` and a private tmux socket; the defaults are also readable in
   * the shipped binary (`leader: "ctrl+x"`, `leader_timeout: 2000`). Full run in
   * `docs/design/opencode-server-live-verification.md` §22.
   *
   * **`b` (`sidebar_toggle`) is not here**, and that absence is the Issue's main
   * finding rather than an oversight: at the 80 columns
   * `resolveOpencodePaneWidth()` defaults to, an explicit `C-x` `b` turns the
   * sidebar on *anyway* — it overrides the 121-column auto-gate #2047 measured —
   * and in that state the same three readers #2047 documented at 200 columns
   * break at 80 (§22.3). Before the first turn the binding is inert and the `b`
   * lands in the composer as text instead. Neither branch has a width where it
   * is safe, so the key is not published and the route will answer 400 for it.
   *
   * This method is the ONLY thing #2046 added to this file. Pane width and
   * geometry stay where #2047 put them (`src/config/tmux-pane-config.ts`).
   */
  navigationKeys(): NavigationKeySpec {
    return {
      keys: OPENCODE_NAVIGATION_KEY_VALUES,
      leaderKey: OPENCODE_LEADER_KEY,
    };
  }

  /**
   * Check if OpenCode session is running for a worktree
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    return await hasSession(sessionName);
  }

  /**
   * Start a new OpenCode session for a worktree
   * Launches `opencode` TUI in interactive mode within tmux
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Worktree path
   */
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    const opencodeAvailable = await this.isInstalled();
    if (!opencodeAvailable) {
      throw new SessionStartUnavailableError(this.name, 'OpenCode is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    const target = opencodeTarget(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (exists) {
      // Issue #2047: the SAME width as the creation path below. These two used
      // to spell `80` independently, which is the shape where "new sessions are
      // 200 wide, reconnected ones are 80" ships without anyone noticing —
      // a reconnect would silently hand the detectors a geometry the creation
      // path had been moved away from.
      await this.reconcileExistingSession(sessionName, {
        windowWidth: resolveOpencodePaneWidthChecked(),
        windowHeight: OPENCODE_PANE_HEIGHT,
      });
      // Issue #1763: the pane outlived this process (a CommandMate restart), so
      // the subscription that used to watch it is gone while its server is
      // still listening. Recovered from the recorded port, health-checked, and
      // skipped silently when there is nothing there. NOT a new generation —
      // the pane is the same one, and fencing here would discard a still-valid
      // verdict on every reconnect.
      await resumeOpencodeEventStream(target, worktreePath);
      logger.info('opencode-session-sessionname');
      return;
    }

    // Issue #1759 (S8) / #1763: everything the previous opencode process
    // reported through this (worktreeId, instanceId) belongs to a session that
    // no longer exists, and the key is reused verbatim by the one about to be
    // created. On the creation path only, before the pane exists, and even if
    // the launch then fails — falling back to the scraper is always safe.
    beginAgentSession(target);

    try {
      // Generate opencode.json if not present (non-fatal on failure)
      await ensureOpencodeConfig(worktreePath);

      // Create tmux session. Scrollback depth comes from the shared
      // TMUX_HISTORY_LIMIT default (Issue #1624) — do not re-hardcode it here.
      await createSession({
        sessionName,
        workingDirectory: worktreePath,
      });

      // Wait a moment for the session to be created
      await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));

      // Resize tmux window so opencode's right-hand sidebar stays hidden and
      // `capture-pane` returns transcript rows only. Issue #2047 measured the
      // boundary this depends on (sidebar at >=121 columns, hidden at <=120) and
      // moved the number to `OPENCODE_PANE_WIDTH` / `CM_OPENCODE_PANE_WIDTH`.
      // [SEC-001] Uses execFile (not exec) to prevent shell meta-character injection via sessionName
      try {
        await execFileAsync('tmux', [
          // Issue #1156: exact-match target so resize never leaks to a prefix-colliding instance
          'resize-window', '-t', exactTarget(sessionName),
          '-x', String(resolveOpencodePaneWidthChecked()), '-y', String(OPENCODE_PANE_HEIGHT),
        ]);
      } catch {
        // Non-fatal: resize may fail in some environments
      }

      // Issue #1763: pick the port before the command is built. The TUI is its
      // own HTTP server once `--port` is passed (#1758 §5.1.2), and CommandMate
      // assigns the number because opencode's `--port 0` is not an OS-assigned
      // port — it tries 4096 first and only then falls back to an ephemeral one
      // that nothing can read back (§5.9). Null means "no structured events",
      // and the launch below is then the pre-#1763 bare command.
      await reserveOpencodeServerPort(target, worktreePath);

      // Start OpenCode TUI. `buildAgentLaunchCommandLine` asks the tool's own
      // `AgentEventSource` for the plan (S3/S4/S5) and never throws. opencode's
      // environment is empty — it is the one source with no correlation
      // variable, because CommandMate holds the connection (#1846).
      const plannedCommand = buildAgentLaunchCommandLine({
        target,
        executablePath: this.command,
        worktreePath,
      });

      // Issue #2038: continue the conversation this instance was in before it
      // was stopped. `-s <id>` is appended HERE rather than inside
      // `prepareOpencodeLaunch` because the plan is a statement about the tool
      // and this is a fact about one pane's history; keeping them apart is also
      // what makes "claude / codex の起動引数は不変" a property of the code
      // rather than of a test — no other tool's launcher can reach this line.
      //
      // Null whenever there is nothing to resume, and — the acceptance
      // condition — whenever the remembered session belongs to a different
      // worktree than the one being launched. See `./opencode-session-store`.
      const resumeSessionId = recoverOpencodeSessionId(target, worktreePath);
      const launchCommand =
        resumeSessionId === null
          ? plannedCommand
          : withOpencodeResumedSession(plannedCommand, resumeSessionId);
      if (resumeSessionId !== null) {
        logger.info('opencode-session-resumed', {
          worktreeId,
          instanceId: instanceId ?? this.id,
          sessionId: resumeSessionId,
        });
      }

      await sendKeys(sessionName, launchCommand, true);

      // Issue #1908: poll for opencode's own composer instead of sleeping 15 s.
      await this.waitForReady(sessionName);

      // Issue #1763: subscribe once the server is up. Health-checked first, so
      // an opencode too old to know `--port` costs one probe and nothing else.
      //
      // Issue #1908 measured the ordering this depends on: opencode's HTTP
      // server answers `/global/health` 1.3-1.8 s *before* the composer is
      // painted, in every run (9.4 s / 11.2 s, 12.2 s / 14.0 s, 22.8 s / 24.1 s
      // under load). Structurally so — the TUI is a client of its own server
      // (#1758 §5.1.2). Waiting for the composer therefore reaches this line
      // with the server already listening, which the fixed 15 s wait did not
      // guarantee: the 22.8 s run had nothing to probe at 15 s and would have
      // lost structured events for the whole session.
      await attachOpencodeEventStream(target);

      logger.info('started-opencode-session:sessionname');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to start OpenCode session: ${errorMessage}`);
    }
  }

  /**
   * Wait until opencode has painted something only opencode paints.
   *
   * Issue #1908 replaced a fixed 15-second sleep here. That number was written
   * as "GPU model loading via Ollama", which the measurements do not support:
   * opencode loads no model at launch (nothing is loaded until the first
   * request), and the TUI it is waiting for is drawn at 2.9-3.6 s on an idle
   * machine — so every session paid ~11 s of nothing, inside the HTTP request
   * that started it. A fixed wait is also wrong in the other direction: with six
   * agents running, the same launch took 24.1 s, and 15 s was not enough.
   *
   * ## What counts as evidence
   *
   * `OPENCODE_IDLE_COMPOSER_PATTERN` (Issue #1883) — the `Ask anything...`
   * placeholder **behind the input box's gutter**. Not reimplemented here on
   * purpose; it is the same positive-evidence row `status-detector` reads.
   *
   * The copilot hazard that #1907 hit does not reach opencode, and this was
   * checked rather than assumed. Removing copilot's blind sleep exposed the
   * shell frame to the first poll, and `^[>❯]\s` matches starship / pure /
   * agnoster prompts, so a shell was read as a ready copilot. opencode's boot
   * shows the same shell frame — measured, the launch line sits under a `❯`
   * prompt for the first ~0.7 s — but the gutter anchor cannot match it, and the
   * frames captured for `tests/fixtures/opencode-launch-boot-11821.ts` confirm
   * the pattern stays false until the composer exists.
   *
   * `OPENCODE_SELECTION_LIST_PATTERN` is the second accepted signal, because the
   * `Connect a provider` overlay **removes the composer from the frame**
   * (measured: `Ask anything` occurs zero times while it is up). Without it a
   * pane parked on that overlay would burn the whole 30-second window. It is
   * *not* answered — every option on it writes provider credentials into the
   * operator's config, which is the same line codex's launch draws at its
   * hooks-review dialog (#1760).
   *
   * ## On failure
   *
   * Returns false and lets the launch continue, exactly as the sleep did: a
   * session that is slower than the window is still a session, and the screen
   * scraper decides for it from there.
   *
   * @param sessionName - tmux session name
   * @returns Whether readiness evidence was seen inside the window
   */
  private async waitForReady(sessionName: string): Promise<boolean> {
    for (let attempt = 0; attempt < OPENCODE_READY_MAX_ATTEMPTS; attempt++) {
      try {
        const output = stripAnsi(await capturePane(sessionName, OPENCODE_READY_CAPTURE_LINES));

        // Do NOT stripBoxDrawing() this frame: the gutter is the anchor.
        if (OPENCODE_IDLE_COMPOSER_PATTERN.test(output)) {
          logger.info('opencode-composer-detected', { attempt });
          return true;
        }

        if (OPENCODE_SELECTION_LIST_PATTERN.test(output)) {
          logger.info('opencode-overlay-detected', { attempt });
          return true;
        }
      } catch {
        // Capture may fail while the pane is still coming up - keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_READY_POLL_INTERVAL_MS));
    }

    logger.info('opencode-ready-detection-timeout');
    return false;
  }

  /**
   * Post one prompt to this instance's server, and verify it landed (#2035).
   *
   * The primary half of `sendMessage` / `sendMessageWithImage`. Answers false
   * for every way the server route can fail to apply, and the caller then types
   * the body exactly as it did before this Issue.
   *
   * ## Why `prompt_async` and not `/tui/append-prompt` + `/tui/submit-prompt`
   *
   * Both were measured live on 1.18.22 (design doc §11). The `/tui/*` pair does
   * work — the composer reflects the text, `/tui/clear-prompt` removes residue
   * a keystroke left, and a three-line and a 266-character body both arrived
   * byte-identical. But it drives the **composer**, so it inherits the
   * composer's state, and the Issue's own example is where that shows: a body
   * of `/exit` opens the command palette on append, and the palette then eats
   * the submit. All three calls answered `200 true`; no message was created;
   * the TUI did not exit either. `prompt_async` does not touch the composer, and
   * the same `/exit` arrived as literal text — as did `--force …`,
   * `$(whoami)`, three lines, and 266 characters.
   *
   * It also leaves an operator's half-typed draft alone, which `/tui/*` cannot:
   * `append-prompt` concatenates (`AAA` + `BBB` = `AAABBB`), so sending through
   * the composer means either splicing CommandMate's body onto the draft or
   * clearing the draft away.
   *
   * ## Why the read-back
   *
   * `204` is "accepted", not "delivered", and the gap is not theoretical:
   * a file part whose `url` is a bare path is accepted and then dropped
   * *together with its text part* (see `opencodeFileUrl`), and a server sharing
   * `HOME` and project with this one accepts a prompt for a session it can
   * reach through `opencode.db` while the message appears on neither this
   * server's stream nor this pane's screen. So the message id is chosen up
   * front and read back afterwards — the same shape as #2034's idle watch, one
   * request instead of a subscription.
   *
   * ## What a `missing` verdict costs, and why `unknown` is treated like it
   *
   * `missing` is a `404` on the id: nothing exists, so typing the body is free
   * of duplication. `unknown` — the server stopped answering between the POST
   * and the read-back — cannot say that, and is still treated as a failure,
   * following #2034: the operator's message must not be silently dropped, and
   * a pane whose server just died is one where the keystroke route is the only
   * one left. The residual risk is one duplicate message inside that window,
   * and it is logged as `opencode-send-unverified` so it is visible rather than
   * inferred.
   *
   * @param target - The instance
   * @param message - The body, sent verbatim
   * @param imagePath - Absolute path to an attachment, if there is one
   * @returns Whether the message was posted **and** read back
   */
  private async trySendViaServer(
    target: AgentInstanceRef,
    message: string,
    imagePath?: string
  ): Promise<boolean> {
    const instanceId = target.instanceId ?? target.cliToolId;
    try {
      const port = getAssignedOpencodePort(target);
      if (port === null) return false;

      // The same three preconditions the abort path checks (#2034): a port with
      // a live subscription behind it, and a session this instance owns. The
      // liveness check is what keeps a squatter on a remembered port from being
      // handed the operator's message.
      const liveness = getOpencodeLiveness(target);
      if (liveness.state !== 'live') {
        logger.info('opencode-send-skipped-not-live', {
          worktreeId: target.worktreeId,
          instanceId,
          port,
          liveness: liveness.state,
        });
        return false;
      }

      // Null on a pane that has not run a turn yet — the gate learns the session
      // from the first frame that names it. That first send goes over the
      // keyboard, and every send after it takes this route.
      const sessionId = getOpencodePrimarySession(target);
      if (sessionId === null) {
        logger.info('opencode-send-skipped-no-session', {
          worktreeId: target.worktreeId,
          instanceId,
          port,
        });
        return false;
      }

      const parts: OpencodePromptPart[] = [{ type: 'text', text: message }];
      if (imagePath !== undefined) {
        parts.push({
          type: 'file',
          mime: getMimeTypeByExtension(extname(imagePath)),
          filename: basename(imagePath),
          url: opencodeFileUrl(imagePath),
        });
      }

      const messageId = newOpencodeMessageId();
      // Issue #2048: the instance's own persona / model / variant, when the
      // operator configured any. Read on every send rather than once at launch,
      // because a send can be the first thing this process does for a pane it
      // did not start (a CommandMate restart reattaches an existing session) —
      // and because an omitted `agent` is not a no-op: a `prompt_async` body
      // with no `agent` runs the turn as `build` even on a pane launched
      // `--agent plan` (`docs/design/opencode-server-live-verification.md`
      // §20.5). Null when nothing is configured, and the request body is then
      // byte-identical to the pre-#2048 one.
      const selection = opencodePromptSelection(getOpencodeLaunchSettings(target));
      if (!(await sendOpencodePrompt(port, sessionId, messageId, parts, selection))) return false;

      const verified = await this.verifyPostedMessage(port, sessionId, messageId, message);
      if (!verified) {
        logger.warn('opencode-send-unverified', {
          worktreeId: target.worktreeId,
          instanceId,
          port,
          sessionId,
          messageId,
          hasImage: imagePath !== undefined,
        });
        return false;
      }

      logger.info('opencode-send-delivered-via-api', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        sessionId,
        messageId,
        hasImage: imagePath !== undefined,
      });
      return true;
    } catch (error: unknown) {
      // Nothing above is allowed to take the send down: the keystroke route is
      // still there and is what runs when this answers false.
      logger.warn('opencode-send-api-failed', {
        worktreeId: target.worktreeId,
        instanceId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Read the posted message back until it is there, or until it is not (#2035).
   *
   * The text is compared rather than merely counted, because the acceptance
   * condition for this Issue is that the body is unchanged: a `/`-leading body,
   * a three-line body and a 200-column body all have to come back identical to
   * what was sent. An image send adds parts CommandMate did not write — 1.18.22
   * synthesises a `Called the Read tool with …` text part beside the operator's
   * — so the check is that the sent body is *among* the text parts, not that it
   * is the only one.
   *
   * @returns True once the body was found; false on a `404` or after the ladder
   */
  private async verifyPostedMessage(
    port: number,
    sessionId: string,
    messageId: string,
    message: string
  ): Promise<boolean> {
    for (const waitMs of OPENCODE_SEND_READBACK_DELAYS_MS) {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const readback = await readOpencodeUserMessage(port, sessionId, messageId);
      if (readback.kind === 'found') return readback.texts.includes(message);
      // A `404` is the server saying the message does not exist, which does not
      // become truer by asking again — the measured cause is a part the server
      // could not resolve, and it discards the whole message when that happens.
      if (readback.kind === 'missing') return false;
    }
    return false;
  }

  /**
   * Send a message to OpenCode interactive session
   * [D1-004] Same pattern as Codex/Gemini/VibeLocal (future Template Method candidate)
   *
   * Issue #2035: the server first, the keyboard second. {@link trySendViaServer}
   * documents the measurements behind the choice; what matters here is that
   * every no it can answer — no port, a subscription that is not live, no
   * session yet, a refused POST, a message that did not read back — lands on the
   * `sendMessageWithSubmitVerification` call below, which is the send path
   * exactly as it was before this Issue. A pane launched with
   * `CM_AGENT_HOOKS_INJECT=0`, or on an opencode too old for `--port`, must not
   * become a pane that cannot be sent to.
   *
   * @param worktreeId - Worktree ID
   * @param message - Message to send
   */
  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `OpenCode session ${sessionName} does not exist. Start the session first.`
      );
    }

    if (await this.trySendViaServer(opencodeTarget(worktreeId, instanceId), message)) {
      // Issue #405: the transcript grew, so the cached capture is stale — the
      // same reason the keystroke path invalidates below.
      invalidateCache(sessionName);
      return;
    }

    try {
      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'opencode',
        composer: this.describeComposer(),
      });

      // Issue #405: Invalidate cache after sending message
      invalidateCache(sessionName);

      logger.info('sent-message-to-opencode-session:session');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to send message to OpenCode: ${errorMessage}`);
    }
  }

  /**
   * opencode can attach an image — sometimes (Issue #2035).
   *
   * `IImageCapableCLITool` is a *static* declaration: `supportsImage()` takes no
   * arguments, so it cannot answer per pane, and `send-user-message` picks the
   * branch from it once. Saying `true` here therefore means
   * {@link sendMessageWithImage} owns the degraded form as well — which it does.
   *
   * Measured on 1.18.22: `POST /session/:id/prompt_async` with a `file` part
   * delivers a real image. The part came back on the stream re-encoded as
   * `data:image/png;base64,…`, the TUI rendered it as `File  blue.png`, and the
   * vision model answered the question that was asked about it. That is the
   * whole of the claim being made here.
   */
  supportsImage(): true {
    return true;
  }

  /**
   * Send a message with an image attached (Issue #2035).
   *
   * Before this Issue opencode had no image path at all, so `send-user-message`
   * took its `else` branch and appended `[添付画像: <path>]` to the text — the
   * agent received a *path*, and whether it ever looked at the file was up to
   * it. The server route sends the file itself.
   *
   * The fallback is that same degraded body, reached whenever the server route
   * does not apply, and it is deliberately routed back through
   * {@link sendMessage} rather than `sendMessageWithSubmitVerification`: the
   * reason the image could not be attached is usually "no session yet", and by
   * the time the text is sent that can already have changed. Going through
   * `sendMessage` gives the text one honest attempt at the API before the
   * keyboard, at the cost of one cheap re-check.
   *
   * @param worktreeId - Worktree ID
   * @param message - Message text; may be empty
   * @param imagePath - Absolute path to the image file
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  async sendMessageWithImage(
    worktreeId: string,
    message: string,
    imagePath: string,
    instanceId?: string
  ): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (!exists) {
      throw new Error(
        `OpenCode session ${sessionName} does not exist. Start the session first.`
      );
    }

    const target = opencodeTarget(worktreeId, instanceId);
    if (await this.trySendViaServer(target, message, imagePath)) {
      invalidateCache(sessionName);
      return;
    }

    logger.info('opencode-image-degraded-to-path', { worktreeId, instanceId: instanceId ?? this.id });
    await this.sendMessage(
      worktreeId,
      formatImagePathFallbackMessage(message, imagePath),
      instanceId
    );
  }

  /**
   * Kill OpenCode session with graceful shutdown.
   *
   * Shutdown sequence [D1-006, D1-007]:
   * 1. Check if session exists
   * 2. If exists: type `/exit`, then submit it with a separate Enter
   * 3. Wait 2s for OpenCode to process the exit command
   * 4. Re-check session: if still running, force-kill via tmux kill-session
   * 5. If session did not exist: attempt kill anyway (cleanup stale sessions)
   *
   * Step 2 used to be a single `send-keys '/exit' C-m` — the pre-#1471 shape.
   * Measured on opencode 1.18.21 (private tmux socket, 200x50): the batched
   * form does NOT exit. Typing `/` opens the command palette, and the `C-m`
   * that arrives in the same tmux command is consumed by the palette rather
   * than submitting, leaving `/exit` in the composer with the palette open —
   * still up 10.8 s later, 2 runs out of 2. A separate Enter from that state
   * exits in 0.34 s; typed-then-submitted from a clean composer it exits in
   * 0.445 / 0.456 / 0.458 s (n=3). Until now nothing noticed, because
   * `kill-session`'s route reached past this method into tmux (Issue #1905).
   *
   * `sendMessageWithSubmitVerification` is deliberately not reused here: it
   * reads the pane back to confirm the submit and THROWS when it cannot, which
   * for a command whose success condition is "the TUI is gone" would turn every
   * successful exit into an error.
   *
   * @param worktreeId - Worktree ID
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    const target = opencodeTarget(worktreeId, instanceId);

    // Issue #1933 S10: read the port BEFORE the release below drops it, because
    // the postcondition is about that number and the release is what forgets it.
    // Null whenever structured events are off or no port was ever allocated, and
    // then the health probe is skipped entirely — there is nothing to orphan.
    const assignedPort = getAssignedOpencodePort(target);

    // Issue #2038: the last moment the server that knows which session this
    // instance is in is still answering. Verified against opencode's own
    // `Session.directory` and followed up its `parentID` chain so a sub-agent's
    // turn cannot be mistaken for the operator's conversation — see
    // `@/lib/session/opencode-session-recall`. Never throws, and a skip costs
    // the next launch its `-s <id>`, never the kill.
    const captured = await captureOpencodeSessionMemory(target).catch(() => null);
    if (captured && !captured.captured) {
      logger.info('opencode-session-capture-skipped', {
        sessionName,
        reason: captured.skipped,
      });
    }

    // Issue #1763: stop watching before the pane goes, so the stream is not
    // reconnecting to a server that is being shut down. Also gives the port
    // back — the pane is what held it. Never throws.
    await releaseOpencodeEventStream(target);

    try {
      // Step 1: Check if the tmux session currently exists
      const exists = await hasSession(sessionName);
      if (exists) {
        // Step 2: Send /exit command for graceful TUI shutdown [D1-006].
        // Body and Enter are separate tmux commands (see the note above).
        await sendKeys(sessionName, OPENCODE_EXIT_COMMAND, false);
        await new Promise((resolve) => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));
        await sendSpecialKeys(sessionName, ['Enter']);

        // Step 3: Wait for OpenCode to process the exit command
        await new Promise((resolve) => setTimeout(resolve, OPENCODE_EXIT_WAIT_MS));

        // Step 4: check the postcondition, and force-kill when it is not met
        // (Issue #1933 S10, 方針書 §13.2). Two things have to be true and only
        // one of them was ever checked:
        //
        //   - the pane is gone. It was not, in the case this branch already
        //     handled; the reason token is `graceful_exit_timeout`.
        //   - the port this instance was allocated has stopped answering
        //     `/global/health`. opencode's TUI *is* an HTTP server once it is
        //     given `--port` (#1758 §5.1.2), and `ports.ts` hands the number to
        //     the next instance that asks. A server that outlives its pane
        //     therefore collects the NEXT instance's subscription, and that
        //     instance's events are filed against the wrong worktree with no
        //     error anywhere — `port_orphaned`.
        //
        // Both verdicts force-kill; the difference is what gets logged, because
        // an orphaned port is a number that must not be handed out again yet and
        // nothing else in the system can see that it happened.
        const verdict = await verifyGracefulExit({
          sessionAlive: () => hasSession(sessionName),
          portAnswering:
            assignedPort === null
              ? null
              : async () => (await fetchOpencodeHealth(assignedPort)) !== null,
        });

        if (!verdict.ok) {
          logger.warn('opencode-graceful-exit-postcondition-failed', {
            sessionName,
            reason: verdict.reason,
            ...(assignedPort !== null ? { port: assignedPort } : {}),
          });
          await killSession(sessionName);
        }
      } else {
        // Step 5: Session does not exist, attempt kill anyway (cleanup stale tmux sessions)
        await killSession(sessionName);
      }

      // Issue #405: Invalidate cache after session kill
      invalidateCache(sessionName);

      logger.info('stopped-opencode-session:sessionname');
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Abort the running turn: the server if there is one, Escape twice if not.
   *
   * ## The server route (Issue #2034)
   *
   * `POST /session/:id/abort` on the port this instance's TUI already serves,
   * against the session `./turn-gate` calls this instance's own. It ends the
   * turn outright — measured live on 1.18.22 with an isolated `opencode serve`:
   * `200 true`, and `session.error MessageAbortedError` + `session.idle` on the
   * stream in the same millisecond. The keystroke route below cannot claim that
   * unconditionally: it depends on what the TUI has drawn, and a picker or a
   * dialog on screen eats the presses.
   *
   * {@link abortOpencodeTurn} answers false for every way that can fail to
   * apply — no port, a subscription that is not live, no session known, a
   * refused request, a completion that never arrived — and then the Escapes go
   * out exactly as they did before. An instance launched with
   * `CM_AGENT_HOOKS_INJECT=0`, or on an opencode too old for `--port`, keeps
   * the interrupt it has always had.
   *
   * ## The keyboard route (Issue #1894)
   *
   * `BaseCLITool.interrupt()` sends ONE Escape, and on opencode 1.18 that
   * aborts nothing. The first press is a confirmation prompt drawn in the
   * footer -- `esc interrupt` becomes `esc again to interrupt` -- and only a
   * second press while that label is up ends the turn. Measured on opencode
   * 1.18.21 at the production 80x200 geometry, in a private tmux socket:
   *
   * - one Escape 4-6 s into a generation: the label flips, the generation
   *   continues, and the turn reaches a natural
   *   `▣  Build · GPT-5.6 Luna · 11.3s` / `· 16.3s` / `· 19.0s`. 3 runs, 3
   *   completions, 0 aborts. The default `interrupt()` has therefore never
   *   interrupted an opencode session, which is what {@link OpenCodeTool} used
   *   to claim it did [D2-008].
   * - two Escapes: the turn stops mid-sentence and the transcript marker reads
   *   `▣  Build · GPT-5.6 Luna · interrupted`. Confirmed twice -- once from a
   *   shell harness (594 ms apart) and once by calling THIS method against a
   *   live session, which took 317 ms end to end.
   *
   * The deadline is five seconds -- the label was sampled up from 0.31 s to
   * 4.71 s and reverted by 5.07 s -- and the wait is
   * {@link OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS}, which documents both
   * directions of that budget.
   *
   * `sendSpecialKey` twice with an awaited wait between, rather than
   * `sendSpecialKeys(name, ['Escape', 'Escape'])`: that helper's own
   * `SPECIAL_KEY_DELAY_MS` is a shared constant tuned for menu navigation, and
   * this gap is sized against a measured five-second deadline that has nothing
   * to do with menus. Keeping them separate means a future change to one cannot
   * silently move the other outside the window.
   *
   * Note that a turn ended this way leaves NO duration-carrying completion
   * marker on the pane (`· interrupted` is not `· 11.3s`), so
   * `OPENCODE_TURN_COMPLETE_PATTERN` does not match it and the session reaches
   * `ready` through the staleness fallback rather than through positive
   * evidence. That is the same treatment Issue #1893 deliberately gave an
   * aborted turn, and it is left alone here.
   *
   * @param worktreeId - Worktree ID
   * @param instanceId - Agent instance ID (defaults to the primary instance)
   */
  async interrupt(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    // Issue #2034: the server first, and the keyboard only if it did not apply.
    if (await abortOpencodeTurn(opencodeTarget(worktreeId, instanceId))) {
      // Issue #405: the turn is over, so the cached capture is stale — the same
      // reason the keystroke path invalidates below.
      invalidateCache(sessionName);
      logger.info('opencode-interrupt-aborted-via-api');
      return;
    }

    await sendSpecialKey(sessionName, 'Escape');
    await new Promise((resolve) =>
      setTimeout(resolve, OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS),
    );
    await sendSpecialKey(sessionName, 'Escape');

    // Issue #405: the pane changed (the turn is aborted), so the cached capture
    // is stale. `killSession` / `sendMessage` do the same after their keystrokes.
    invalidateCache(sessionName);

    logger.info('opencode-interrupt-sent');
  }
}
