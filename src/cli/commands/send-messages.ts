/**
 * Message delivery helpers for `send` — the fallback line, the task's record and
 * the `--note` kept in mem — split out of `send.ts` (Issue #4128).
 */

import { ExitCode } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import { followUpCommand } from '../utils/follow-up-command';
import { isToolPolicyDenied } from '../utils/tool-policy-failure';
import type { FailedSendOutcome } from './message-dispatch';
import type { CommandTarget } from './command-target';
import { MEM_EXIT_BY_CODE, type MemErrorCode, type MemWriteResponse } from '../../types/mem';
import type { SessionIdentity } from './whoami';

/**
 * What to print when a PROMPT_WAITING response carried no message body — an
 * older daemon, or a truncated body. The code is the contract; the sentence is
 * a courtesy, and the CLI must still say what to do without it.
 */
export function promptWaitingFallback(worktreeId: string, target: CommandTarget): string {
  return (
    `${worktreeId} is waiting on a prompt; the message was not sent. ` +
    // Issue #3982: the prompt is the resolved target's, not the worktree default's.
    `Answer it first: \`${followUpCommand('respond', worktreeId, target, '<answer>')}\`.`
  );
}

/**
 * Whether a failed send is known to have typed nothing: the server's word, or a 4xx
 * refused before an attempt. Not known otherwise (no answer, a 5xx saying nothing).
 */
export function knownNotSent(error: unknown, outcome: FailedSendOutcome | null): boolean {
  // Issue #4437: refused by the tool policy before anything was typed.
  if (isToolPolicyDenied(error)) return true;
  if (outcome !== null) return outcome !== 'unknown';
  if (!(error instanceof ApiError)) return false;
  const reported = error.payload?.sendOutcome;
  if (reported !== undefined) return reported === 'not_sent';
  return error.statusCode !== undefined && error.statusCode < 500;
}

/**
 * Report a task transition to the server, best effort.
 *
 * A failure here is worth a warning but not the command's exit code: the
 * message either reached the agent or it did not, and that outcome is what the
 * caller is waiting on.
 */
export async function reportTaskStatus(
  client: ApiClient,
  taskId: string,
  status: 'running' | 'failed'
): Promise<void> {
  try {
    await client.patch<unknown>(`/api/tasks/${taskId}`, { status });
  } catch {
    console.error(`Warning: could not record task ${taskId} as ${status}.`);
  }
}

/**
 * Issue #4226: `--note` is kept in mem as a `waiting` item of the sender, closed by the
 * relay it opened (design `docs/design/mem-prompt-4226.md` §6). Only the note and the
 * relay's id go in: not the other session, not the time, not the message (D2).
 * Refused (mode not `on`, a check, the open limit, no answer): the caller undoes what
 * this send took and sends nothing. Never repeats the note in an error.
 *
 * @returns The item's id
 */
export async function writeSendNote(
  client: ApiClient,
  author: SessionIdentity,
  relayId: string,
  note: string,
  undo: () => Promise<void>
): Promise<string> {
  try {
    const written = await client.post<MemWriteResponse>(`/api/worktrees/${encodeURIComponent(author.worktreeId)}/mem/items`, {
      instanceId: author.instanceId,
      kind: 'waiting',
      text: note,
      closeWhen: `relay:${relayId}`,
      evidence: [`relay:${relayId}`],
      key: `send-note:${relayId}`,
    });
    console.error(`Note kept in mem: ${written.item.id}`);
    return written.item.id;
  } catch (error) {
    await undo();
    const payload = error instanceof ApiError ? ((error.payload ?? {}) as Record<string, unknown>) : {};
    const code = typeof payload.code === 'string' && payload.code in MEM_EXIT_BY_CODE ? (payload.code as MemErrorCode) : null;
    const detail = code ? `${code}${typeof payload.field === 'string' ? ` (field=${payload.field})` : ''}` : 'no answer from mem';
    console.error(`Error: --note could not be kept in mem (${detail}), so nothing was sent.`);
    process.exit(code ? MEM_EXIT_BY_CODE[code] : error instanceof ApiError && error.statusCode === undefined ? ExitCode.DEPENDENCY_ERROR : ExitCode.UNEXPECTED_ERROR);
  }
}

/** Issue #4226: a message known not to have gone in leaves its note closed, best effort. */
export async function closeSendNote(client: ApiClient, author: SessionIdentity, itemId: string): Promise<void> {
  try {
    await client.post<MemWriteResponse>(`/api/worktrees/${encodeURIComponent(author.worktreeId)}/mem/items/${encodeURIComponent(itemId)}/close`, {
      instanceId: author.instanceId,
      reason: 'send_not_sent',
    });
  } catch {
    console.error(`Warning: could not close the note ${itemId}; it closes once its relay is withdrawn.`);
  }
}
