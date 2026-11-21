/**
 * Auto-Yes handling for `send`, split out of `send.ts` (Issue #4128).
 */

import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { AutoYesContractPolicy, AutoYesSetResult } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import { parseDurationToMs, AUTO_YES_DURATION_FLAG_RANGE, DEFAULT_DURATION_FLAG } from '../config/duration-constants';
import { describeAnswerMode, describeContractPolicy } from './auto-yes';
import type { RelayEndpointArg } from './relays';

/**
 * Resolve --duration to milliseconds, exiting on an invalid value.
 *
 * Issue #1608: this is called from the option-validation block at the top of
 * the action, not from enableAutoYes(). enableAutoYes() runs after --contract
 * has already created the task row, so validating there left a `pending` task
 * behind for a message that was never sent.
 */
export function resolveAutoYesDurationMs(duration: string | undefined): number {
  const durationMs = parseDurationToMs(duration ?? DEFAULT_DURATION_FLAG);

  if (durationMs === null) {
    console.error(`Error: Invalid duration. Must be ${AUTO_YES_DURATION_FLAG_RANGE} (e.g. 5h).`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  return durationMs;
}

/**
 * Build auto-yes request body and send it to the API (DRY extraction).
 *
 * @param client - API client instance
 * @param worktreeId - Target worktree ID
 * @param options - Send command options containing auto-yes settings
 * @param durationMs - Duration already validated by resolveAutoYesDurationMs()
 * @param agent - CLI tool resolved for --instance (Issue #1629), else --agent
 * @param contractPolicy - The policy of the contract this send created (Issue #3723), else null
 * @param onlyIfOff - Refuse if a grant is on by the time it arrives (Issue #4132)
 * @param replyTo - The `--reply-to` relay still to be opened after arming (Issue #4449)
 * @param taskId - The task of `--contract`: the grant goes to its recorded target (Issue #4449)
 */
export async function enableAutoYes(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  durationMs: number,
  agent: string | undefined,
  instanceId: string | undefined,
  contractPolicy: AutoYesContractPolicy | null = null,
  onlyIfOff = false,
  replyTo?: RelayEndpointArg,
  taskId?: string
): Promise<AutoYesSetResult | undefined> {
  const autoYesBody: Record<string, unknown> = {
    enabled: true,
    duration: durationMs,
  };
  // Issue #4449: the relay this send opens after arming, judged before the grant is written.
  if (replyTo) {
    autoYesBody.replyTo = { worktreeId: replyTo.worktreeId, instanceId: replyTo.instanceId };
  }
  // Issue #4449: the grant of a --contract send is for the task's recorded target.
  if (taskId) {
    autoYesBody.taskId = taskId;
  }
  if (onlyIfOff) {
    autoYesBody.onlyIfOff = true;
  }
  if (agent) {
    autoYesBody.cliToolId = agent;
  }
  // Issue #896: per-instance auto-yes. When --instance is given, the poller keys
  // on worktreeId:cliToolId:instanceId so the targeted instance is auto-answered
  // independently of other instances of the same agent.
  if (instanceId) {
    autoYesBody.instanceId = instanceId;
  }
  if (options.stopPattern) {
    autoYesBody.stopPattern = options.stopPattern;
  }
  // Issue #3863: sent only when given, so the server keeps a live grant's mode.
  if (options.autoYesAnswerMode !== undefined) {
    autoYesBody.answerMode = options.autoYesAnswerMode;
  }

  // Issue #3723: the response is read now. It names what the contract on the
  // instance lets Auto-Yes answer; with `autoYes.mode: off` the poller this
  // armed answers nothing, and "Auto-yes enabled." alone said otherwise.
  const result = await client.post<AutoYesSetResult | undefined>(
    `/api/worktrees/${worktreeId}/auto-yes`,
    autoYesBody,
  );
  console.error('Auto-yes enabled.');
  // Issue #3863: the mode the server put it on with.
  const modeLine = describeAnswerMode(result?.answerMode, options.autoYesAnswerMode !== undefined);
  if (modeLine !== null) console.error(modeLine);
  // The server's reading wins when it has one. It has none for a `--contract`
  // send armed before the message goes out: the task is still `pending`, which
  // the server does not count as governing the instance (ACTIVE_TASK_STATUSES).
  // The contract this send just created is what will govern it, so its policy
  // is the one to describe then — a null from the server is not "no contract".
  for (const line of describeContractPolicy(result?.contractPolicy ?? contractPolicy)) {
    console.error(line);
  }
  return result;
}

/** The command that does what this send's --auto-yes asked for, on its own. */
export function enableAutoYesCommand(worktreeId: string, options: SendOptions, agent: string | undefined, instanceId: string | undefined): string {
  return [
    `commandmate auto-yes ${worktreeId} --enable --duration ${options.duration ?? DEFAULT_DURATION_FLAG}`,
    ...(instanceId ? [`--instance ${instanceId}`] : []),
    ...(agent && agent !== instanceId ? [`--agent ${agent}`] : []),
    ...(options.stopPattern ? [`--stop-pattern '${options.stopPattern.replace(/'/g, `'\\''`)}'`] : []),
    ...(options.autoYesAnswerMode ? [`--answer-mode ${options.autoYesAnswerMode}`] : []),
  ].join(' ');
}

/**
 * {@link enableAutoYes} once the message has gone out (Issue #4159). Whatever fails here is
 * a warning and the send stays a success, as with {@link registerInstance}: an error exit
 * reads as "not sent", and a script reading it would send the message twice. A 5xx or no
 * answer may have armed it, and a grant on before this send may still be, so this says "may".
 */
export async function enableAutoYesAfterSend(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  durationMs: number,
  agent: string | undefined,
  instanceId: string | undefined,
  contractPolicy: AutoYesContractPolicy | null,
  taskId: string | undefined
): Promise<void> {
  try {
    await enableAutoYes(client, worktreeId, options, durationMs, agent, instanceId, contractPolicy, false, undefined, taskId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `Warning: the message was sent, but Auto-Yes may not be on with this send's terms (${reason}). `
        + `Do not send it again. To enable it: ${enableAutoYesCommand(worktreeId, options, agent, instanceId)}`
    );
  }
}

/**
 * This target's Auto-Yes as the server reads it now, or null when it could not be read.
 * Always names both: a read naming no tool answers another question.
 */
export async function readAutoYes(
  client: ApiClient,
  worktreeId: string,
  target: { cliToolId: string; instanceId: string }
): Promise<Partial<AutoYesSetResult> | null> {
  try {
    const query = new URLSearchParams({ cliToolId: target.cliToolId, instanceId: target.instanceId });
    return await client.get(`/api/worktrees/${worktreeId}/auto-yes?${query.toString()}`);
  } catch {
    return null;
  }
}

/** The name the server gives a grant (Issue #4132). An older server gives none. */
export function grantIdOf(state: Pick<AutoYesSetResult, 'grantId'> | null | undefined): string | undefined {
  // The type is what the route should answer. An answer of another type is no name.
  const grantId: unknown = state?.grantId;
  return typeof grantId === 'string' ? grantId : undefined;
}

/** The command that stops one instance's Auto-Yes. An id that is no tool's own needs the tool as well. */
export function stopAutoYesCommand(worktreeId: string, instanceId: string | undefined, cliToolId: string | undefined): string {
  const agent = cliToolId !== undefined && cliToolId !== instanceId ? ` --agent ${cliToolId}` : '';
  return `commandmate auto-yes ${worktreeId} --disable --instance ${instanceId ?? '<instance-id>'}${agent}`;
}

/**
 * Turn off the grant this send armed, and no other (Issue #4116). It is read right
 * before, and the request itself says which grant it means (`expectedGrantId`, Issue
 * #4132), so a grant someone armed since is theirs and stays, even with the same expiry.
 * A server too old to name its grants cannot be asked for that: with only the read to go on,
 * a grant armed right after it would be stopped too, so it is left on (Issue #4159).
 * `{ enabled: false }` naming nobody would stop
 * every instance of the worktree, so tool and instance are always named. A grant answered
 * for another target than the one read beforehand may be overwriting one that was on,
 * and that read says nothing about it. Anything not certain is left on, with the command
 * that stops it.
 */
export async function withdrawArmedAutoYes(
  client: ApiClient,
  worktreeId: string,
  target: { cliToolId?: string; instanceId?: string } | null,
  armed: AutoYesSetResult | undefined
): Promise<void> {
  const cliToolId = armed?.cliToolId ?? target?.cliToolId;
  const instanceId = armed?.instanceId ?? target?.instanceId;
  const manual = stopAutoYesCommand(worktreeId, instanceId, cliToolId);
  const leave = (why: string): void => console.error(`Warning: Auto-Yes stays on (${why}). To turn it off: ${manual}`);
  if (target && (cliToolId !== target.cliToolId || instanceId !== target.instanceId)) {
    leave(`the server armed ${cliToolId}/${instanceId}, not the ${target.cliToolId}/${target.instanceId} this send read`);
    return;
  }
  if (!cliToolId || !instanceId || typeof armed?.expiresAt !== 'number') {
    leave('the grant this send armed could not be identified');
    return;
  }
  const now = await readAutoYes(client, worktreeId, { cliToolId, instanceId });
  if (now === null || typeof now.enabled !== 'boolean') {
    leave('it could not be read back');
    return;
  }
  if (!now.enabled) return;
  const grantId = grantIdOf(armed);
  if (grantId === undefined) {
    leave('this server does not name its grants, so turning it off could stop one armed since');
    return;
  }
  if (
    now.expiresAt !== armed.expiresAt
    || (armed.answerMode !== undefined && now.answerMode !== armed.answerMode)
    || grantIdOf(now) !== grantId
  ) {
    leave('it was updated after this send armed it');
    return;
  }
  try {
    await client.post<unknown>(`/api/worktrees/${worktreeId}/auto-yes?expectedGrantId=${encodeURIComponent(grantId)}`, { enabled: false, cliToolId, instanceId });
    console.error('Auto-yes withdrawn: the message was not sent.');
  } catch (error) {
    leave(
      error instanceof ApiError && error.apiCode === 'AUTO_YES_GRANT_CHANGED'
        ? 'it was updated after this send armed it'
        : 'the request to turn it off failed'
    );
  }
}
