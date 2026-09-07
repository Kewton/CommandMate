/**
 * task Command - Inspect execution contracts and their outcomes
 * Issue #1545 (Phase 2-1)
 *
 * `task list` answers "what was this worktree asked to do", `task show` answers
 * "what did the gates say about it" — the two halves of a contract that used to
 * exist only inside the message text.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { TaskListOptions, TaskShowOptions } from '../types';
import type {
  RelayCountsResponse,
  RelayListResponse,
  TaskDetailResponse,
  TaskListResponse,
  TaskView,
} from '../types/api-responses';
import { ApiClient, assertResponseShape, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

const MAX_LIST_LIMIT = 100;

/** crypto.randomUUID() output; mirrors TASK_ID_PATTERN in the API route. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatTimestamp(value: string | null): string {
  return value ?? '-';
}

/**
 * The relay counts for the session this task ran in, or null (Issue #2377).
 *
 * Scoped to the task's own worktree AND instance, because that is the session a
 * relay would have been opened by or against — a worktree-wide count would put
 * another agent's delegations on this task's page.
 *
 * Best effort: a daemon with no relay ledger is one that answers 404 here, which
 * must not fail `task show`.
 */
async function readTaskRelayCounts(
  client: ApiClient,
  task: TaskView
): Promise<RelayCountsResponse | null> {
  const query = new URLSearchParams({ worktree: task.worktreeId });
  if (task.instanceId) query.set('instance', task.instanceId);
  try {
    const response = await client.get<RelayListResponse>(`/api/relays?${query.toString()}`);
    return response.counts ?? null;
  } catch {
    return null;
  }
}

function printTaskLine(task: TaskView): void {
  const gates = task.contract.verify.gates;
  console.log(
    [
      task.id,
      task.status,
      task.cliToolId + (task.instanceId ? `/${task.instanceId}` : ''),
      gates ? gates.join('+') : 'all-gates',
      task.title,
    ].join('\t')
  );
}

export function createTaskCommand(): Command {
  const cmd = new Command('task');
  cmd.description('List and inspect execution contracts (tasks)');

  // ---- task list ----
  cmd
    .command('list')
    .description('List tasks for a worktree, newest first')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--limit <n>', `Maximum tasks to list (1..${MAX_LIST_LIMIT})`, parseInt)
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: TaskListOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        if (
          options.limit !== undefined &&
          (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIST_LIMIT)
        ) {
          console.error(`Error: --limit must be an integer 1..${MAX_LIST_LIMIT}.`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });
        const query = options.limit === undefined ? '' : `?limit=${options.limit}`;
        const response = await client.get<TaskListResponse>(
          `/api/worktrees/${worktreeId}/tasks${query}`
        );
        const { tasks } = assertResponseShape<TaskListResponse>(
          response,
          ['tasks'],
          'GET /api/worktrees/:id/tasks'
        );

        if (options.json) {
          console.log(JSON.stringify(tasks));
          return;
        }

        if (tasks.length === 0) {
          console.error(`No tasks recorded for worktree '${worktreeId}'.`);
          return;
        }
        tasks.forEach(printTaskLine);
      } catch (error) {
        handleCommandError(error);
      }
    });

  // ---- task show ----
  cmd
    .command('show')
    .description('Show one task with the verification run that last judged it')
    .argument('<task-id>', 'Task ID')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (taskId: string, options: TaskShowOptions) => {
      try {
        if (!TASK_ID_PATTERN.test(taskId)) {
          console.error('Error: Invalid task ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });
        const response = await client.get<TaskDetailResponse>(`/api/tasks/${taskId}`);
        const detail = assertResponseShape<TaskDetailResponse>(
          response,
          ['task', 'lastVerificationRun'],
          'GET /api/tasks/:taskId'
        );

        if (options.json) {
          console.log(JSON.stringify(detail));
          return;
        }

        const { task, lastVerificationRun } = detail;
        console.log(`ID:        ${task.id}`);
        console.log(`STATUS:    ${task.status}`);
        console.log(`WORKTREE:  ${task.worktreeId}`);
        console.log(`AGENT:     ${task.cliToolId}${task.instanceId ? `/${task.instanceId}` : ''}`);
        console.log(`TITLE:     ${task.title}`);
        console.log(`CONTRACT:  ${task.contractPath ?? '-'}`);
        console.log(`SCOPE:     ${task.contract.scope.allow.join(', ') || '-'}`);
        if (task.contract.scope.deny.length > 0) {
          console.log(`DENY:      ${task.contract.scope.deny.join(', ')}`);
        }
        console.log(`GATES:     ${task.contract.verify.gates?.join(', ') ?? 'all-gates'}`);
        // Issue #1791: a gate the contract declares itself exists nowhere else
        // — verify.yaml can be opened, this cannot. Printing the id alone would
        // leave a reader unable to tell which criterion the run was judged by.
        for (const gate of task.contract.verify.gateDefinitions ?? []) {
          const mutex = gate.mutex ? `, mutex=${gate.mutex}` : '';
          console.log(
            `GATE-DEF:  ${gate.id}  ${gate.command}  (timeoutSec=${gate.timeoutSec}${mutex})`
          );
        }
        console.log(`AUTO-YES:  ${task.contract.autoYes.mode ?? 'unset'}`);
        console.log(`CREATED:   ${task.createdAt}`);
        console.log(`STARTED:   ${formatTimestamp(task.startedAt)}`);
        console.log(`FINISHED:  ${formatTimestamp(task.finishedAt)}`);

        // Issue #2377: what this session delegated, and what came back. Printed
        // before the verification block because it is about the same session,
        // whereas the run below is about one judgement of it.
        const relays = await readTaskRelayCounts(client, task);
        if (relays) {
          console.log(
            `RELAYS:    ${relays.delivered} delivered / ${relays.prompt} prompt / `
            + `${relays.expired} expired  (${relays.pending} open)`
          );
        }

        if (!lastVerificationRun) {
          console.log('VERIFY:    (no verification run yet)');
          return;
        }
        console.log(`VERIFY:    run ${lastVerificationRun.id} ${lastVerificationRun.status}`);
        for (const gate of lastVerificationRun.gates) {
          const exit = gate.exitCode === null ? '-' : String(gate.exitCode);
          console.log(`  GATE ${gate.gateId} ${gate.status} (exit=${exit})`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  return cmd;
}
