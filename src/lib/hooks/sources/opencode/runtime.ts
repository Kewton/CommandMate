/**
 * The three calls `OpenCodeTool` makes (Issue #1763).
 *
 * `src/lib/cli-tools/opencode.ts` owns the tmux pane; this module owns the
 * event stream that runs beside it. Keeping them apart is what stops the
 * launcher from importing the database, the adjudicator and the SSE client:
 * `../registry` statically imports `./source`, so anything `./source` reaches
 * is reached by every import of `@/lib/hooks/sources`, and the wiring below is
 * the only place that pulls `./ingest` in.
 *
 * ## The lifecycle, and what it deliberately does not include
 *
 * There is **no server process to manage**. Issue #1763's text asked for
 * "serve process lifecycle management — start, port allocation, stop, orphan
 * reaping", and #1758 §5.1.2 measured that away: the plain TUI is the server
 * when it is given `--port`, so the server starts when the pane starts, dies
 * when the pane dies, and cannot be orphaned. What is left is a port to choose
 * and a connection to hold.
 *
 * Every function here is fail-open. Structured events are an enhancement to a
 * session that has to start anyway, so a port that cannot be allocated, a
 * server that does not answer and a stream that will not open all end the same
 * way: the pane runs, the screen scraper decides, and CommandMate behaves
 * exactly as it did before this Issue.
 *
 * @module lib/hooks/sources/opencode/runtime
 */

import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';
import { probeOpencodeHealth, type OpencodeHealth } from './client';
import { ingestOpencodeEvent } from './ingest';
import {
  allocateOpencodePort,
  forgetOpencodePort,
  getAssignedOpencodePort,
  recoverOpencodePort,
} from './ports';
import { opencodeAgentEventSource } from './source';
import { closeOpencodeSubscription, isOpencodeSubscribed } from './subscription';

const logger = createLogger('lib/hooks/sources/opencode/runtime');

/** The instance ref for one worktree's opencode instance. */
export function opencodeTarget(worktreeId: string, instanceId?: string): AgentInstanceRef {
  return { worktreeId, cliToolId: 'opencode', instanceId };
}

/**
 * Choose the port the TUI will serve on.
 *
 * Must run before the launch command is built: `prepareLaunch` is synchronous
 * and reads the assignment. Returns null when there will be no server — the
 * caller launches bare and skips {@link attachOpencodeEventStream}.
 *
 * @param target - The instance about to be created
 * @param worktreePath - Recorded so a later recovery can verify the entry
 */
export async function reserveOpencodeServerPort(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<number | null> {
  try {
    return await allocateOpencodePort(target, worktreePath);
  } catch (error) {
    logger.warn('opencode-port-reserve-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * How long to keep asking `/global/health` before giving up on the attach.
 *
 * Delays *before* each attempt, so the first costs nothing: five probes over
 * 7.5 s. Issue #1900 item 4 — the check used to be one shot, and one shot is a
 * decision that lasts the whole session, because nothing re-attaches a pane
 * that is already running. #1908 measured that opencode's HTTP server answers
 * 1.3-1.8 s *before* the composer this call waits for, so the ordinary path
 * still succeeds on the first probe; the retries are for the pane whose
 * composer poll timed out (24.1 s launches under load were measured) and which
 * would otherwise be scraper-only for the rest of its life.
 *
 * A short ceiling on purpose: this sits inside the HTTP request that started
 * the session, and every second here is a second the caller is blocked.
 */
export const OPENCODE_ATTACH_HEALTH_DELAYS_MS: readonly number[] = [0, 500, 1_000, 2_000, 4_000];

/**
 * Probe until an opencode server answers, or until asking again cannot help.
 *
 * A `rejected` outcome ends the loop immediately: something *is* on the port and
 * it is refusing CommandMate — `OPENCODE_SERVER_PASSWORD` in the pane's
 * environment makes every request a 401 — and 7.5 s of re-asking would only
 * delay the fall back to the scraper. It is logged with its status so the cause
 * is visible rather than collapsed into "not reachable".
 */
async function awaitOpencodeHealth(
  target: AgentInstanceRef,
  port: number
): Promise<OpencodeHealth | null> {
  for (const [attempt, waitMs] of OPENCODE_ATTACH_HEALTH_DELAYS_MS.entries()) {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const outcome = await probeOpencodeHealth(port);
    if (outcome.kind === 'healthy') {
      if (attempt > 0) {
        logger.info('opencode-server-reachable-after-retry', {
          worktreeId: target.worktreeId,
          instanceId: target.instanceId ?? target.cliToolId,
          port,
          attempt,
        });
      }
      return outcome.health;
    }
    if (outcome.kind === 'rejected') {
      logger.warn('opencode-server-refused-commandmate', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
        status: outcome.status,
        consequence: 'structured events are off for this session; the scraper decides',
      });
      return null;
    }
  }
  return null;
}

/**
 * Open the event stream for an instance whose pane has just started.
 *
 * Health-checked first, and this is not belt-and-braces: a user running an
 * opencode old enough not to accept `--port` gets a TUI with no server, and
 * subscribing to a port nothing is listening on would spend the rest of the
 * session reconnecting to it. Probes are sub-millisecond when the port is
 * closed (#1758 §5.7.2), which is what makes
 * {@link OPENCODE_ATTACH_HEALTH_DELAYS_MS} affordable: the difference between
 * "no structured events, scraper as before" and a reconnect loop that never
 * succeeds is still one probe, it is just no longer *only* one.
 *
 * @returns Whether a stream was opened
 */
export async function attachOpencodeEventStream(target: AgentInstanceRef): Promise<boolean> {
  try {
    const port = getAssignedOpencodePort(target);
    if (port === null) return false;
    if (isOpencodeSubscribed(target)) return true;

    const health = await awaitOpencodeHealth(target, port);
    if (!health) {
      logger.info('opencode-server-not-reachable', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
        attempts: OPENCODE_ATTACH_HEALTH_DELAYS_MS.length,
      });
      return false;
    }

    await opencodeAgentEventSource.subscribe(target, (event) => {
      void ingestOpencodeEvent(target, event);
    });
    logger.info('opencode-event-stream-attached', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port,
      version: health.version,
    });
    return true;
  } catch (error) {
    logger.warn('opencode-event-stream-attach-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Re-open the stream for an instance whose pane outlived this process.
 *
 * The CommandMate-restart path, and the reuse branch of `startSession`. The
 * port comes from the persisted assignment rather than from a fresh scan, so a
 * hash collision cannot make one instance adopt another's server — see
 * `./ports`.
 *
 * @returns Whether a stream was opened
 */
export async function resumeOpencodeEventStream(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<boolean> {
  try {
    if (isOpencodeSubscribed(target)) return true;
    const port = await recoverOpencodePort(target, worktreePath);
    if (port === null) return false;
    return await attachOpencodeEventStream(target);
  } catch (error) {
    logger.warn('opencode-event-stream-resume-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Stop watching an instance and give its port back.
 *
 * Called from `killSession`. The port is released here rather than on a timer
 * because the pane is what held it, and the pane is gone.
 */
export async function releaseOpencodeEventStream(target: AgentInstanceRef): Promise<void> {
  try {
    await closeOpencodeSubscription(target);
    forgetOpencodePort(target);
  } catch (error) {
    logger.warn('opencode-event-stream-release-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
