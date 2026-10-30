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
 * - **A wait has a bound** (review P3-1): a caller that joins or waits out
 *   another request's launch gives up at the launch's own start budget
 *   (`getSessionStartingMaxMs`, counted from when the launch began) with
 *   {@link SessionLaunchWaitTimeoutError} (`SESSION_STARTING`, nothing typed),
 *   so a launch that stops returning does not hang every send to its session.
 * - **A model is not dropped on a join** (review P3-2): a start that asks for
 *   a model the launch in progress is not starting with gets {@link
 *   SessionLaunchModelMismatchError}, as a `--model` to a running session
 *   gets a 400 (#989 / #2771), instead of joining and running on another model.
 *
 * In memory and on `globalThis` for the reason the lock is: the routes that
 * start sessions are separate bundles under `next dev`.
 *
 * @module lib/session/session-launch-flight
 */

import { getOrInitGlobal } from '@/lib/global-state';
import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getSessionStartingMaxMs, getSessionStartingMaxMsAcrossTools } from '@/config/session-starting-config';
import { currentInstanceInputTicket } from '@/lib/session/instance-input-lock';
import { SessionStartTimeoutError } from '@/lib/session/session-start-error';

const logger = createLogger('session/session-launch-flight');

/** One launch in progress. */
interface SessionLaunchFlight {
  promise: Promise<void>;
  /** Epoch ms the launch began; a wait for it ends at this plus its budget. */
  startedAt: number;
  /** The tool launched, for its start budget; unknown → the longest of all tools'. */
  cliToolId?: CLIToolType;
  /** The model the launch was asked for; undefined → the tool's default. */
  model?: string;
}

/** What a launch is, beyond its session name. */
export interface SessionLaunchOptions {
  cliToolId?: CLIToolType;
  model?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __sessionLaunchFlights: Map<string, SessionLaunchFlight> | undefined;
}

const flights = getOrInitGlobal('__sessionLaunchFlights', () => new Map<string, SessionLaunchFlight>());

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

/**
 * Another request's launch of this session did not finish within its start
 * budget, and this caller stopped waiting for it (review P3-1). Nothing was
 * typed; the launch is left running.
 */
export class SessionLaunchWaitTimeoutError extends SessionStartTimeoutError {
  constructor(toolName: string, sessionName: string, timeoutMs: number) {
    super(toolName, sessionName, timeoutMs);
    this.message =
      `${toolName} is being started by another request (tmux session '${sessionName}'), and that ` +
      `launch did not finish within ${Math.round(timeoutMs / 1000)}s — the message was not ` +
      'delivered and nothing was typed. Retry the send in a few seconds, or run ' +
      '`commandmate capture <worktree-id>` to see what the launch is waiting on.';
    this.name = 'SessionLaunchWaitTimeoutError';
  }
}

/** Code of {@link SessionLaunchModelMismatchError}. */
export const SESSION_LAUNCH_MODEL_MISMATCH_CODE = 'SESSION_LAUNCH_MODEL_MISMATCH';

/**
 * A start asked for a model, and the launch of the session already in
 * progress is starting with another (review P3-2). Nothing was typed. The
 * model is fixed when the process starts (#989 / #2771), so joining would
 * silently run the request on the other model.
 */
export class SessionLaunchModelMismatchError extends Error {
  readonly code = SESSION_LAUNCH_MODEL_MISMATCH_CODE;

  constructor(toolName: string, sessionName: string, requested: string, launching: string | undefined) {
    super(
      `${toolName} is being started by another request (tmux session '${sessionName}') with ` +
        `${launching === undefined ? 'its default model' : `model '${launching}'`}, not '${requested}'. ` +
        'The model can only be set when starting a new session — the message was not delivered and ' +
        'nothing was typed. Stop the session and resend with --model to switch models.'
    );
    this.name = 'SessionLaunchModelMismatchError';
  }
}

/** Duck-typed on `code`, like the session-start errors (bundles do not share classes). */
export function isSessionLaunchModelMismatchError(error: unknown): error is SessionLaunchModelMismatchError {
  return (
    error instanceof Error && (error as { code?: unknown }).code === SESSION_LAUNCH_MODEL_MISMATCH_CODE
  );
}

/** How long a caller may wait for `flight`, counted from when it began. */
function launchWaitLimitMs(flight: SessionLaunchFlight): number {
  return flight.cliToolId === undefined
    ? getSessionStartingMaxMsAcrossTools()
    : getSessionStartingMaxMs(flight.cliToolId);
}

/** `flight`'s outcome, or {@link SessionLaunchWaitTimeoutError} once its budget has run out. */
function waitForFlight(sessionName: string, toolName: string, flight: SessionLaunchFlight): Promise<void> {
  const limitMs = launchWaitLimitMs(flight);
  const remaining = flight.startedAt + limitMs - Date.now();
  const timedOut = (): SessionLaunchWaitTimeoutError => {
    logger.warn('session-launch-wait-timed-out', { sessionName, limitMs });
    return new SessionLaunchWaitTimeoutError(toolName, sessionName, limitMs);
  };
  if (remaining <= 0) return Promise.reject(timedOut());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut()), remaining);
    timer.unref?.();
    flight.promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Whether a launch of `sessionName` is in progress in this process. */
export function isSessionLaunchInFlight(sessionName: string): boolean {
  return flights.has(sessionName);
}

/**
 * Run `launch` as `sessionName`'s only launch.
 *
 * When one is already in progress, the caller joins it (same outcome, waited
 * for within the launch's start budget) instead of starting a second — unless
 * it asks for a model that launch is not starting with, or holds the session's
 * input lock (R1); both are refused at once. Registration happens in the same
 * synchronous step as the check, before `launch` reads anything (R4).
 *
 * @throws SessionLaunchModelMismatchError when another launch is in progress with another model
 * @throws SessionLaunchInFlightError when another launch is in progress and the caller holds the input lock
 * @throws SessionLaunchWaitTimeoutError when the joined launch outlives its start budget
 */
export function runSessionLaunch(
  sessionName: string,
  toolName: string,
  launch: () => Promise<void>,
  options: SessionLaunchOptions = {}
): Promise<void> {
  const inFlight = flights.get(sessionName);
  if (inFlight !== undefined) {
    if (options.model !== undefined && options.model !== inFlight.model) {
      logger.info('session-launch-model-mismatch-refused', { sessionName });
      return Promise.reject(
        new SessionLaunchModelMismatchError(toolName, sessionName, options.model, inFlight.model)
      );
    }
    if (currentInstanceInputTicket(sessionName) !== null) {
      logger.info('session-launch-in-flight-refused', { sessionName });
      return Promise.reject(new SessionLaunchInFlightError(toolName, sessionName));
    }
    logger.info('session-launch-joined', { sessionName });
    return waitForFlight(sessionName, toolName, inFlight);
  }
  // The entry is in the map before `launch` runs a single line. Called in the
  // caller's async context, so a launcher that holds the lock still owns it
  // inside the launch (R2).
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const promise = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  const flight: SessionLaunchFlight = {
    promise,
    startedAt: Date.now(),
    cliToolId: options.cliToolId,
    model: options.model,
  };
  flights.set(sessionName, flight);
  const clear = (): void => {
    if (flights.get(sessionName) === flight) flights.delete(sessionName);
  };
  promise.then(clear, clear);
  let running: Promise<void>;
  try {
    running = launch();
  } catch (error: unknown) {
    running = Promise.reject(error);
  }
  running.then(settle.resolve, settle.reject);
  return promise;
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
 * a launch that failed is left for the caller's own check to find. The wait
 * ends at the launch's start budget (review P3-1).
 *
 * @returns Whether there was a launch to wait for
 * @throws SessionLaunchInFlightError when there is one and the caller holds the input lock (R1)
 * @throws SessionLaunchWaitTimeoutError when it outlives its start budget
 */
export async function settleSessionLaunch(sessionName: string, toolName: string): Promise<boolean> {
  const inFlight = flights.get(sessionName);
  if (inFlight === undefined) return false;
  if (currentInstanceInputTicket(sessionName) !== null) {
    logger.info('session-launch-in-flight-refused', { sessionName });
    throw new SessionLaunchInFlightError(toolName, sessionName);
  }
  await waitForFlight(sessionName, toolName, inFlight).catch((error: unknown) => {
    if (error instanceof SessionLaunchWaitTimeoutError) throw error;
  });
  return true;
}

/** Forget every launch in progress. Test-only. */
export function resetSessionLaunchFlightsForTest(): void {
  flights.clear();
}
