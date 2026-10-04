/**
 * Steps `send` and `ask` share when they hand a message to another session:
 * registering the relay before the message goes out, and posting the message
 * with the PROMPT_WAITING refusal reported the same way.
 *
 * Kept in its own module (not in send.ts / ask.ts) because tests mock those
 * modules' internals; what differs per command is passed in as arguments.
 */

import { ExitCode } from '../types';
import type { ChatMessage } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import {
  cancelRelayQuietly,
  registerRelay,
  resolveEndpointForWorktree,
  resolveRelayEndpoint,
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

/** Resolve both endpoints and open the relay; returns the relay id. */
export async function registerRelayForMessage(
  client: ApiClient,
  input: RegisterRelayForMessageInput
): Promise<string> {
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
  relayId?: string;
  /** Runs first when the post fails, before the relay is cancelled. */
  onFailure?: () => Promise<void>;
  /** Printed (after `Error: `) when PROMPT_WAITING carried no message body. */
  promptWaitingFallback: string;
}

/** Post the message; on failure cancel the relay and report PROMPT_WAITING. */
export async function postMessage(
  client: ApiClient,
  worktreeId: string,
  sendBody: Record<string, unknown>,
  options: PostMessageOptions
): Promise<void> {
  const { relayId } = options;
  try {
    await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
  } catch (error) {
    if (options.onFailure) {
      await options.onFailure();
    }
    // A relay whose message never arrived can never be answered; leaving
    // it open would have the requester waiting 24h for a turn that was
    // never started.
    if (relayId) {
      await cancelRelayQuietly(client, relayId);
    }
    // Issue #1708: the session is sitting on a prompt, so the message
    // would have been typed into the prompt's input line rather than
    // reaching the agent. Reported on its own so an unattended runner sees
    // "answer the prompt", not a generic HTTP failure.
    if (error instanceof ApiError && error.apiCode === PROMPT_WAITING_CODE) {
      // The server's own sentence, not error.message: handleApiError maps a
      // bare 409 to "Unexpected HTTP status: 409", which says nothing about
      // what to do next.
      console.error(`Error: ${error.payload?.error ?? options.promptWaitingFallback}`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
    throw error;
  }
}
