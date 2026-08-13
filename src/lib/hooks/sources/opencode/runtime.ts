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
import { fetchOpencodeHealth } from './client';
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
 * Open the event stream for an instance whose pane has just started.
 *
 * Health-checked first, and this is not belt-and-braces: a user running an
 * opencode old enough not to accept `--port` gets a TUI with no server, and
 * subscribing to a port nothing is listening on would spend the rest of the
 * session reconnecting to it. One sub-millisecond probe (#1758 §5.7.2) is the
 * difference between "no structured events, scraper as before" and a reconnect
 * loop that never succeeds.
 *
 * @returns Whether a stream was opened
 */
export async function attachOpencodeEventStream(target: AgentInstanceRef): Promise<boolean> {
  try {
    const port = getAssignedOpencodePort(target);
    if (port === null) return false;
    if (isOpencodeSubscribed(target)) return true;

    const health = await fetchOpencodeHealth(port);
    if (!health) {
      logger.info('opencode-server-not-reachable', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
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
