/**
 * Steps `send` and `ask` share when they hand a message to another session:
 * registering the relay before the message goes out, and posting the message
 * with the PROMPT_WAITING refusal reported the same way.
 *
 * Kept in its own module (not in send.ts / ask.ts) because tests mock those
 * modules' internals; what differs per command is passed in as arguments.
 */

import { ExitCode, SendTargetExitCode } from '../types';
import { isCliToolId } from '../config/cli-tool-ids';
import type { ChatMessage, RelayGetResponse } from '../types/api-responses';
import { ApiClient, ApiError, type WireAnswer } from '../utils/api-client';
import { flushClientWarnings, isToolPolicyDenied } from '../utils/tool-policy-failure';
import {
  applyRelayLookup,
  classifySendAnswer,
  type RelayLookupState,
  type SendAnswerClassification,
} from '../../lib/send-outcome/classify-send-answer';
import { paneCaptureCommand } from '../utils/follow-up-command';
import { ROLE_STAYED_SAVED, roleFailureFromApi, roleSettingSavedBy } from '../utils/role-failure';
import type { CommandTarget } from './command-target';
import {
  cancelRelayQuietly,
  printRelayUnconfirmedNotice,
  registerRelay,
  resolveEndpointForWorktree,
  resolveRelayEndpoint,
  type RegisteredRelay,
  type RelayEndpointArg,
} from './relays';

/**
 * Code the send API returns when the session is blocked on a prompt (Issue
 * #1708). Mirrors PROMPT_WAITING_CODE in src/lib/session/prompt-waiting-guard.ts;
 * duplicated rather than imported so the CLI bundle does not pull the server's
 * tmux/detection graph in for one string.
 */
export const PROMPT_WAITING_CODE = 'PROMPT_WAITING';

export interface RegisterRelayForMessageInput {
  worktreeId: string;
  /** The raw `--reply-to` value (callers decide the default). */
  replyTo: string;
  instance?: string;
  agent?: string;
  allowRelayChain?: boolean;
  /**
   * Issue #3983: the client the two endpoints are resolved with (`ask` passes
   * its `--timeout`-bounded one). Defaults to `client`. The relay POST itself
   * always goes through `client`: it creates state, and cutting it would leave
   * "was the relay opened?" unanswered — the same reason `/send` is not cut.
   */
  resolveClient?: ApiClient;
  /** Issue #4133: already resolved by {@link resolveRelayEndpoints}, so not resolved again. */
  endpoints?: RelayEndpoints;
  /** Issue #4133: runs when the relay could not be opened, before the command ends. */
  onFailure?: () => Promise<void>;
}

/** The two ends of a relay, as the ledger stores them. */
export interface RelayEndpoints {
  from: RelayEndpointArg;
  to: RelayEndpointArg;
}

/**
 * Both ends of a `--reply-to`. Only reads. Exits 2 when either cannot be named, so a
 * caller with something to clean up afterwards calls this before making it (Issue #4133).
 */
export async function resolveRelayEndpoints(
  client: ApiClient,
  input: Pick<RegisterRelayForMessageInput, 'worktreeId' | 'replyTo' | 'instance' | 'agent'>
): Promise<RelayEndpoints> {
  const from = await resolveRelayEndpoint(client, input.replyTo);
  const to = await resolveEndpointForWorktree(client, input.worktreeId, input.instance, input.agent);
  // Issue #4496: the tool `--agent` asks for rides on the `to` end, so the server's rule 0
  // judges an ad-hoc instance by the tool that will be typed into, not the worktree's default.
  if (input.agent !== undefined && isCliToolId(input.agent)) to.cliToolId = input.agent;
  return { from, to };
}

/** Resolve both endpoints and open the relay; returns its id and whether it is bound. */
export async function registerRelayForMessage(
  client: ApiClient,
  input: RegisterRelayForMessageInput
): Promise<RegisteredRelay> {
  const endpoints = input.endpoints ?? await resolveRelayEndpoints(input.resolveClient ?? client, input);
  return registerRelay(client, {
    ...endpoints,
    allowRelayChain: input.allowRelayChain,
    onFailure: input.onFailure,
  });
}

export interface PostMessageOptions {
  /**
   * The relay this message opened. When it is bound, its id is put on the
   * send (`relayId`). It is withdrawn only when the send is known not to have
   * gone in and the relay is this send's ({@link undoesFailedSend}).
   */
  relay?: RegisteredRelay;
  /**
   * Runs first when the post fails, before the relay is cancelled and before any
   * exit. Issue #4116: told the failure. Issue #4535: and what the answer proves
   * ({@link SendReading}), so the caller undoes its own side effects (the note,
   * the Auto-Yes grant) only on {@link undoesFailedSend}.
   */
  onFailure?: (error: unknown, reading: SendReading) => Promise<void>;
  /** Printed (after `Error: `) when PROMPT_WAITING carried no message body. */
  promptWaitingFallback: string;
  /** The resolved target the send addressed; the hints name it (Issue #3982). */
  target: CommandTarget;
}

/**
 * What one `/send` proves (Issue #4535, design `docs/design/send-outcome-4535.md`
 * §2.2・§3.1): the fact — `sent`, `not_sent` or `unknown` — and whether the relay
 * bound to it is this send's to clean up. Read once, by `classifySendAnswer`,
 * from this request's answer only (and, for an `unknown`, the bound relay's record).
 */
export type SendReading = Pick<SendAnswerClassification, 'fact' | 'row' | 'relayOwned'>;

/**
 * Whether a failed send's relay, note and Auto-Yes grant are undone (Issue #4535,
 * design §3.1): only when nothing went in and the relay is this send's. A 409
 * `RELAY_BIND_CONFLICT` is another copy of this request's, which may have arrived,
 * unless its relay's own record says it failed (design Q13 (b)).
 */
export function undoesFailedSend(reading: SendReading): boolean {
  return reading.fact === 'not_sent' && reading.relayOwned;
}

/** A tool-policy refusal (Issue #4437) is the CLI's own proof that nothing was typed (N3). */
const TOOL_POLICY_REFUSED: SendAnswerClassification = { fact: 'not_sent', row: 'N3', relayOwned: true, consultRelay: false };

/**
 * Read a failed `/send` (Issue #4535): its answer as it came, or what the request
 * threw when no answer came (a refused connection is the one `not_sent` of those).
 */
function classifyFailure(error: unknown): SendAnswerClassification {
  if (isToolPolicyDenied(error)) return TOOL_POLICY_REFUSED;
  if (error instanceof ApiError && error.answer !== undefined) {
    return classifySendAnswer({ kind: 'response', ...error.answer });
  }
  if (error instanceof ApiError && error.statusCode !== undefined) {
    // An error made without the wire answer: its parsed body is all there is.
    return classifySendAnswer({
      kind: 'response',
      status: error.statusCode,
      contentType: 'application/json',
      bodyText: error.payload === undefined ? '' : JSON.stringify(error.payload),
    });
  }
  return classifySendAnswer({ kind: 'error', error });
}

function asLookupState(value: unknown): RelayLookupState {
  return value === 'awaiting' || value === 'input_started' || value === 'sent' || value === 'unknown' || value === 'failed'
    ? value
    : null;
}

/**
 * Settle an `unknown` with the bound relay's own record (`GET /api/relays/:id`,
 * Issue #3957): only `sent` and `failed` are taken from it, because a send still
 * waiting for the input lock reads `awaiting` too. A lookup that fails says nothing.
 */
async function resolveBoundSendOutcome(
  client: ApiClient,
  relay: RegisteredRelay | undefined,
  classified: SendAnswerClassification
): Promise<SendAnswerClassification> {
  if (!relay?.bound || !classified.consultRelay || classified.fact !== 'unknown') return classified;
  let state: RelayLookupState = null;
  try {
    const { relay: view } = await client.get<RelayGetResponse>(`/api/relays/${relay.id}`);
    state = asLookupState(view?.sendState);
  } catch {
    // Not answerable either: the answer stays unknown.
  }
  return applyRelayLookup(classified, state);
}

const NOT_SENT_NOTE = 'Note: the message was not sent (sendOutcome=not_sent); it is safe to send it again.';

function paneFirst(worktreeId: string, target?: CommandTarget): string {
  return `check the pane first (\`${paneCaptureCommand(worktreeId, target)}\`) and do not resend before that, or it may arrive twice.`;
}

/** The server said `sendOutcome: unknown` (Issue #3992). */
function unknownNote(worktreeId: string, target?: CommandTarget): string {
  return `Note: whether the message was sent is not known (sendOutcome=unknown); ${paneFirst(worktreeId, target)}`;
}

/**
 * Issue #4535 (design C5): the answer said nothing of the message (a page from in
 * between, a code it does not know, a dropped connection) — read as unknown too.
 */
function unprovenNote(worktreeId: string, target?: CommandTarget): string {
  return `Note: the answer did not prove whether the message went in, so it is read as sendOutcome=unknown; ${paneFirst(worktreeId, target)}`;
}

/**
 * Issue #4535 (design Q11): a 409 `RELAY_BIND_CONFLICT` whose relay did not say
 * `sent` or `failed`: another copy of this very request holds the relay, and it
 * may have arrived. Nothing of this send's is undone.
 */
const RELAY_COPY_NOTE =
  'Note: another copy of this request already holds the relay (RELAY_BIND_CONFLICT); that copy may have arrived. '
  + 'This send undid nothing and did not resend.';

/**
 * Issue #4535 (design C1): what a 2xx that is not a send answer is reported as.
 * Exit 99: "sent" is a promise the CLI cannot make from it.
 */
const UNREADABLE_SUCCESS_MESSAGE = "the server's answer did not say whether the message was sent";
const NOT_SENT_SUCCESS_MESSAGE = "the server's answer said the message was not sent";

/**
 * What to tell the sender about resending a failed send, from the server's
 * `sendOutcome` on the error (Issue #3992). Issue #4011: the route puts it on
 * every failure recorded as the send's attempt, bound relay or not. Null when
 * the error carries none (a 400, an older server) or says `sent`. `postMessage`
 * itself words what its reading of the whole answer proves (Issue #4535).
 *
 * @param target - The resolved target, so the `capture` reads the pane the
 *   message went to (Issue #3982); omitted, the hint names no target
 */
export function describeFailedSendOutcome(error: unknown, worktreeId: string, target?: CommandTarget): string | null {
  if (!(error instanceof ApiError)) return null;
  const outcome: unknown = error.payload?.sendOutcome;
  if (outcome === 'not_sent') return NOT_SENT_NOTE;
  if (outcome === 'unknown') return unknownNote(worktreeId, target);
  return null;
}

/**
 * A 2xx read as anything but sent (Issue #4535, design C1・S3・S4): an empty body,
 * a body that is not JSON, JSON that is not a message, an ask replay whose first
 * copy did not go in. Turned into the failure it is, exit 99.
 */
function successThatIsNotASend(answer: WireAnswer, reading: SendAnswerClassification): ApiError {
  const message = reading.fact === 'not_sent' ? NOT_SENT_SUCCESS_MESSAGE : UNREADABLE_SUCCESS_MESSAGE;
  return new ApiError(message, ExitCode.UNEXPECTED_ERROR, answer.status, undefined, undefined, answer);
}

/**
 * A 2xx known only as the value it parsed to (a client that does not tell its
 * answer): read as the JSON it was, or as an empty body.
 */
function parsedAnswer(value: unknown): WireAnswer {
  return value === undefined
    ? { status: 200, contentType: null, bodyText: '' }
    : { status: 200, contentType: 'application/json', bodyText: JSON.stringify(value) };
}

/**
 * Post the message; on failure undo what this send owns and report PROMPT_WAITING.
 *
 * Issue #4535: the answer is read once (`classifySendAnswer`, design §2.2) into
 * `sent` / `not_sent` / `unknown`. Only `not_sent` with a relay this send owns
 * undoes the relay (and, through `onFailure`, the note and the Auto-Yes grant).
 * Anything else leaves them: the relay open with its notice, and stderr says to
 * check the pane before resending. The message is posted once; never resent.
 *
 * @returns The send API's body (Issue #3957: `ask` reads `turnOpenAtSend`)
 */
export async function postMessage(
  client: ApiClient,
  worktreeId: string,
  sendBody: Record<string, unknown>,
  options: PostMessageOptions
): Promise<ChatMessage> {
  const { relay } = options;
  const body = relay?.bound ? { ...sendBody, relayId: relay.id } : sendBody;
  let answered: PostedAnswer;
  try {
    answered = await postOnce(client, `/api/worktrees/${worktreeId}/send`, body);
  } catch (error) {
    // No 2xx came: what the request threw is the failure (a refused connection is the one not_sent).
    const settled = await failSend(client, worktreeId, options, error, await resolveBoundSendOutcome(client, relay, classifyFailure(error)));
    if (settled) return settled;
    throw error;
  }
  const { sent, wire } = answered;
  const classified = classifySendAnswer({ kind: 'response', ...(wire ?? parsedAnswer(sent)) });
  if (classified.fact === 'sent' && sent !== undefined) {
    if (relay?.bound && sent.sendOutcome === 'unknown') printRelayUnconfirmedNotice(relay.id);
    return sent;
  }
  const failure = successThatIsNotASend(wire ?? parsedAnswer(sent), classified);
  const settled = await failSend(client, worktreeId, options, failure, await resolveBoundSendOutcome(client, relay, classified));
  if (settled) return settled;
  throw failure;
}

/** A 2xx of `/send`: its parsed body (none when it did not parse) and the answer as it came. */
interface PostedAnswer {
  sent: ChatMessage | undefined;
  wire: WireAnswer | undefined;
}

/**
 * POST once (never resent; redirects are followed by `fetch`, design C2). A 2xx whose
 * body does not parse is still that 2xx (design S4): it comes back with no body.
 */
async function postOnce(client: ApiClient, path: string, body: Record<string, unknown>): Promise<PostedAnswer> {
  let wire: WireAnswer | undefined;
  try {
    const sent = await client.post<ChatMessage | undefined>(path, body, {
      onAnswer: (answer) => {
        wire = answer;
      },
    });
    return { sent, wire };
  } catch (error) {
    if (wire !== undefined) return { sent: undefined, wire };
    throw error;
  }
}

/**
 * The failure half of {@link postMessage}: undo what this send owns, say what may be
 * done next. Resolves to a message when the relay's record says it went in, to null
 * when `failure` is to be thrown as it is; throws when it ends otherwise.
 */
async function failSend(
  client: ApiClient,
  worktreeId: string,
  options: PostMessageOptions,
  failure: unknown,
  reading: SendAnswerClassification
): Promise<ChatMessage | null> {
  const relayId = options.relay?.id;
  // The answer was lost on the way back, and the relay's record says it went out.
  if (reading.fact === 'sent') {
    return { worktreeId, role: 'user', content: '', sendOutcome: 'sent' };
  }
  const error = exitOnlyAsProven(failure, reading);
  if (options.onFailure) {
    await options.onFailure(error, { fact: reading.fact, row: reading.row, relayOwned: reading.relayOwned });
  }
  // Issue #4437 (I7d): past the refusal that had to be the first line; the notes that
  // follow come after the client's warnings, as the command's own failure line does.
  flushClientWarnings();
  const undo = undoesFailedSend(reading);
  // A relay whose message never arrived can never be answered; leaving
  // it open would have the requester waiting 24h for a turn that was
  // never started.
  if (relayId && undo) {
    await cancelRelayQuietly(client, relayId);
  } else if (relayId) {
    // Issue #3992: the relay notice carries the "look before resending" hint.
    printRelayUnconfirmedNotice(relayId, worktreeId, options.target);
  }
  // Issue #4535 (design Q11): another copy holds the relay and did not say it failed.
  if (reading.row === 'N4' && reading.fact === 'unknown') console.error(RELAY_COPY_NOTE);
  const promptWaiting = error instanceof ApiError && error.apiCode === PROMPT_WAITING_CODE;
  // Issue #4116: a refusal with no role code of its own (a 400, a 503, a 500), after
  // the role was saved. One with a role code says so in its own sentence.
  if (roleSettingSavedBy(error) && roleFailureFromApi(error) === null) {
    console.error(`Note: ${ROLE_STAYED_SAVED}`);
  }
  // Issue #3992 / #4535: whether it may be sent again, as the answer proves — not on
  // PROMPT_WAITING, whose own line says to answer the prompt first, not when the
  // relay notice above already said it, and not for a server that is not running
  // (N7: its own line says so). "Safe to send it again" only when the server said
  // so, or the relay's own record did (design Q13 (b)).
  const resendNote = promptWaiting ? null : resendNoteFor(error, reading, worktreeId, options.target, relayId !== undefined);
  if (resendNote !== null) console.error(resendNote);
  // Issue #1708: the session is sitting on a prompt, so the message
  // would have been typed into the prompt's input line rather than
  // reaching the agent. Reported on its own so an unattended runner sees
  // "answer the prompt", not a generic HTTP failure.
  if (promptWaiting && error instanceof ApiError) {
    // The server's own sentence, not error.message: handleApiError maps a
    // bare 409 to "Unexpected HTTP status: 409", which says nothing about
    // what to do next.
    console.error(`Error: ${error.payload?.error ?? options.promptWaitingFallback}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
  // Issue #4116: a refusal because of the role, whether or not this send named
  // one (a default can refuse a start), with the server's sentence and its own
  // exit code rather than "Unexpected HTTP status: 409".
  const roleFailure = roleFailureFromApi(error);
  if (roleFailure) throw roleFailure;
  if (error !== failure) throw error;
  return null;
}

/** The resend line for a failed send's reading, or null (see {@link failSend}). */
function resendNoteFor(
  error: unknown,
  reading: SendReading,
  worktreeId: string,
  target: CommandTarget,
  relayNoticePrinted: boolean
): string | null {
  if (reading.fact === 'unknown') {
    if (relayNoticePrinted) return null;
    const saidUnknown = error instanceof ApiError && error.payload?.sendOutcome === 'unknown';
    return saidUnknown ? unknownNote(worktreeId, target) : unprovenNote(worktreeId, target);
  }
  if (reading.row === 'N7') return null;
  const saidNotSent = error instanceof ApiError && error.payload?.sendOutcome === 'not_sent';
  // An answer that proved nothing, settled `failed` by the bound relay's own record.
  const relaySaidFailed = reading.row === 'N4' || !reading.row.startsWith('N');
  return saidNotSent || relaySaidFailed ? NOT_SENT_NOTE : null;
}

/**
 * Issue #4534 (INV-F4): exit 34 says nothing was delivered, so it stands only on a
 * `not_sent` 409 `SEND_TARGET_CHANGED` as read here. One whose body did not prove
 * it (not served as JSON, an ask state that disagrees) is the 99 it would be otherwise.
 */
function exitOnlyAsProven(error: unknown, reading: SendReading): unknown {
  if (!(error instanceof ApiError) || error.exitCode !== SendTargetExitCode.CHANGED || reading.row === 'N2') return error;
  return new ApiError(error.message, ExitCode.UNEXPECTED_ERROR, error.statusCode, error.payload, error.transportError, error.answer);
}
