/**
 * Sending a New task (Issue #3511).
 *
 * Two existing routes, nothing new on the server:
 *
 * 1. `POST /api/worktrees/[id]/auto-yes` — only when the user chose to arm
 *    Auto-Yes and it is not armed already. Armed BEFORE the send, the order
 *    `commandmate send --auto-yes` uses, so a dialog the agent raises on its
 *    first turn is already covered. The route arms ahead of a session that does
 *    not exist yet (its `absent` ownership verdict goes on).
 * 2. `POST /api/worktrees/[id]/send` — starts the session when it is not
 *    running, then types the request.
 *
 * Every refusal comes back as a {@link NewTaskSendResult} the dialog can name;
 * nothing here throws.
 */

import { ApiError, fetchApiResponse, type ApiRequestOptions } from '@/lib/api-client';
import { getSendTimeoutMs } from '@/config/api-timeout-config';
import type { AutoYesDuration } from '@/config/auto-yes-config';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { NewTaskTarget } from './recent-targets';

/**
 * The `code` values the send route answers with. Spelled here rather than
 * imported because their homes (`prompt-waiting-guard`, `resolve-session-target`)
 * pull in tmux and the database; `send-new-task-route-contract.test.ts` pins
 * each one to the server's constant.
 */
export const SEND_RESPONSE_CODES = {
  promptWaiting: 'PROMPT_WAITING',
  sessionStarting: 'SESSION_STARTING',
  instanceToolConflict: 'instance_tool_conflict',
} as const;

/** Why a send did not go out. */
export type NewTaskFailureKind =
  /** Arming Auto-Yes was refused, so nothing was sent. */
  | 'auto_yes_failed'
  /** 409 PROMPT_WAITING: the agent is on a prompt; nothing was typed. */
  | 'prompt_waiting'
  /** Any other 409 (a session another server owns). */
  | 'conflict'
  /** 503 SESSION_STARTING: the session is still coming up. */
  | 'starting'
  /** Any other 503 (not installed, exited to the shell). */
  | 'start_failed'
  /** 400 on a request that named a model. */
  | 'model_rejected'
  /** Any other 400. */
  | 'invalid'
  /** 5xx, no reply, a timeout. */
  | 'failed';

export type NewTaskSendResult =
  | { ok: true }
  | { ok: false; kind: NewTaskFailureKind; status: number; detail: string | null };

/** Read `{ error, code }` off an error body; anything else reads as empty. */
async function readErrorBody(response: Response): Promise<{ error: string | null; code: string | null }> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      const { error, code } = body as Record<string, unknown>;
      return {
        error: typeof error === 'string' && error !== '' ? error : null,
        code: typeof code === 'string' ? code : null,
      };
    }
  } catch {
    // An HTML page (an expired login) or an empty body.
  }
  return { error: null, code: null };
}

/** Classify the send route's answer. */
export async function interpretSendResponse(
  response: Response,
  { modelRequested }: { modelRequested: boolean },
): Promise<NewTaskSendResult> {
  // A 200 that arrived through a redirect is the login page, not the route.
  if (response.ok && !response.redirected) return { ok: true };
  const { status } = response;
  const { error, code } = await readErrorBody(response);
  let kind: NewTaskFailureKind;
  if (status === 409) {
    kind = code === SEND_RESPONSE_CODES.promptWaiting ? 'prompt_waiting' : 'conflict';
  } else if (status === 503) {
    kind = code === SEND_RESPONSE_CODES.sessionStarting ? 'starting' : 'start_failed';
  } else if (status === 400) {
    kind = modelRequested && code !== SEND_RESPONSE_CODES.instanceToolConflict
      ? 'model_rejected'
      : 'invalid';
  } else {
    kind = 'failed';
  }
  return { ok: false, kind, status: response.ok ? 0 : status, detail: error };
}

export interface SendNewTaskInput {
  target: NewTaskTarget;
  /** The roster's tool for the instance, sent alongside it like the composer does. */
  cliToolId: CLIToolType;
  content: string;
  /** Omitted when empty. */
  model?: string;
  /** Arm Auto-Yes for this long first; null leaves it as it is. */
  autoYesDuration: AutoYesDuration | null;
}

type Request = (url: string, options?: ApiRequestOptions) => Promise<Response>;

function transportFailure(error: unknown): NewTaskSendResult {
  const detail = error instanceof ApiError || error instanceof Error ? error.message : null;
  return { ok: false, kind: 'failed', status: 0, detail };
}

/** Arm Auto-Yes when asked, then send. */
export async function sendNewTask(
  input: SendNewTaskInput,
  request: Request = fetchApiResponse,
): Promise<NewTaskSendResult> {
  const { target, cliToolId } = input;
  const base = `/api/worktrees/${encodeURIComponent(target.worktreeId)}`;
  const headers = { 'Content-Type': 'application/json' };

  if (input.autoYesDuration !== null) {
    try {
      const response = await request(`${base}/auto-yes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          enabled: true,
          cliToolId,
          instanceId: target.instanceId,
          duration: input.autoYesDuration,
        }),
      });
      if (!response.ok) {
        const { error } = await readErrorBody(response);
        return { ok: false, kind: 'auto_yes_failed', status: response.status, detail: error };
      }
    } catch (error) {
      const failure = transportFailure(error);
      return failure.ok ? failure : { ...failure, kind: 'auto_yes_failed' };
    }
  }

  const model = input.model?.trim() || undefined;
  try {
    const response = await request(`${base}/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: input.content,
        cliToolId,
        instanceId: target.instanceId,
        ...(model ? { model } : {}),
      }),
      // With no session the server launches the agent inside this request (Issue #3194).
      timeoutMs: getSendTimeoutMs(),
    });
    return await interpretSendResponse(response, { modelRequested: model !== undefined });
  } catch (error) {
    return transportFailure(error);
  }
}
