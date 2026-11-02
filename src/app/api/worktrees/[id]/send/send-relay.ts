/**
 * POST /api/worktrees/:id/send — the bound relay's reservation and the turn
 * record read at the input start (Issue #3957; split out of `handleSend` by
 * Issue #4055).
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SendAttemptState } from '@/lib/session/send-attempt-types';
import { getPublishedAgentTurn } from '@/lib/session/agent-event-state';
import { currentGeneration } from '@/lib/session/agent-event-turn';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { ChatMessage } from '@/types/models';
import { reserveRelaySend, type RelaySendBinding } from '@/lib/relay/relay-bind';
import type { SendStep } from './send-request';

/**
 * What the handler learned about a relay-bound send, for {@link POST} to settle
 * the relay with and answer `sendOutcome` from (Issue #3957).
 */
export interface RouteRelayState {
  binding: RelaySendBinding | null;
  /** The send service's own record of this attempt, once it made one. */
  attempt: SendAttemptState | null;
  /** Set when the send service answered ok. */
  sent: { messageId: string; generationAfter: number | null } | null;
}

/**
 * Issue #3957: the 201 body. `turnOpenAtSend` says whether the instance's own
 * turn record showed a turn open (opened, not closed) at the moment the body
 * started going into the composer — true: the message may be folded into that
 * turn (codex does), so `ask` reports the reply as overlapped; false: no turn
 * was open then. Absent means "not known": a tool whose hooks do not report
 * both a turn start and its `stop`, a sender that reports no input start, a
 * generation change (relaunch) during the send.
 */
export type SendMessageResponse = ChatMessage & { turnOpenAtSend?: boolean };

/** Whether this tool's hooks report a turn's start and its end (Issue #3957; #1975's test). */
export function reportsTurns(cliToolId: CLIToolType): boolean {
  const events: readonly string[] = getAgentEventSource(cliToolId).capabilities.supportedEvents;
  return events.includes('user_prompt_submit') && events.includes('stop');
}

/** The turn record read at the input start (Issue #3957). */
export interface TurnAtInput {
  open: boolean;
  generation: number | null;
}

/**
 * The open-turn reading of the record `wait`'s polls publish as
 * `structuredEvents.openedAt` / `closedAt`, taken in the same synchronous step
 * as the sender's `noteInputStart` (Issue #3957).
 */
export function readTurnAtInput(worktreeId: string, cliToolId: CLIToolType, instanceId: string | undefined): TurnAtInput {
  const turn = getPublishedAgentTurn(worktreeId, cliToolId, instanceId);
  return {
    open: turn.openedAt !== null && turn.closedAt === null,
    generation: currentGeneration(buildCompositeKey(worktreeId, cliToolId, instanceId)),
  };
}

/** The value to publish, or undefined for "not known" (Issue #3957). */
export function judgeTurnOpenAtSend(
  reading: TurnAtInput | null,
  generationBefore: number | null,
  generationAfter: number | null,
  hooksReportTurns: boolean,
): boolean | undefined {
  if (!hooksReportTurns || reading === null) return undefined;
  if (reading.generation !== generationBefore || generationAfter !== generationBefore) return undefined;
  return reading.open;
}

/** Where a bound relay's send goes, for {@link reserveRelayForSend} (Issue #4055). */
export interface RelayForSendInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The resolved instance (`resolution.target.instanceId`). */
  targetInstanceId: string;
  /** The instance the request named (`body.instanceId`), for the turn reading. */
  instanceId: string | undefined;
}

/**
 * Reserve the relay a body names (`relayId`); null when it names none. A
 * refusal is the handler's answer, and nothing was reserved.
 */
export function reserveRelayForSend(
  db: Database.Database,
  relayId: unknown,
  input: RelayForSendInput,
): SendStep<RelaySendBinding | null> {
  const { worktreeId: id, cliToolId, instanceId } = input;
  // Issue #3957: reserve the bound relay now — after the body and the
  // destination are validated and resolved, before the first side effect
  // (the session start below). A refusal sends nothing.
  if (relayId !== undefined) {
    if (typeof relayId !== 'string') {
      return { ok: false, response: NextResponse.json({ error: 'relayId must be a string', code: 'RELAY_BIND_INVALID' }, { status: 400 }) };
    }
    const reservation = reserveRelaySend(db, {
      relayId,
      worktreeId: id,
      cliToolId,
      instanceId: input.targetInstanceId,
      hooksReportTurns: reportsTurns(cliToolId),
      readTurn: () => readTurnAtInput(id, cliToolId, instanceId),
    });
    if (!reservation.ok) {
      const { status, code, message } = reservation.refusal;
      return { ok: false, response: NextResponse.json({ error: message, code }, { status }) };
    }
    return { ok: true, value: reservation.binding };
  }
  return { ok: true, value: null };
}
