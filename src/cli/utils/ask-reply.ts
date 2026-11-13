/**
 * `ask`'s reply, by the ask's own id (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §0.2・§3.3・§3.6 cell 17・§4, PR3).
 *
 * Until #4344 `ask` printed "the newest reply after the send": a ledger row, or
 * the squeezed pane when the ledger had none. Twice that picked another turn's
 * answer (#4315's 5-2b). Now a synchronous `ask` names an id on the send, the
 * server stamps an envelope on the typed text, its transcript reader binds that
 * input to the completed turn that answered it, and this module reads the
 * answer back by that id (`GET /api/asks/:askId`). The reply is printed only
 * when the ledger says `matched`; anything else prints `reply: null` with the
 * state and the reason. The pane is never read for a reply (the human decision
 * of 2026-11-13: a tool or server that cannot attribute does not collect).
 *
 * - Which tools are attributed comes from the server (`GET /api/asks/capabilities`),
 *   never a copy of the table here (§3.2). A server that predates the endpoint
 *   (404) is `server_unsupported`: the send goes out with the old body.
 * - Running out of the reply grace with the row still `pending` is decided here
 *   (`grace_expired` / `turn_incomplete` / `send_unknown`) and written nowhere:
 *   the ledger is not made terminal by a client's patience (§3.6 cell 17, I12).
 */

import { randomUUID } from 'crypto';
import { ExitCode } from '../types';
import type {
  AskAttributionReason,
  AskAttributionResponse,
  AskCapabilitiesResponse,
  AskSendAnswer,
} from '../types/api-responses';
import { ApiError, isDeadlineExceeded, type ApiClient } from './api-client';
import { stripReplyControls } from './reply-ledger';

/** The envelope protocol this CLI speaks. Mirrors `ASK_PROTOCOL_VERSION` in `src/types/ask-correlation.ts`. */
export const ASK_PROTOCOL_VERSION = 1;

/** `GET /api/asks/capabilities` (`src/app/api/asks/capabilities/route.ts`). */
export const ASK_CAPABILITIES_PATH = '/api/asks/capabilities';

/** What the CLI's final answer can say (`pending` never is one: §3.3). */
export type AskOutcomeState = 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';

/** What `ask` prints about the reply (`--json`'s `askId` / `attribution` / `reply`). */
export interface AskOutcome {
  /** The id the send carried, or null when none was (unavailable). */
  askId: string | null;
  state: AskOutcomeState;
  reason: AskAttributionReason | null;
  /** The answering turn also absorbed a background-task notice (§7 (a) ②). */
  notified: boolean;
  /** The reply body, only when `state === 'matched'`. */
  reply: string | null;
}

/** How `ask` treats the send, decided before it. */
export type AskSendPlan =
  /** The server attributes (or, with no tool known, may attribute) this ask: the send names `askId`. */
  | { kind: 'ask'; askId: string }
  /** Not attributed: the send goes out as it did before #4344, and the reply is not collected. */
  | { kind: 'unavailable'; outcome: AskOutcome };

/** An unavailable outcome (§0.2). */
export function unavailableOutcome(reason: AskAttributionReason): AskOutcome {
  return { askId: null, state: 'unavailable', reason, notified: false, reply: null };
}

/**
 * The server's attribution table, or null for a server that predates it (a
 * 404). Any other failure is the command's: the send goes to the same server,
 * so it is not quietly turned into a send without the ledger (§0.2).
 *
 * @throws ApiError on anything but a 404 or a well-formed answer (a deadline stays 124)
 */
export async function readAskCapabilities(client: ApiClient): Promise<AskCapabilitiesResponse | null> {
  let body: unknown;
  try {
    body = await client.get<unknown>(ASK_CAPABILITIES_PATH);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404 && !isDeadlineExceeded(error)) return null;
    throw error;
  }
  const record = body as Partial<AskCapabilitiesResponse> | null;
  if (
    record === null
    || typeof record !== 'object'
    || typeof record.protocol !== 'number'
    || record.tools === null
    || typeof record.tools !== 'object'
    || Array.isArray(record.tools)
  ) {
    throw new ApiError(
      `Unexpected answer from GET ${ASK_CAPABILITIES_PATH}: not { protocol, tools }. Refusing to guess whether this ask can be attributed.`,
      ExitCode.UNEXPECTED_ERROR,
    );
  }
  return { protocol: record.protocol, tools: record.tools as Record<string, boolean> };
}

/**
 * Decide the send (§0.2): a server without the table, or a protocol this CLI
 * does not speak, is `server_unsupported`; a known tool the table does not mark
 * true is `tool_unsupported`. Otherwise the send names a fresh id — with no tool
 * resolved (the worktree's default) the server decides, and its answer says.
 *
 * @param cliToolId - The resolved tool, when the CLI knows it
 */
export async function planAskSend(client: ApiClient, cliToolId: string | undefined): Promise<AskSendPlan> {
  const capabilities = await readAskCapabilities(client);
  if (capabilities === null || capabilities.protocol !== ASK_PROTOCOL_VERSION) {
    return { kind: 'unavailable', outcome: unavailableOutcome('server_unsupported') };
  }
  if (cliToolId !== undefined && capabilities.tools[cliToolId] !== true) {
    return { kind: 'unavailable', outcome: unavailableOutcome('tool_unsupported') };
  }
  return { kind: 'ask', askId: randomUUID() };
}

/**
 * What the send's answer says about the ask. `unavailable` (a command body, a
 * tool the server turned down) is final; an answer with no `ask` at all means
 * the server did not read the field. Null: the ledger is to be read after the
 * turn.
 */
export function outcomeFromSendAnswer(answer: AskSendAnswer | undefined): AskOutcome | null {
  if (answer === undefined || answer === null || typeof answer !== 'object') {
    return unavailableOutcome('server_unsupported');
  }
  if (answer.state === 'unavailable') {
    return unavailableOutcome(answer.reason ?? 'tool_unsupported');
  }
  return null;
}

/** The answer of a row that settled (anything but `pending`). */
function settledOutcome(askId: string, answer: AskAttributionResponse): AskOutcome {
  const notified = answer.notified === true;
  if (answer.state === 'matched') {
    // The ledger's matched always carries the body; one without it is not a reply.
    if (typeof answer.reply !== 'string') {
      return { askId, state: 'unmatched', reason: 'history_missing', notified, reply: null };
    }
    // Issue #2386's belt stays: no escape or control byte reaches stdout. The
    // body is otherwise printed whole (no trim, no window).
    return { askId, state: 'matched', reason: null, notified, reply: stripReplyControls(answer.reply) };
  }
  const state: AskOutcomeState =
    answer.state === 'ambiguous' || answer.state === 'unavailable' ? answer.state : 'unmatched';
  return { askId, state, reason: answer.reason ?? null, notified, reply: null };
}

/**
 * The reply grace ran out with the row still `pending` (§3.6 cell 17). Named
 * from the last reading, and written nowhere — a later, correct observation
 * still settles the row on the server.
 *
 * - `send_unknown`: the send's outcome is not known (or the reservation went stale, H3);
 * - `turn_incomplete`: the reader saw this ask's input, but its turn has not closed;
 * - `grace_expired`: nothing of this ask was seen (or nothing could be read).
 */
function expiredOutcome(askId: string, last: AskAttributionResponse | null): AskOutcome {
  let reason: AskAttributionReason = 'grace_expired';
  if (last?.sendState === 'send_unknown') reason = 'send_unknown';
  else if (last?.nativeInputSeen === true) reason = 'turn_incomplete';
  return { askId, state: 'unmatched', reason, notified: last?.notified === true, reply: null };
}

/**
 * Read `askId`'s attribution until it settles or `graceMs` runs out (§4
 * `readAskAttribution`). Each read is bounded by the grace (the turn already
 * ended inside `--timeout`, so running out is not 124). A `pending` read makes
 * the server run the tool's reader once (§3.5), so this settles with no poller.
 *
 * @throws ApiError for a failure other than the grace's deadline
 */
export async function readAskOutcome(
  client: ApiClient,
  askId: string,
  options: { graceMs: number; pollMs: number; sleep: (ms: number) => Promise<void> },
): Promise<AskOutcome> {
  const deadline = Date.now() + options.graceMs;
  const graceClient = client.withDeadline(deadline);
  let last: AskAttributionResponse | null = null;
  for (;;) {
    try {
      last = await graceClient.get<AskAttributionResponse>(`/api/asks/${encodeURIComponent(askId)}`);
    } catch (error) {
      if (isDeadlineExceeded(error)) return expiredOutcome(askId, last);
      throw error;
    }
    if (last && last.state !== 'pending') return settledOutcome(askId, last);
    if (Date.now() + options.pollMs >= deadline) return expiredOutcome(askId, last);
    await options.sleep(options.pollMs);
  }
}

/** What each reason means, for the one stderr line (§0.2). */
const REASON_TEXT: Readonly<Record<AskAttributionReason, string>> = {
  tool_unsupported: 'this tool has no ask attribution',
  server_unsupported: 'the server predates ask attribution',
  slash_command: 'a command body carries no ask id',
  shared_turn: 'the turn that answered also took another input',
  turn_open_at_send: 'the instance was already in a turn when this ask was sent',
  envelope_lost: 'the transcript did not keep this ask\'s id',
  absorbed_mid_turn: 'this ask was folded into another turn',
  envelope_duplicated: 'this ask\'s id was seen on two inputs',
  turn_incomplete: 'this ask\'s turn has not closed in the transcript yet',
  generation_changed: 'the session changed before this ask\'s turn closed',
  history_missing: 'the reply rows are no longer in History',
  body_truncated: 'the reply was cut short in the transcript',
  send_unknown: 'whether the message went in is not known',
  not_sent: 'the message was not typed',
  grace_expired: 'the transcript did not show this ask\'s turn in time',
  turn_interrupted: 'this ask\'s turn was interrupted before it closed',
  history_changed: 'the reply rows changed after the reply was settled',
};

/**
 * The one stderr line for an ask whose reply is not printed (§0.2), with where
 * to look instead. The reply may still exist — it is not this command's to
 * pick off the screen.
 */
export function formatReplyNotCollected(
  outcome: AskOutcome,
  target: { worktreeId: string; instanceId?: string; cliToolId?: string },
): string {
  const reason = outcome.reason ?? 'grace_expired';
  const who = reason === 'tool_unsupported' && target.cliToolId ? `${target.cliToolId}: ` : '';
  const look = `capture ${target.worktreeId}${target.instanceId ? ` --instance ${target.instanceId}` : ''} --pane`;
  return `reply not collected (${outcome.state}/${reason}): ${who}${REASON_TEXT[reason] ?? reason}; look with \`${look}\``;
}

/** The note for a matched reply whose turn also took a background-task notice (§7 (a) ②). */
export const NOTIFIED_NOTE =
  'Note: the answering turn also took a background-task notification; the reply may react to it as well.';
