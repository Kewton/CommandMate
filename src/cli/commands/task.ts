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
import type { TaskDetailResponse, TaskListResponse, TaskView } from '../types/api-responses';
import { ApiClient, assertResponseShape, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

const MAX_LIST_LIMIT = 100;

/** crypto.randomUUID() output; mirrors TASK_ID_PATTERN in the API route. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatTimestamp(value: string | null): string {
  return value ?? '-';
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
        console.log(`AUTO-YES:  ${task.contract.autoYes.mode ?? 'unset'}`);
        console.log(`CREATED:   ${task.createdAt}`);
        console.log(`STARTED:   ${formatTimestamp(task.startedAt)}`);
        console.log(`FINISHED:  ${formatTimestamp(task.finishedAt)}`);

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
