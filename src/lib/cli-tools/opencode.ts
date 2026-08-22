/**
 * OpenCode CLI tool implementation
 * Issue #379: Provides integration with OpenCode TUI in interactive mode
 *
 * @remarks Follows the same tmux-based pattern as Claude/Codex/Gemini/VibeLocal tools.
 * - startSession: launches `opencode` TUI in tmux
 * - sendMessage: sends text via tmux send-keys + Enter
 * - killSession: types `/exit` + a separate Enter, then falls back to tmux kill-session
 * - interrupt(): Escape TWICE, 300 ms apart -- one press does not abort (Issue #1894)
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
import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@/lib/logger';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  attachOpencodeEventStream,
  opencodeTarget,
  releaseOpencodeEventStream,
  reserveOpencodeServerPort,
  resumeOpencodeEventStream,
} from '@/lib/hooks/sources/opencode/runtime';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  OPENCODE_EXIT_WAIT_MS,
  OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS,
} from '@/config/cli-tool-timing-config';

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
 * OpenCode CLI tool implementation
 * Manages OpenCode interactive sessions using tmux
 */
export class OpenCodeTool extends BaseCLITool {
  readonly id: CLIToolType = 'opencode';
  readonly name = 'OpenCode';
  readonly command = 'opencode';

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
  async startSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    const opencodeAvailable = await this.isInstalled();
    if (!opencodeAvailable) {
      throw new Error('OpenCode is not installed or not in PATH');
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);

    const target = opencodeTarget(worktreeId, instanceId);

    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName, {
        windowWidth: 80,
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

      // Resize tmux window to 80 columns (hide sidebar for clean capture-pane output)
      // [SEC-001] Uses execFile (not exec) to prevent shell meta-character injection via sessionName
      try {
        await execFileAsync('tmux', [
          // Issue #1156: exact-match target so resize never leaks to a prefix-colliding instance
          'resize-window', '-t', exactTarget(sessionName),
          '-x', '80', '-y', String(OPENCODE_PANE_HEIGHT),
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
      const launchCommand = buildAgentLaunchCommandLine({
        target,
        executablePath: this.command,
        worktreePath,
      });
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
   * Send a message to OpenCode interactive session
   * [D1-004] Same pattern as Codex/Gemini/VibeLocal (future Template Method candidate)
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

    try {
      // Issue #1471: Body/Enter separation + read-back submit verification via the
      // shared helper (replaces the old type -> C-m -> `\n`-gated paste recovery).
      await sendMessageWithSubmitVerification({
        sessionName,
        message,
        cliToolId: 'opencode',
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

    // Issue #1763: stop watching before the pane goes, so the stream is not
    // reconnecting to a server that is being shut down. Also gives the port
    // back — the pane is what held it. Never throws.
    await releaseOpencodeEventStream(opencodeTarget(worktreeId, instanceId));

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

        // Step 4: Check if session still exists; force-kill if needed [D1-007]
        const stillExists = await hasSession(sessionName);
        if (stillExists) {
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
   * Abort the running turn: Escape, wait, Escape (Issue #1894).
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
