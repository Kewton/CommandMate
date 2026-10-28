/**
 * The send half of a bound relay (Issue #3957).
 *
 * `send --reply-to` / `ask --async` open the relay BEFORE the message goes out
 * (#2377: a session that answers at once must not finish in the gap), so the
 * relay alone cannot say when its question reached the worker. Until this
 * module the delivery took the newest reply after the relay was OPENED — and a
 * send that queued for the input lock (S3) or failed (S5) was answered with
 * somebody else's reply.
 *
 * A relay opened with `bind: true` is instead tied to the one send that names
 * it, in four steps the send route drives:
 *
 *  1. **Reserve** ({@link reserveRelaySend}) — before any side effect, one
 *     conditional UPDATE under a fresh attempt id. A second send, a closed or
 *     expired relay, or one addressed elsewhere is refused and nothing is typed.
 *  2. **Boundary** ({@link RelaySendBinding.hooks}) — the REQUIRED hook the
 *     sender runs right before the first key (or right before opencode's HTTP
 *     dispatch). It writes the lower bound, the turn reading and the
 *     observation source in one UPDATE under the token; when that write fails
 *     the hook throws and the body is never typed.
 *  3. **Dispatch fallback** — opencode's HTTP send says whether a failed
 *     dispatch is known not to have sent (the keyboard's own input start then
 *     replaces the boundary) or cannot be told (the relay is held as
 *     `dispatch_unknown`).
 *  4. **Settle** ({@link RelaySendBinding.finish}) — `sent`, `failed` or
 *     `unknown`, again under the token and the expected state, and the
 *     `sendOutcome` the route hands back to the CLI.
 *
 * Nothing here awaits inside a DB transaction, and nothing here delivers: the
 * delivery reads what this module wrote (`relay-delivery`).
 *
 * @module lib/relay/relay-bind
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  explainRelayBindRefusal,
  recordRelayInputBoundary,
  reserveRelayBind,
  settleRelaySendState,
  type RelayBindRefusal,
} from '@/lib/db/relay-db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  DispatchFailureVerdict,
  InputBoundaryHooks,
  InputBoundaryKind,
} from '@/lib/session/instance-input-lock';
import type { SendAttemptState } from '@/lib/session/send-attempt-types';
import { relayObservationSource, relayServerBootId } from '@/lib/relay/relay-boot';
import type { RelayObsState } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-bind');

/** crypto.randomUUID() output; anything else was never a relay id. */
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the send API tells the CLI about the message, for a bound relay. */
export type RelaySendOutcome = 'sent' | 'not_sent' | 'unknown';

/** Hold reasons this module writes. Published as is. */
export const RELAY_HOLD_REASONS = {
  sendUnknown: 'send_unknown',
  dispatchUnknown: 'dispatch_unknown',
  generationChanged: 'generation_changed',
  noInputBoundary: 'no_input_boundary',
  serverRestarted: 'server_restarted',
  serverRestartedBeforeInput: 'server_restarted_before_input',
} as const;

/** The turn record as the send route reads it at the boundary. */
export interface RelayTurnReading {
  open: boolean;
  generation: number | null;
}

/** What a bound send needs to know about its target. */
export interface RelaySendTarget {
  relayId: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The resolved instance; the primary instance's id is its tool id (#868). */
  instanceId: string;
  /** Whether the tool's hooks report both a turn start and its `stop`. */
  hooksReportTurns: boolean;
  /** Read the turn record now (same reading as the route's `turnOpenAtSend`). */
  readTurn: () => RelayTurnReading;
}

/** How the send ended, as the route saw it. */
export type RelaySendResult =
  /** The send service answered ok: the body was submitted and recorded. */
  | { kind: 'sent'; messageId: string; generationAfter: number | null }
  /**
   * Anything else. `attempt` is the send service's own record of this attempt
   * when it reached that far (`sent` there with a throw here means the history
   * write failed after the transport succeeded).
   */
  | { kind: 'failed'; attempt: SendAttemptState | null };

/** {@link reserveRelaySend}'s answer. */
export type ReserveRelaySendResult =
  | { ok: true; binding: RelaySendBinding }
  | { ok: false; refusal: RelayBindRefusal | { status: 500; code: 'RELAY_BIND_FAILED'; message: string } };

/**
 * Reserve a bound relay for this send attempt, before any side effect.
 *
 * 400 for an id that is not a relay id, a legacy relay or one addressed to
 * another session; 409 for a closed, expired or already reserved one; 500 when
 * the ledger cannot be written. None of them types anything.
 */
export function reserveRelaySend(
  db: Database.Database,
  target: RelaySendTarget,
  now = Date.now()
): ReserveRelaySendResult {
  if (!RELAY_ID_PATTERN.test(target.relayId)) {
    return {
      ok: false,
      refusal: { status: 400, code: 'RELAY_BIND_INVALID', message: 'relayId must be a relay id' },
    };
  }
  const attemptId = randomUUID();
  try {
    const reserved = reserveRelayBind(db, {
      relayId: target.relayId,
      attemptId,
      owner: relayServerBootId(),
      worktreeId: target.worktreeId,
      instanceId: target.instanceId,
      now,
    });
    if (!reserved) {
      return {
        ok: false,
        refusal: explainRelayBindRefusal(db, target.relayId, target.worktreeId, target.instanceId, now),
      };
    }
  } catch (error) {
    logger.warn('relay-bind-reserve-failed', {
      relayId: target.relayId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      refusal: { status: 500, code: 'RELAY_BIND_FAILED', message: 'Failed to reserve the relay' },
    };
  }
  logger.info('relay-bind-reserved', { relayId: target.relayId, attemptId });
  return { ok: true, binding: new RelaySendBinding(db, target, attemptId) };
}

/** Where opencode's HTTP dispatch stands, if one was made. */
type DispatchState = 'none' | 'pending' | 'not_sent' | 'unknown';

/**
 * One reserved send attempt. Created by {@link reserveRelaySend}.
 *
 * Every write is keyed on the attempt id, so a write from an attempt that has
 * lost the relay (cancelled, expired, recovered after a restart) changes
 * nothing.
 */
export class RelaySendBinding {
  private generationBefore: number | null = null;
  private boundaryWritten = false;
  private observationInvalid = false;
  private refused = false;
  private dispatch: DispatchState = 'none';
  /** A later HTTP dispatch noted after one ended `unknown`, not (yet) failed. */
  private retryDispatchOpen = false;

  constructor(
    private readonly db: Database.Database,
    readonly target: RelaySendTarget,
    readonly attemptId: string
  ) {}

  get relayId(): string {
    return this.target.relayId;
  }

  /** Remember the session's generation before the send begins. */
  begin(generationBefore: number | null): void {
    this.generationBefore = generationBefore;
  }

  /** The hooks to hand the send service (`sendUserMessage({ inputBoundary })`). */
  hooks(): InputBoundaryHooks {
    return {
      beforeInput: (at, kind) => this.beforeInput(at, kind),
      onDispatchFailed: (verdict) => this.onDispatchFailed(verdict),
    };
  }

  private beforeInput(at: Date, kind: InputBoundaryKind): void {
    // A dispatch that may already have delivered: the keyboard fallback is the
    // operator's message and is typed as before, but it says nothing new about
    // the relay, which stays held. A further HTTP dispatch (opencode's image
    // send falling back to its text send) is remembered: only its delivery may
    // lift the hold.
    if (this.dispatch === 'unknown') {
      if (kind === 'dispatch') this.retryDispatchOpen = true;
      return;
    }

    const reading = this.target.readTurn();
    const sameGeneration = reading.generation === this.generationBefore;
    const obsState: RelayObsState = !sameGeneration
      ? 'invalid'
      : this.target.hooksReportTurns
        ? 'valid'
        : 'turn_unknown';
    const turnOpenAtSend = this.target.hooksReportTurns && sameGeneration ? reading.open : null;

    let written: boolean;
    try {
      written = recordRelayInputBoundary(this.db, {
        relayId: this.target.relayId,
        attemptId: this.attemptId,
        at: at.getTime(),
        kind,
        turnOpenAtSend,
        obsState,
        obsSource: relayObservationSource(this.target.worktreeId, this.target.cliToolId, this.target.instanceId),
        replaceDispatch: this.dispatch === 'not_sent',
      });
    } catch (error) {
      this.refused = true;
      throw error;
    }
    if (!written) {
      this.refused = true;
      throw new Error(`relay ${this.target.relayId} is no longer reserved for this send`);
    }
    this.boundaryWritten = true;
    this.observationInvalid = obsState === 'invalid';
    if (kind === 'dispatch') this.dispatch = 'pending';
  }

  private onDispatchFailed(verdict: DispatchFailureVerdict): void {
    // Issue #3957: once one dispatch of this send may have delivered, a later
    // attempt that did not deliver proves nothing about the first — `unknown`
    // stays, and only a delivered send can change it.
    if (this.dispatch === 'unknown') {
      this.retryDispatchOpen = false;
      return;
    }
    if (verdict === 'not_sent') {
      // The HTTP boundary is discarded: the keyboard's own input start, which
      // comes after the lock wait, replaces it. The HTTP time must not be the
      // lower bound, or a reply that ended while the fallback queued is taken.
      this.dispatch = 'not_sent';
      return;
    }
    this.dispatch = 'unknown';
    settleRelaySendState(this.db, {
      relayId: this.target.relayId,
      attemptId: this.attemptId,
      from: ['input_started'],
      to: 'unknown',
      holdReason: RELAY_HOLD_REASONS.dispatchUnknown,
    });
  }

  /**
   * Record how the send ended and say what the CLI may do with the relay.
   *
   * `not_sent` only when nothing can have reached the worker: the send stopped
   * before the boundary, the boundary hook refused, or the send service said
   * `not-sent`. A failure after the boundary that the service could not place
   * is `unknown` (held, never cancelled by the CLI).
   */
  finish(result: RelaySendResult): RelaySendOutcome {
    try {
      return this.settle(result);
    } catch (error) {
      logger.warn('relay-bind-settle-failed', {
        relayId: this.target.relayId,
        error: error instanceof Error ? error.message : String(error),
      });
      return result.kind === 'sent' ? 'sent' : 'unknown';
    }
  }

  private settle(result: RelaySendResult): RelaySendOutcome {
    const base = { relayId: this.target.relayId, attemptId: this.attemptId };
    if (this.dispatch === 'unknown') {
      // A later HTTP dispatch that delivered: the message is in, and the first
      // dispatch's boundary (the earlier one) stays the lower bound.
      if (result.kind === 'sent' && this.retryDispatchOpen) {
        settleRelaySendState(this.db, {
          ...base,
          from: ['unknown'],
          to: 'sent',
          inputMessageId: result.messageId,
          clearHoldReason: true,
        });
        return 'sent';
      }
      return 'unknown';
    }

    if (result.kind === 'sent') {
      if (!this.boundaryWritten) {
        // A sender that reported neither an input start nor a dispatch. The
        // reply cannot be bounded, so the relay is held rather than guessed.
        settleRelaySendState(this.db, {
          ...base,
          from: ['awaiting'],
          to: 'unknown',
          holdReason: RELAY_HOLD_REASONS.noInputBoundary,
        });
        return 'unknown';
      }
      const relaunched = this.observationInvalid || result.generationAfter !== this.generationBefore;
      settleRelaySendState(this.db, {
        ...base,
        from: ['input_started'],
        to: 'sent',
        inputMessageId: result.messageId,
        holdReason: relaunched ? RELAY_HOLD_REASONS.generationChanged : null,
        invalidateObservation: relaunched,
      });
      return 'sent';
    }

    // The history write failed after the transport confirmed the submit.
    if (result.attempt === 'sent') {
      settleRelaySendState(this.db, {
        ...base,
        from: ['awaiting', 'input_started'],
        to: 'unknown',
        holdReason: RELAY_HOLD_REASONS.sendUnknown,
      });
      return 'unknown';
    }
    const nothingTyped = !this.boundaryWritten || this.refused || result.attempt === 'not-sent';
    if (nothingTyped) {
      settleRelaySendState(this.db, { ...base, from: ['awaiting', 'input_started'], to: 'failed' });
      return 'not_sent';
    }
    settleRelaySendState(this.db, {
      ...base,
      from: ['input_started'],
      to: 'unknown',
      holdReason: RELAY_HOLD_REASONS.sendUnknown,
    });
    return 'unknown';
  }
}
