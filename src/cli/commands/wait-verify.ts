/**
 * wait Command - verification after a wait (--verify / --require-work) and exit-code merging
 * Issue #3964: split out of wait.ts.
 */

import { ExitCode, VerifyExitCode, WAIT_EXIT_CODE_PRIORITY, WaitExitCode } from '../types';
import type { WaitOptions } from '../types';
import type { TaskListResponse, TaskStatus } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import { runVerification, WORK_EVIDENCE_GATE_ID } from '../utils/verify-runner';

/** True when the caller asked for a verdict rather than "the agent stopped". */
export function verifyRequested(options: WaitOptions): boolean {
  return Boolean(options.verify || options.requireWork);
}

/**
 * Whether this poll outcome should still be handed to the verification gates.
 *
 * A completion is the obvious case. NOT_STARTED joins it (Issue #1628) so the
 * operator gets the gate results instead of a bare "no session": work committed
 * by an agent whose session has since gone away is still worth reporting. The
 * verdict is merged rather than substituted — mergeExitCode never lets a passing
 * run overwrite NOT_STARTED, so "wait never saw this agent" survives to the exit
 * code even when the gates are green.
 */
export function shouldVerify(exitCode: number, options: WaitOptions): boolean {
  if (!verifyRequested(options)) return false;
  return exitCode === WaitExitCode.SUCCESS || exitCode === VerifyExitCode.NOT_STARTED;
}

/**
 * Task statuses that mean "this wait is about that task".
 *
 * Mirrors ACTIVE_TASK_STATUSES in src/lib/db/tasks-db.ts. Deliberately narrower
 * than the set the server will attach a run to: this is a guess made from a
 * worktree id alone, and a task that had already finished before the wait began
 * is a different delegation, not this one.
 */
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'running',
  'waiting_input',
  'verifying',
]);

/**
 * Read the task this wait is about, before waiting for it (Issue #1620).
 *
 * Timing is the whole point. Agents are asked to run the gates themselves
 * before reporting completion, and doing so moves their task to a terminal
 * status — after which a verification run started with only a worktree id has
 * no contract to resolve, judges no scope, and still reports `passed`. Read
 * while the task is still in flight, the id survives that transition and the
 * run that follows is judged against the contract it was supposed to judge.
 *
 * Never throws: an unreadable ledger costs the attribution, and refusing to
 * verify over it would cost every gate.
 *
 * @returns the task id, or undefined to leave resolution to the server
 */
export async function resolveWaitedTaskId(
  client: ApiClient,
  worktreeId: string,
): Promise<string | undefined> {
  try {
    const data = await client.get<TaskListResponse>(
      `/api/worktrees/${worktreeId}/tasks?limit=1`,
    );
    const task = data?.tasks?.[0];
    if (!task || !IN_FLIGHT_TASK_STATUSES.has(task.status)) return undefined;
    return task.id;
  } catch (error) {
    console.error(
      `Note: could not read the task ledger for ${worktreeId} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        'verification will resolve its own task.',
    );
    return undefined;
  }
}

/**
 * Run verification for one worktree after its completion was detected.
 *
 * Swallows ApiError into an exit code: with several worktrees in flight, one
 * unreachable run must not abort the verdicts of the others.
 */
export async function verifyAfterWait(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
  taskId: string | undefined,
): Promise<number> {
  // --verify runs every gate, and work-evidence is always part of "every gate",
  // so combining it with --require-work is a superset rather than a conflict.
  const gateIds = options.verify ? undefined : [WORK_EVIDENCE_GATE_ID];
  try {
    const outcome = await runVerification(client, {
      worktreeId,
      trigger: 'wait',
      instanceId: options.instance,
      taskId,
      gateIds,
      // stdout stays reserved for the prompt JSON contract.
      resultStream: 'stderr',
    });
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    console.error(
      `Error: verification of ${worktreeId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Fold one worktree's exit code into the aggregate.
 *
 * Ranked codes (see WAIT_EXIT_CODE_PRIORITY) beat unranked infrastructure
 * codes, and among equals the first one observed stands.
 */
export function mergeExitCode(current: number, candidate: number): number {
  if (candidate === WaitExitCode.SUCCESS) return current;
  if (current === WaitExitCode.SUCCESS) return candidate;

  const rank = (code: number): number => {
    const index = WAIT_EXIT_CODE_PRIORITY.indexOf(code);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return rank(candidate) < rank(current) ? candidate : current;
}
