/**
 * The strict `respond` (Issue #3756):
 *
 *   commandmate respond <wt> --instance <id> --expect-screen <kind> \
 *     --observation <token> [--expect-target <folder>] [--operation-id <id>] [--json] <label>
 *
 * Answers only when the server's fresh capture still shows `<kind>` and the
 * observation token (`commandmate prompt`) still verifies. It goes to its own
 * endpoint, `POST /api/worktrees/:id/prompt-response/strict`, and NEVER falls
 * back to `/prompt-response`: a server without the endpoint is a stop (exit 40),
 * because the old route would send the answer unchecked.
 *
 * Exit codes: 0 answered / 40 nothing sent / 41 sent but not confirmed (do not
 * send again) / 2 bad arguments.
 */

import { randomUUID } from 'crypto';
import { ExitCode, StrictRespondExitCode } from '../types';
import type { RespondOptions } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import {
  isPromptObservationKind,
  isStrictRespondKind,
  STRICT_RESPOND_KINDS,
  UNNUMBERED_STRICT_RESPOND_KINDS,
} from '../../lib/prompt-observation/kinds';
import type { StrictRespondResult } from '../../lib/prompt-observation/types';
import { resolveCommandTarget } from './command-target';

/** Mirrors the server's check. */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ANSWERED_BY_PATTERN = /^[A-Za-z0-9_:/.@-]{1,160}$/;

/** Whether the strict respond was asked for: any of its options. */
export function isStrictRespond(options: RespondOptions): boolean {
  return (
    options.expectScreen !== undefined ||
    options.observation !== undefined ||
    options.expectTarget !== undefined ||
    options.operationId !== undefined
  );
}

/**
 * The strict respond's argument errors, or null. Exit 2, with nothing sent:
 * `--default` and an option number on an unnumbered screen are refused here
 * (the server refuses them too).
 */
export function strictRespondArgumentError(answer: string | undefined, options: RespondOptions): string | null {
  if (options.expectScreen === undefined || options.observation === undefined) {
    return 'Error: the strict respond needs both --expect-screen <kind> and --observation <token> (from `commandmate prompt`).';
  }
  if (!isPromptObservationKind(options.expectScreen)) {
    return `Error: --expect-screen must be a screen kind; the strict respond answers: ${STRICT_RESPOND_KINDS.join(', ')}.`;
  }
  if (options.default === true) {
    return 'Error: --default is refused with --expect-screen: name the option by its label.';
  }
  if (options.planReview !== undefined) {
    return 'Error: --plan-review and --expect-screen are mutually exclusive.';
  }
  if (answer === undefined || answer.trim() === '') {
    return 'Error: the strict respond needs the option label as <answer>.';
  }
  if (
    /^\d+$/.test(answer.trim()) &&
    isStrictRespondKind(options.expectScreen) &&
    UNNUMBERED_STRICT_RESPOND_KINDS.includes(options.expectScreen)
  ) {
    return `Error: ${options.expectScreen} numbers no option: answer with its label (e.g. "Yes").`;
  }
  if (options.operationId !== undefined && !OPERATION_ID_PATTERN.test(options.operationId)) {
    return 'Error: --operation-id must be 8-64 characters of [A-Za-z0-9_-].';
  }
  return null;
}

/** Who is answering, for the server's record: the agent session the CLI runs in, or `cli`. */
export function strictRespondActor(env: Record<string, string | undefined> = process.env): string {
  const worktree = env.CM_WORKTREE_ID ?? env.CM_AGENT_WORKTREE_ID;
  const instance = env.CM_INSTANCE_ID ?? env.CM_AGENT_INSTANCE_ID;
  if (!worktree || !instance) return 'cli';
  const actor = `agent:${worktree}/${instance}`;
  return ANSWERED_BY_PATTERN.test(actor) ? actor : 'cli';
}

/** A verdict made on this side, in the shape the server's results have. */
function localResult(
  options: RespondOptions,
  operationId: string,
  code: 40 | 41,
  reason: NonNullable<StrictRespondResult['reason']>,
  message: string
): StrictRespondResult {
  return {
    strictRespond: 1,
    code,
    delivery: code === 40 ? 'not-sent' : 'indeterminate',
    reason,
    message,
    expectedKind: options.expectScreen ?? '',
    observedKind: null,
    expectedTarget: options.expectTarget ?? null,
    observedTarget: null,
    operationId,
    answer: null,
    keysSent: 0,
    outcome: null,
    replayed: false,
  };
}

/** Whether an error body came from the strict route itself (an older server's 404 has no marker). */
function fromStrictRoute(error: ApiError): boolean {
  return (error.payload as Record<string, unknown> | undefined)?.strictRespond === 1;
}

/** The HTTP failure as a verdict, or null for a request the server refused as malformed (exit 2). */
function verdictOfApiError(error: ApiError, options: RespondOptions, operationId: string): StrictRespondResult | null {
  const status = error.statusCode;
  if ((status === 404 || status === 405) && !fromStrictRoute(error)) {
    return localResult(
      options,
      operationId,
      40,
      'strict_endpoint_missing',
      'The server has no strict respond endpoint (it is older than this CLI). Nothing was sent, and the ' +
        'answer was not sent through the unchecked /prompt-response either. Restart the server after updating.',
    );
  }
  if (status === 409) {
    return localResult(options, operationId, 40, 'session_conflict', `Nothing was sent: ${error.message}`);
  }
  if (status !== undefined && status >= 400 && status < 500) return null;
  // A 5xx, or no answer at all: the request may have been carried out.
  return localResult(
    options,
    operationId,
    41,
    'response_unknown',
    `The server's answer was lost (${error.message}); keys may have been sent. Do not answer again blindly: ` +
      `re-run with --operation-id ${operationId} to read the result of this one.`,
  );
}

function printResult(result: StrictRespondResult, options: RespondOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.code === 0 && result.answer !== null) {
    console.log(
      `Answered ${result.expectedKind} with option ${result.answer.position}: ${result.answer.label} ` +
        `(outcome: ${result.outcome}${result.replayed ? ', replayed' : ''})`,
    );
    return;
  }
  const observed = result.observedKind === null ? '' : ` Observed kind: ${result.observedKind}.`;
  const target = result.observedTarget === null ? '' : ` Observed target: ${result.observedTarget}.`;
  if (result.code === StrictRespondExitCode.NOT_SENT) {
    console.error(`Error: Answer was not sent. Reason: ${result.reason} — ${result.message}${observed}${target}`);
    console.error('Observe the screen again with `commandmate prompt` before answering.');
  } else {
    console.error(
      `Error: Keys were sent (${result.keysSent}, delivery ${result.delivery}) and the answer is not confirmed. ` +
        `Reason: ${result.reason} — ${result.message}${observed}`,
    );
    console.error('Do not send it again: look at the pane (`commandmate prompt` / `capture --pane`) first.');
  }
}

/** Run the strict respond; sets the exit code. */
export async function runStrictRespond(
  worktreeId: string,
  answer: string | undefined,
  options: RespondOptions,
): Promise<void> {
  const argumentError = strictRespondArgumentError(answer, options);
  if (argumentError !== null) {
    console.error(argumentError);
    process.exit(ExitCode.CONFIG_ERROR);
    return;
  }
  const operationId = options.operationId ?? randomUUID();
  const client = new ApiClient({ token: options.token });
  const { agent, instanceId } = await resolveCommandTarget(client, worktreeId, options.instance, options.agent);

  const body: Record<string, unknown> = {
    expectScreen: options.expectScreen,
    observation: options.observation,
    answer,
    operationId,
    answeredBy: strictRespondActor(),
  };
  if (options.expectTarget !== undefined) body.expectTarget = options.expectTarget;
  if (instanceId) body.instanceId = instanceId;
  if (agent) body.cliTool = agent;

  let result: StrictRespondResult;
  try {
    result = await client.post<StrictRespondResult>(`/api/worktrees/${worktreeId}/prompt-response/strict`, body);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const verdict = verdictOfApiError(error, options, operationId);
    if (verdict === null) {
      console.error(`Error: ${error.message}`);
      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }
    result = verdict;
  }
  if (result?.strictRespond !== 1 || ![0, 40, 41].includes(result.code)) {
    // Not this endpoint's answer: whatever served it, nothing says what happened.
    result = localResult(options, operationId, 41, 'response_unknown', 'The server answered with something that is not a strict respond result.');
  }
  printResult(result, options);
  if (result.code !== StrictRespondExitCode.SUCCESS) process.exit(result.code);
}
