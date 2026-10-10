/**
 * Sending a New task (Issue #3511).
 *
 * Two existing routes, nothing new on the server:
 *
 * 1. `POST /api/worktrees/[id]/auto-yes` — only when the user chose to arm
 *    Auto-Yes and it is not armed already. Always armed BEFORE the send, so a
 *    dialog the agent raises on its first turn is already covered. (The CLI is
 *    not the same everywhere: `commandmate send --auto-yes` arms first too,
 *    except with `--model` on a non-claude agent, where it arms AFTER the send
 *    so Auto-Yes does not answer copilot's `/model` interaction —
 *    `deferAutoYes` in `src/cli/commands/send.ts`. New task does not defer.)
 *    The route arms ahead of a session that does not exist yet (its `absent`
 *    ownership verdict goes on). When arming succeeds and the send then fails,
 *    the result still carries the armed state, because the server keeps it.
 * 2. `POST /api/worktrees/[id]/send` — starts the session when it is not
 *    running, then types the request.
 *
 * Every refusal comes back as a {@link NewTaskSendResult} the dialog can name;
 * nothing here throws, and nothing here waits forever: each request — its
 * headers AND its JSON body — must finish within the transport's own timeout
 * for that request ({@link withinDeadline}). `fetchApiResponse` bounds only the
 * wait for headers, and the dialog cannot be closed until this returns.
 */

import { ApiError, fetchApiResponse, type ApiRequestOptions } from '@/lib/api-client';
import { getSendTimeoutMs, resolveDefaultTimeoutMs } from '@/config/api-timeout-config';
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

/** Auto-Yes as this call left it armed on the server. */
export interface ArmedAutoYes {
  enabled: true;
  expiresAt: number;
}

export type NewTaskSendResult = (
  | { ok: true }
  | { ok: false; kind: NewTaskFailureKind; status: number; detail: string | null }
) & {
  /** Present only when this call armed Auto-Yes — whether or not the send then went out. */
  armedAutoYes?: ArmedAutoYes;
  /**
   * The auto-yes route answered 2xx, so the server holds Auto-Yes armed, but
   * the answer did not give its expiry. Not recorded as armed: a resend arms
   * again rather than skip on a guessed expiry. Arming again is safe but not a
   * no-op: the server sets enabledAt / expiresAt from its own clock on every
   * call, so a resend moves the expiry later.
   */
  autoYesStateUnknown?: true;
};

/**
 * The armed state the auto-yes route answered with, or null when the body does
 * not name an expiry. The server decides the expiry from when it enabled, so
 * it is never guessed from this side's clock (Issue #3563).
 */
async function readArmedState(response: Response): Promise<ArmedAutoYes | null> {
  try {
    const body: unknown = await response.json();
    const expiresAt = body && typeof body === 'object' ? (body as Record<string, unknown>).expiresAt : null;
    if (typeof expiresAt === 'number') return { enabled: true, expiresAt };
  } catch {
    // Unknown.
  }
  return null;
}

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

/**
 * Run one request — the fetch and the reading of its body — under a single
 * deadline of `timeoutMs`, the same budget `fetchApiResponse` gives the fetch.
 * Past it the work is abandoned and this rejects with the client's own
 * `timeout` ApiError, so a body that never finishes arriving cannot hold the
 * caller (Issue #3511).
 */
export function withinDeadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ApiError(`Request timed out after ${timeoutMs}ms`, 0, undefined, 'timeout'));
    }, timeoutMs);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Arm Auto-Yes when asked, then send. */
export async function sendNewTask(
  input: SendNewTaskInput,
  request: Request = fetchApiResponse,
): Promise<NewTaskSendResult> {
  const { target, cliToolId } = input;
  const base = `/api/worktrees/${encodeURIComponent(target.worktreeId)}`;
  const headers = { 'Content-Type': 'application/json' };

  let armedAutoYes: ArmedAutoYes | undefined;
  // Armed on the server, but the answer gave no expiry.
  let stateUnknown = false;
  const duration = input.autoYesDuration;
  if (duration !== null) {
    // Set once the route has answered 2xx: from then on the server holds it armed.
    let armedOnServer = false;
    let refusal: NewTaskSendResult | null;
    try {
      refusal = await withinDeadline(async (): Promise<NewTaskSendResult | null> => {
        const response = await request(`${base}/auto-yes`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            enabled: true,
            cliToolId,
            instanceId: target.instanceId,
            duration,
          }),
        });
        if (!response.ok) {
          const { error } = await readErrorBody(response);
          return { ok: false, kind: 'auto_yes_failed', status: response.status, detail: error };
        }
        armedOnServer = true;
        armedAutoYes = (await readArmedState(response)) ?? undefined;
        stateUnknown = armedAutoYes === undefined;
        return null;
      }, resolveDefaultTimeoutMs('POST'));
    } catch (error) {
      if (!armedOnServer) {
        const failure = transportFailure(error);
        return failure.ok ? failure : { ...failure, kind: 'auto_yes_failed' };
      }
      // Armed, but its body never finished: nothing is sent. The expiry is
      // unknown (the timeout's clock is not the server's enabling time), so
      // the state is reported unknown and a resend arms again.
      return { ...transportFailure(error), autoYesStateUnknown: true };
    }
    if (refusal) return refusal;
  }

  const withArmed = (result: NewTaskSendResult): NewTaskSendResult =>
    armedAutoYes ? { ...result, armedAutoYes } : stateUnknown ? { ...result, autoYesStateUnknown: true } : result;

  const model = input.model?.trim() || undefined;
  // With no session the server launches the agent inside this request (Issue #3194).
  const sendTimeoutMs = getSendTimeoutMs();
  try {
    return withArmed(
      await withinDeadline(async () => {
        const response = await request(`${base}/send`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            content: input.content,
            cliToolId,
            instanceId: target.instanceId,
            ...(model ? { model } : {}),
          }),
          timeoutMs: sendTimeoutMs,
        });
        return interpretSendResponse(response, { modelRequested: model !== undefined });
      }, sendTimeoutMs),
    );
  } catch (error) {
    return withArmed(transportFailure(error));
  }
}
