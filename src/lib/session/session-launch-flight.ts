/**
 * One launch per session at a time (Issue #3981).
 *
 * Two requests could start the same session at once. A (a send to an instance
 * that is not running) creates the pane and is about to type the launch line;
 * B arrives in that window. For seven tools `isRunning` is `has-session`, so B
 * read "running" and went on to type its body into the pane's shell; for claude
 * `isRunning` also checks health, so on an unhealthy-looking pane (empty, `%`)
 * B started the session too and the reuse branch killed A's half-launched pane.
 * Nothing said "this session is already being started".
 *
 * This module is that fact, keyed by tmux session name, and the order it has to
 * be taken in relative to the instance input lock (`./instance-input-lock`):
 *
 * - **The flight is outside, the lock inside.** A launch types its lines in one
 *   `exclusive` turn of the lock (`typeLaunchLines`), and its init polls and
 *   readiness waits run outside it (#3975). A naive "wait for the launch" would
 *   let a send that holds the lock wait for a launch that is waiting for the
 *   lock — a cycle that ends only at `INSTANCE_INPUT_LOCK_WAIT_MS`.
 * - **R1: a lock holder never waits for another request's launch.** It gets
 *   {@link SessionLaunchInFlightError} (`SESSION_STARTING`, nothing typed)
 *   instead, and the launch types once the holder lets go.
 * - **R2: the launch's own keys join a lock the launcher already holds** (codex
 *   relaunching inside a send): the lock's `AsyncLocalStorage`, which a launch
 *   started here inherits.
 * - **R4: the launch is registered before anything is read.** {@link
 *   runSessionLaunch} records it synchronously, before the tool's `hasSession`,
 *   its health check or claude's reuse-branch kill run; `POST /send` and
 *   `requireSession` look here before they read `isRunning`.
 *
 * In memory and on `globalThis` for the reason the lock is: the routes that
 * start sessions are separate bundles under `next dev`.
 *
 * @module lib/session/session-launch-flight
 */

import { getOrInitGlobal } from '@/lib/global-state';
import { createLogger } from '@/lib/logger';
import { currentInstanceInputTicket } from '@/lib/session/instance-input-lock';
import { SessionStartTimeoutError } from '@/lib/session/session-start-error';

const logger = createLogger('session/session-launch-flight');

declare global {
  // eslint-disable-next-line no-var
  var __sessionLaunchFlights: Map<string, Promise<void>> | undefined;
}

const flights = getOrInitGlobal('__sessionLaunchFlights', () => new Map<string, Promise<void>>());

/**
 * Another request is starting this session, and the caller holds its input lock
 * (R1). Nothing was typed; retrying after the launch is the whole remedy.
 *
 * A {@link SessionStartTimeoutError}, so every reader of `SESSION_STARTING`
 * (the send service, the route's 503, `classifySendFailure`) answers it as the
 * slow start it is.
 */
export class SessionLaunchInFlightError extends SessionStartTimeoutError {
  constructor(toolName: string, sessionName: string) {
    super(toolName, sessionName, 0);
    this.message =
      `${toolName} is being started by another request (tmux session '${sessionName}'), ` +
      'and this send holds its input, so it did not wait for that launch — the message was ' +
      'not delivered and nothing was typed. Retry the send in a few seconds.';
    this.name = 'SessionLaunchInFlightError';
  }
}

/** Whether a launch of `sessionName` is in progress in this process. */
export function isSessionLaunchInFlight(sessionName: string): boolean {
  return flights.has(sessionName);
}

/**
 * Run `launch` as `sessionName`'s only launch.
 *
 * When one is already in progress, the caller joins it (same promise, same
 * outcome) instead of starting a second — unless the caller holds the
 * session's input lock, which is refused at once (R1). Registration happens in
 * the same synchronous step as the check, before `launch` reads anything (R4).
 *
 * @throws SessionLaunchInFlightError when another launch is in progress and the caller holds the input lock
 */
export function runSessionLaunch(
  sessionName: string,
  toolName: string,
  launch: () => Promise<void>
): Promise<void> {
  const inFlight = flights.get(sessionName);
  if (inFlight !== undefined) {
    if (currentInstanceInputTicket(sessionName) !== null) {
      logger.info('session-launch-in-flight-refused', { sessionName });
      return Promise.reject(new SessionLaunchInFlightError(toolName, sessionName));
    }
    logger.info('session-launch-joined', { sessionName });
    return inFlight;
  }
  // The entry is in the map before `launch` runs a single line. Called in the
  // caller's async context, so a launcher that holds the lock still owns it
  // inside the launch (R2).
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const flight = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  flights.set(sessionName, flight);
  const clear = (): void => {
    if (flights.get(sessionName) === flight) flights.delete(sessionName);
  };
  flight.then(clear, clear);
  let running: Promise<void>;
  try {
    running = launch();
  } catch (error: unknown) {
    running = Promise.reject(error);
  }
  running.then(settle.resolve, settle.reject);
  return flight;
}

/**
 * The session was killed: a launch still running against it is not one a new
 * start may join (Issue #3195's case — a launch killed mid-way keeps running
 * until its readiness wait runs out). The killed launch's own end then leaves
 * a successor's entry alone.
 */
export function forgetSessionLaunch(sessionName: string): void {
  flights.delete(sessionName);
}

/**
 * Wait out a launch of `sessionName` another request has in progress, before
 * reading whether the session is running (R4). Its outcome is not the caller's:
 * a launch that failed is left for the caller's own check to find.
 *
 * @returns Whether there was a launch to wait for
 * @throws SessionLaunchInFlightError when there is one and the caller holds the input lock (R1)
 */
export async function settleSessionLaunch(sessionName: string, toolName: string): Promise<boolean> {
  const inFlight = flights.get(sessionName);
  if (inFlight === undefined) return false;
  if (currentInstanceInputTicket(sessionName) !== null) {
    logger.info('session-launch-in-flight-refused', { sessionName });
    throw new SessionLaunchInFlightError(toolName, sessionName);
  }
  await inFlight.catch(() => undefined);
  return true;
}

/** Forget every launch in progress. Test-only. */
export function resetSessionLaunchFlightsForTest(): void {
  flights.clear();
}
