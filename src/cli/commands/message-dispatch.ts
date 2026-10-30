/**
 * Steps `send` and `ask` share when they hand a message to another session:
 * registering the relay before the message goes out, and posting the message
 * with the PROMPT_WAITING refusal reported the same way.
 *
 * Kept in its own module (not in send.ts / ask.ts) because tests mock those
 * modules' internals; what differs per command is passed in as arguments.
 */

import { ExitCode } from '../types';
import type { ChatMessage, RelayGetResponse } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import {
  cancelRelayQuietly,
  printRelayUnconfirmedNotice,
  registerRelay,
  resolveEndpointForWorktree,
  resolveRelayEndpoint,
  type RegisteredRelay,
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
}

/** Resolve both endpoints and open the relay; returns its id and whether it is bound. */
export async function registerRelayForMessage(
  client: ApiClient,
  input: RegisterRelayForMessageInput
): Promise<RegisteredRelay> {
  const replyEndpoint = await resolveRelayEndpoint(client, input.replyTo);
  const workerEndpoint = await resolveEndpointForWorktree(
    client,
    input.worktreeId,
    input.instance,
    input.agent
  );
  return registerRelay(client, {
    from: replyEndpoint,
    to: workerEndpoint,
    allowRelayChain: input.allowRelayChain,
  });
}

export interface PostMessageOptions {
  /**
   * The relay this message opened. When it is bound, its id is put on the
   * send (`relayId`) and it is withdrawn only on a confirmed `not_sent`.
   */
  relay?: RegisteredRelay;
  /** Runs first when the post fails, before the relay is cancelled. */
  onFailure?: () => Promise<void>;
  /** Printed (after `Error: `) when PROMPT_WAITING carried no message body. */
  promptWaitingFallback: string;
}

/** What the send did, as far as a bound relay is concerned (Issue #3957). */
type BoundSendOutcome = 'sent' | 'not_sent' | 'unknown' | 'conflict';

function isSendOutcome(value: unknown): value is 'sent' | 'not_sent' | 'unknown' {
  return value === 'sent' || value === 'not_sent' || value === 'unknown';
}

/**
 * Work out what a failed send did to a bound relay (Issue #3957).
 *
 * The server's own `sendOutcome` when the answer carries one. A 409
 * `RELAY_BIND_CONFLICT` is another attempt's relay — never withdrawn from
 * here. A 4xx without one was refused before the relay was reserved: nothing
 * was sent. No answer at all (a dropped connection, a 5xx from in between) is
 * asked of `GET /api/relays/:id`; only `sent` and `failed` are taken from it,
 * because a send still waiting for the input lock reads `awaiting` too.
 */
async function resolveBoundSendOutcome(
  client: ApiClient,
  relayId: string,
  error: unknown
): Promise<BoundSendOutcome> {
  if (error instanceof ApiError && error.statusCode !== undefined) {
    if (error.apiCode === 'RELAY_BIND_CONFLICT') return 'conflict';
    const reported: unknown = error.payload?.sendOutcome;
    if (isSendOutcome(reported)) return reported;
    if (error.statusCode < 500) return 'not_sent';
  }
  try {
    const { relay } = await client.get<RelayGetResponse>(`/api/relays/${relayId}`);
    if (relay.sendState === 'sent') return 'sent';
    if (relay.sendState === 'failed') return 'not_sent';
  } catch {
    // Not answerable either: the relay is left as it is.
  }
  return 'unknown';
}

/**
 * What to tell the sender about resending a failed send, from the server's
 * `sendOutcome` on the error (Issue #3992). Null when the error carries none
 * (a send that named no bound relay, an older server) or says `sent`.
 */
export function describeFailedSendOutcome(error: unknown, worktreeId: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const outcome: unknown = error.payload?.sendOutcome;
  if (outcome === 'not_sent') {
    return 'Note: the message was not sent (sendOutcome=not_sent); it is safe to send it again.';
  }
  if (outcome === 'unknown') {
    return (
      'Note: whether the message was sent is not known (sendOutcome=unknown); '
      + `check the pane first (\`commandmate capture ${worktreeId} --pane\`) and do not resend before that, `
      + 'or it may arrive twice.'
    );
  }
  return null;
}

/**
 * Post the message; on failure cancel the relay and report PROMPT_WAITING.
 *
 * Issue #3957: a bound relay is withdrawn only when nothing reached the worker
 * (`not_sent`). When that cannot be said the relay is left open, the message
 * is NOT resent, and stderr names the relay and how to look it up.
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
  const relayId = relay?.id;
  const body = relay?.bound ? { ...sendBody, relayId: relay.id } : sendBody;
  try {
    const sent = await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, body);
    if (relay?.bound && sent?.sendOutcome === 'unknown') printRelayUnconfirmedNotice(relay.id);
    return sent;
  } catch (error) {
    const outcome = relay?.bound ? await resolveBoundSendOutcome(client, relay.id, error) : null;
    // The answer was lost on the way back, and the server says it went out.
    if (outcome === 'sent') {
      return { worktreeId, role: 'user', content: '', sendOutcome: 'sent' };
    }
    if (options.onFailure) {
      await options.onFailure();
    }
    // A relay whose message never arrived can never be answered; leaving
    // it open would have the requester waiting 24h for a turn that was
    // never started.
    if (relayId && (outcome === null || outcome === 'not_sent')) {
      await cancelRelayQuietly(client, relayId);
    } else if (relayId && outcome === 'unknown') {
      // Issue #3992: the relay notice carries the "look before resending" hint.
      printRelayUnconfirmedNotice(relayId, worktreeId);
    }
    const promptWaiting = error instanceof ApiError && error.apiCode === PROMPT_WAITING_CODE;
    // Issue #3992: whether it may be sent again, as the server said — not on
    // PROMPT_WAITING, whose own line says to answer the prompt first, and not
    // when the relay notice above already said it.
    if (!promptWaiting && !(relayId && outcome === 'unknown')) {
      const resendNote = describeFailedSendOutcome(error, worktreeId);
      if (resendNote !== null) console.error(resendNote);
    }
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
    throw error;
  }
}
