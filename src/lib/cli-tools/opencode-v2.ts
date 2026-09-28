/**
 * OpenCode V2 (`opencode2`) CLI tool (Issue #2934, Epic #2370 Phase 1).
 *
 * A separate tool from `opencode` (v1), not a version branch of it: OpenCode
 * 2.0's server, event vocabulary and screen all differ, and v1 keeps every
 * behaviour it had (Epic #2370, decision 1).
 *
 * ## The pane
 *
 * One tmux pane holds both processes OpenCode V2 needs. The launch line runs
 * `scripts/opencode-v2/launch.sh`, which starts `opencode2 serve` on the
 * instance's own port with the instance's own password, waits for
 * `GET /openapi.json`, runs `opencode2 --server <url> <worktree>` in the
 * foreground, and — through a trap on EXIT / HUP / INT / TERM — stops the server
 * whichever way the TUI goes. So `/exit`, a crashed TUI and `tmux kill-session`
 * all release the port (the #1905 failure, prevented by construction), and a
 * CommandMate restart leaves both running because neither is CommandMate's
 * child.
 *
 * ## What is structured and what is read off the screen
 *
 *  - state (running / ready / waiting) comes from the server's SSE stream
 *    (`@/lib/hooks/sources/opencode-v2`), subscribed once the TUI is up;
 *  - sending goes through the TUI's composer via tmux, as for v1's fallback
 *    path (D6). `session.prompt` is not used: it addresses a session by id, and
 *    the TUI may be showing a different one;
 *  - the screen scraper still reads the pane, as every tool's fallback.
 *
 * Phase 2 adds approvals / questions / History, Phase 3 richer screen reading
 * and quick keys.
 *
 * @module lib/cli-tools/opencode-v2
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BaseCLITool } from './base';
import type { CLIToolType } from './types';
import {
  hasSession,
  createSession,
  capturePane,
  sendKeys,
  sendSpecialKeys,
  killSession,
  exactTarget,
  getSessionWorkingDirectory,
} from '../tmux/tmux';
import { isOpencodeV2ComposerVisible, stripAnsi } from '../detection/cli-patterns';
import { sendMessageWithSubmitVerification } from './submit-verified-sender';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { OPENCODE_PANE_HEIGHT, resolveOpencodePaneWidth } from '@/config/tmux-pane-config';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  attachOpencodeV2EventStream,
  opencodeV2Target,
  releaseOpencodeV2Server,
  reserveOpencodeV2Server,
  resumeOpencodeV2EventStream,
} from '@/lib/hooks/sources/opencode-v2/runtime';
import { probeOpencodeV2Server } from '@/lib/hooks/sources/opencode-v2/client';
import { getAssignedOpencodeV2Port } from '@/lib/hooks/sources/opencode-v2/ports';
import { isOpencodeV2Subscribed } from '@/lib/hooks/sources/opencode-v2/subscription';
import {
  OPENCODE_V2_CLI_TOOL_ID,
  OPENCODE_V2_COMMAND,
} from '@/lib/hooks/sources/opencode-v2/tool-id';
import { OPENCODE_V2_EXIT_COMMAND_TEXT, verifyGracefulExit } from './graceful-exit';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  OPENCODE_V2_EXIT_WAIT_MS,
  OPENCODE_V2_COMPOSER_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { missingToolError } from './install-hints';
import {
  parseOpencodeVersionOutput,
  resolveOpencodeV2Executable,
} from './opencode-executable';

const logger = createLogger('cli-tools/opencode-v2');

const execFileAsync = promisify(execFile);

/** Interval between composer polls (launch and send). */
export const OPENCODE_V2_READY_POLL_INTERVAL_MS = 500;

/** Composer polls after the launch line before giving up (30 s at 500 ms). */
export const OPENCODE_V2_READY_MAX_ATTEMPTS = 60;

/** Rows captured when looking for the composer. The pane is 200 rows tall. */
const OPENCODE_V2_READY_CAPTURE_LINES = OPENCODE_PANE_HEIGHT;

/**
 * How long a failed lazy resume is not retried (ms). `isRunning` is polled, and
 * a server that is really gone must not be probed on every poll.
 */
export const OPENCODE_V2_RESUME_RETRY_MS = 30_000;

/**
 * The version `opencode2 --version` reports, or null when the output is not
 * OpenCode V2's. Issue #2939: the same rule OpenCode 1.x is told apart by
 * (`./opencode-executable`), so `1.18.33` is not V2 and `opencode v2.0.18` is.
 */
export function parseOpencodeV2Version(output: string): string | null {
  const info = parseOpencodeVersionOutput(output);
  return info?.generation === 'v2' ? info.version : null;
}

/** A bare `/<name>`: a slash command with no argument and no whitespace at all. */
const BARE_SLASH_COMMAND = /^\/\S+$/;

/**
 * The text to type for `message` (Issue #2950).
 *
 * The TUI opens its command dropdown on any composer text starting with `/`,
 * and while it is open Enter picks a row instead of submitting — so a bare
 * `/probe-agentsskills` sits in the composer ("No matching commands") and runs
 * nothing, while `/probe-agentsskills ` (one trailing space) closes the
 * dropdown and runs. The palette already inserts `` `${trigger} ` `` (see
 * `loadOpencodeSkills` in `@/lib/slash-commands`, "The trailing space is
 * load-bearing"), but the send route trims the body, so the space never
 * arrives. It is put back here, and only for a bare `/<name>`: a command with
 * an argument already has a space after the name, and ordinary text does not
 * open the dropdown.
 */
export function toOpencodeV2ComposerText(message: string): string {
  return BARE_SLASH_COMMAND.test(message) ? `${message} ` : message;
}

export class OpenCodeV2Tool extends BaseCLITool {
  readonly id: CLIToolType = OPENCODE_V2_CLI_TOOL_ID;
  readonly name = 'OpenCode V2';
  readonly command = OPENCODE_V2_COMMAND;

  /** Last lazy-resume attempt per session name, for {@link OPENCODE_V2_RESUME_RETRY_MS}. */
  private readonly resumeAttemptedAt = new Map<string, number>();

  /**
   * Installed means an executable that identifies itself as OpenCode V2
   * (`opencode v<semver>`, D1): `opencode2`, or — Issue #2939 — an `opencode`
   * that answers as V2, for an operator who has V2 under that name only.
   */
  async isInstalled(): Promise<boolean> {
    return (await resolveOpencodeV2Executable()).executable !== null;
  }

  /**
   * Whether the instance's tmux session exists.
   *
   * A live session this process holds no subscription for — a pane that
   * outlived a CommandMate restart — gets its event stream back here, fire and
   * forget and at most every {@link OPENCODE_V2_RESUME_RETRY_MS}, so status
   * comes from the server again as soon as anything polls the pane.
   */
  async isRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    const running = await hasSession(sessionName);
    if (running) this.resumeInBackground(worktreeId, sessionName, instanceId);
    return running;
  }

  private resumeInBackground(worktreeId: string, sessionName: string, instanceId?: string): void {
    const target = opencodeV2Target(worktreeId, instanceId);
    if (isOpencodeV2Subscribed(target)) return;
    const now = Date.now();
    const last = this.resumeAttemptedAt.get(sessionName);
    if (last !== undefined && now - last < OPENCODE_V2_RESUME_RETRY_MS) return;
    this.resumeAttemptedAt.set(sessionName, now);
    void (async () => {
      try {
        const worktreePath = await getSessionWorkingDirectory(sessionName);
        if (worktreePath === null) return;
        await resumeOpencodeV2EventStream(target, worktreePath);
      } catch (error: unknown) {
        logger.debug('opencode-v2-lazy-resume-failed', { error: getErrorMessage(error) });
      }
    })();
  }

  protected async launchSession(
    worktreeId: string,
    worktreePath: string,
    instanceId?: string
  ): Promise<void> {
    // Issue #2939: the file that answered as V2 is the file the line runs.
    const executable = (await resolveOpencodeV2Executable()).executable;
    if (!executable) {
      throw missingToolError(this);
    }

    const sessionName = this.getSessionName(worktreeId, instanceId);
    const target = opencodeV2Target(worktreeId, instanceId);
    const geometry = { windowWidth: resolveOpencodePaneWidth(), windowHeight: OPENCODE_PANE_HEIGHT };

    const exists = await hasSession(sessionName);
    if (exists) {
      await this.reconcileExistingSession(sessionName, worktreePath, geometry);
      if (await this.isToolLive(sessionName, { confirm: true })) {
        await resumeOpencodeV2EventStream(target, worktreePath);
        logger.info('opencode-v2-session-exists');
        return;
      }
      logger.warn('opencode-v2-session-relaunch', { sessionName });
      // The pane is back at its shell, so whatever it held is gone with it.
      await releaseOpencodeV2Server(target);
    }

    beginAgentSession(target);

    try {
      if (!exists) {
        await createSession({ sessionName, workingDirectory: worktreePath });
        await new Promise((resolve) => setTimeout(resolve, TUI_SESSION_CREATE_WAIT_MS));
      }

      try {
        await execFileAsync('tmux', [
          'resize-window', '-t', exactTarget(sessionName),
          '-x', String(geometry.windowWidth), '-y', String(geometry.windowHeight),
        ]);
      } catch {
        // Non-fatal, as for v1: the TUI still starts at whatever size it gets.
      }

      // Port and password first: the launch line is built from both.
      const port = await reserveOpencodeV2Server(target, worktreePath);
      if (port === null) {
        logger.warn('opencode-v2-launch-without-server', { worktreeId, instanceId });
      }

      await sendKeys(
        sessionName,
        buildAgentLaunchCommandLine({ target, executablePath: executable.path, worktreePath }),
        true
      );

      await this.waitForReady(sessionName);
      await attachOpencodeV2EventStream(target);
      logger.info('started-opencode-v2-session');
    } catch (error: unknown) {
      throw new Error(`Failed to start OpenCode V2 session: ${getErrorMessage(error)}`);
    }
  }

  /** Poll until the composer is on screen (or give up quietly). */
  private async waitForReady(sessionName: string): Promise<boolean> {
    for (let attempt = 0; attempt < OPENCODE_V2_READY_MAX_ATTEMPTS; attempt++) {
      try {
        const output = stripAnsi(await capturePane(sessionName, OPENCODE_V2_READY_CAPTURE_LINES));
        if (isOpencodeV2ComposerVisible(output)) {
          logger.info('opencode-v2-composer-detected', { attempt });
          return true;
        }
      } catch {
        // The pane may not be readable yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_V2_READY_POLL_INTERVAL_MS));
    }
    logger.info('opencode-v2-ready-detection-timeout');
    return false;
  }

  /**
   * Wait for the composer before typing into it (D6).
   *
   * @throws When it does not appear within {@link OPENCODE_V2_COMPOSER_WAIT_MS}
   */
  private async waitForComposer(sessionName: string): Promise<void> {
    const deadline = Date.now() + OPENCODE_V2_COMPOSER_WAIT_MS;
    for (;;) {
      try {
        const output = stripAnsi(await capturePane(sessionName, OPENCODE_V2_READY_CAPTURE_LINES));
        if (isOpencodeV2ComposerVisible(output)) return;
      } catch {
        // Treated as "not yet".
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_V2_READY_POLL_INTERVAL_MS));
    }
    throw new Error('OpenCode V2 composer not ready: timed out waiting for it before sending');
  }

  async sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);

    if (!(await hasSession(sessionName))) {
      throw new Error(
        `OpenCode V2 session ${sessionName} does not exist. Start the session first.`
      );
    }

    await this.relaunchIfToolExited(worktreeId, instanceId);

    try {
      await this.waitForComposer(sessionName);
      await sendMessageWithSubmitVerification({
        sessionName,
        message: toOpencodeV2ComposerText(message),
        cliToolId: OPENCODE_V2_CLI_TOOL_ID,
        composer: this.describeComposer(),
      });
      invalidateCache(sessionName);
      logger.info('sent-message-to-opencode-v2-session');
    } catch (error: unknown) {
      throw new Error(`Failed to send message to OpenCode V2: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Stop the TUI and, through the wrapper's trap, its server.
   *
   * `/exit` and a separate Enter first (the declared graceful sequence), then
   * the postcondition: the session gone AND the port no longer answering. If
   * either fails the session is killed — the SIGHUP reaches the wrapper, whose
   * trap stops the server. Everything the instance held (subscription, port,
   * password file) is released at the end.
   */
  async killSession(worktreeId: string, instanceId?: string): Promise<void> {
    const sessionName = this.getSessionName(worktreeId, instanceId);
    const target = opencodeV2Target(worktreeId, instanceId);
    const port = getAssignedOpencodeV2Port(target);

    try {
      if (await hasSession(sessionName)) {
        await sendKeys(sessionName, OPENCODE_V2_EXIT_COMMAND_TEXT, false);
        await new Promise((resolve) => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));
        await sendSpecialKeys(sessionName, ['Enter']);
        await new Promise((resolve) => setTimeout(resolve, OPENCODE_V2_EXIT_WAIT_MS));

        const verdict = await verifyGracefulExit({
          sessionAlive: () => hasSession(sessionName),
          portAnswering:
            port === null
              ? null
              : async () => (await probeOpencodeV2Server(port, '')).kind !== 'unreachable',
        });
        if (!verdict.ok) {
          logger.info('opencode-v2-graceful-exit-postcondition-unmet', {
            sessionName,
            reason: verdict.reason,
            ...(port !== null ? { port } : {}),
          });
          await killSession(sessionName);
        }
      } else {
        await killSession(sessionName);
      }
      invalidateCache(sessionName);
      this.resumeAttemptedAt.delete(sessionName);
      logger.info('stopped-opencode-v2-session');
    } catch (error: unknown) {
      logger.error('session:stop-failed', { error: getErrorMessage(error) });
      throw error;
    } finally {
      await releaseOpencodeV2Server(target);
    }
  }
}
