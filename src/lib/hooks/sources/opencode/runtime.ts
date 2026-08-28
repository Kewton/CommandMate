/**
 * The calls `OpenCodeTool` makes into the event pipeline (Issue #1763).
 *
 * `src/lib/cli-tools/opencode.ts` owns the tmux pane; this module owns the
 * event stream that runs beside it. Keeping them apart is what stops the
 * launcher from importing the database, the adjudicator and the SSE client:
 * `../registry` statically imports `./source`, so anything `./source` reaches
 * is reached by every import of `@/lib/hooks/sources`, and the wiring below is
 * the only place that pulls `./ingest` in.
 *
 * Three of them are the lifecycle below. The fourth is {@link abortOpencodeTurn},
 * which is not lifecycle at all: it is the interrupt path taking the server
 * route when there is one (Issue #2034), and it fails open to the keyboard the
 * same way everything else here fails open to the scraper.
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
import { abortOpencodeSession, probeOpencodeHealth, type OpencodeHealth } from './client';
import { ingestOpencodeEvent } from './ingest';
import {
  allocateOpencodePort,
  forgetOpencodePort,
  getAssignedOpencodePort,
  recoverOpencodePort,
} from './ports';
import { opencodeAgentEventSource } from './source';
import {
  closeOpencodeSubscription,
  getOpencodeLiveness,
  getOpencodePrimarySession,
  isOpencodeSubscribed,
  recordOpencodeProbedActivity,
  watchOpencodeSessionIdle,
} from './subscription';

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
    const activity = await probeAttachedActivity(target);
    logger.info('opencode-event-stream-attached', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port,
      version: health.version,
      activity,
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
 * Re-read whether the conversation is working, right after a stream attaches
 * (Issue #2054).
 *
 * **The first production caller of `AgentEventSource.probeActivity`.** The
 * method has existed since Phase 4-1 (#1759) with nothing but its own definition
 * reading it, and this is the gap it was written for: a stream that opens in the
 * middle of a turn delivers its first frame when that turn *ends*, so between
 * {@link attachOpencodeEventStream} and the next `session.idle` — which on a
 * long turn is minutes — CommandMate has no answer to "is this pane working
 * right now?" except the screen. `GET /session/status` has the answer and this
 * is the one call that asks it.
 *
 * Deliberately **through the source interface** rather than through
 * `client.fetchOpencodeActivity`, which this module could import directly. Three
 * call sites already read `getOpencodeLiveness` directly and Issue #2054's
 * instruction was not to add a fourth of anything; going through the registered
 * source also means the port lookup, the "no port assigned" null and the request
 * timeout are the source's business rather than a second copy of them here.
 *
 * Not the same read as `subscription.recoverTurnState`, and it does not replace
 * it: that one is per *session* and re-arms the turn gate, this one is the
 * instance-level aggregate the surfaces can render. Both go through the single
 * reader in `./client`.
 *
 * Never throws and never blocks the attach for long — one loopback request
 * against a server whose health probe has just succeeded, capped by
 * `OPENCODE_REQUEST_TIMEOUT_MS`.
 *
 * @param target - The instance whose stream has just been attached
 * @returns The answer, or null when the source could not be asked
 */
async function probeAttachedActivity(
  target: AgentInstanceRef
): Promise<'busy' | 'idle' | null> {
  let activity: 'busy' | 'idle' | null = null;
  try {
    activity = await opencodeAgentEventSource.probeActivity(target);
  } catch (error) {
    // A probe that throws is a probe that did not answer, which is what null
    // already means. The attach itself succeeded and must not be undone by it.
    logger.debug('opencode-activity-probe-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  recordOpencodeProbedActivity(target, activity, Date.now());
  return activity;
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
 * How long to wait for the `session.idle` that confirms an abort (Issue #2034).
 *
 * Two seconds against a measured latency of roughly zero: on 1.18.22 the first
 * `session.idle` was emitted in the same millisecond as the abort's `200 true`
 * reply, and #1758 §5.3.2 measured the same on 1.18.3. The budget is not sized
 * for the ordinary case, it is the point at which "the server took my request"
 * stops being evidence that the turn ended — and it is spent inside the HTTP
 * request the Interrupt button is waiting on, so it cannot be generous.
 *
 * Only the *failure* path pays it: a confirmed abort resolves as soon as the
 * frame lands.
 */
export const OPENCODE_ABORT_IDLE_TIMEOUT_MS = 2_000;

/**
 * End the running turn through the server, if there is a server (Issue #2034).
 *
 * The primary path for `OpenCodeTool.interrupt`. `POST /session/:id/abort`
 * ends the turn outright, where the keyboard route depends on the TUI's own
 * draw state — two Escapes inside a five-second footer label (#1894) that a
 * picker or a dialog on screen can swallow.
 *
 * **Every no is the same no.** No port assigned, a subscription that is not
 * live, no session the gate calls this instance's, a request that was refused,
 * a completion that never arrived: all of them answer `false`, and the caller
 * presses Escape twice exactly as it did before this Issue. That is the whole
 * safety property — an instance launched with `CM_AGENT_HOOKS_INJECT=0`, or on
 * an opencode too old for `--port`, must not become an instance that cannot be
 * interrupted. Nothing here throws, for the same reason.
 *
 * The order matters and is measured: the watch is armed **before** the request
 * goes out, because the idle can be on the wire before the reply is
 * (see {@link watchOpencodeSessionIdle}).
 *
 * @param target - The instance whose turn should stop
 * @returns Whether the turn was aborted *and* confirmed idle
 */
export async function abortOpencodeTurn(target: AgentInstanceRef): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const port = getAssignedOpencodePort(target);
    if (port === null) return false;

    const liveness = getOpencodeLiveness(target);
    if (liveness.state !== 'live') {
      logger.info('opencode-abort-skipped-not-live', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        liveness: liveness.state,
      });
      return false;
    }

    const sessionId = getOpencodePrimarySession(target);
    if (sessionId === null) {
      logger.info('opencode-abort-skipped-no-session', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
      });
      return false;
    }

    const watch = watchOpencodeSessionIdle(target, sessionId, OPENCODE_ABORT_IDLE_TIMEOUT_MS);
    const accepted = await abortOpencodeSession(port, sessionId);
    if (!accepted) {
      watch.cancel();
      logger.warn('opencode-abort-rejected', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        sessionId,
      });
      return false;
    }

    const confirmed = await watch.seen;
    if (!confirmed) {
      // The server said yes and the turn did not end within the budget. Saying
      // so out loud rather than reporting a success: the caller falls back to
      // the keystrokes, and an operator seeing this repeatedly is looking at a
      // server that accepts aborts it does not act on.
      logger.warn('opencode-abort-unconfirmed', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        sessionId,
        timeoutMs: OPENCODE_ABORT_IDLE_TIMEOUT_MS,
      });
      return false;
    }

    logger.info('opencode-abort-confirmed', {
      worktreeId: target.worktreeId,
      instanceId,
      port,
      sessionId,
    });
    return true;
  } catch (error) {
    logger.warn('opencode-abort-failed', {
      worktreeId: target.worktreeId,
      instanceId,
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
