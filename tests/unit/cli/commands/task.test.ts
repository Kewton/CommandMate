/**
 * task Command Tests (Issue #1545, Phase 2-1)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';
import type { TaskView } from '../../../../src/cli/types/api-responses';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const TASK_ID = '11111111-2222-4333-8444-555555555555';

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    worktreeId: 'wt1',
    cliToolId: 'codex',
    instanceId: null,
    title: 'loader work',
    goal: 'do the work',
    contractPath: '.commandmate/tasks/t.yaml',
    contract: {
      version: 1,
      title: 'loader work',
      goal: 'do the work',
      scope: { allow: ['src/lib/tasks/**'], deny: [] },
      verify: { gates: ['lint'] },
      autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
      success: { requireWorkEvidence: true, requireScopeClean: true },
    },
    status: 'running',
    lastVerificationRunId: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

async function run(argv: string[]) {
  const { createTaskCommand } = await import('../../../../src/cli/commands/task');
  await createTaskCommand().parseAsync(['node', 'task', ...argv]);
}

const output = () => mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');

describe('task list', () => {
  it('prints one line per task with status, gates and title', async () => {
    mockFetchResponse({ tasks: [task()] });
    await run(['list', 'wt1']);

    expect(output()).toContain(TASK_ID);
    expect(output()).toContain('running');
    expect(output()).toContain('lint');
    expect(output()).toContain('loader work');
  });

  it('shows an all-gates contract as such rather than as an empty selection', async () => {
    mockFetchResponse({
      tasks: [task({ contract: { ...task().contract, verify: { gates: null } } })],
    });
    await run(['list', 'wt1']);

    expect(output()).toContain('all-gates');
  });

  it('emits JSON with --json', async () => {
    mockFetchResponse({ tasks: [task()] });
    await run(['list', 'wt1', '--json']);

    expect(JSON.parse(output())).toHaveLength(1);
  });

  it('says so on stderr when a worktree has no tasks, leaving stdout empty', async () => {
    mockFetchResponse({ tasks: [] });
    await run(['list', 'wt1']);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith("No tasks recorded for worktree 'wt1'.");
  });

  it('passes --limit through and rejects one out of range', async () => {
    mockFetchResponse({ tasks: [] });
    await run(['list', 'wt1', '--limit', '5']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/tasks?limit=5'),
      expect.anything()
    );

    await run(['list', 'wt1', '--limit', '0']);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('rejects a malformed worktree id', async () => {
    await run(['list', 'bad id!']);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Invalid worktree ID format.');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });
});

describe('task show', () => {
  it('prints the contract and states that no run has judged it yet', async () => {
    mockFetchResponse({ task: task(), lastVerificationRun: null });
    await run(['show', TASK_ID]);

    expect(output()).toContain('STATUS:    running');
    expect(output()).toContain('SCOPE:     src/lib/tasks/**');
    expect(output()).toContain('GATES:     lint');
    expect(output()).toContain('AUTO-YES:  safe');
    expect(output()).toContain('(no verification run yet)');
  });

  it('prints the gate verdicts of the run that last judged the task', async () => {
    mockFetchResponse({
      task: task({ status: 'failed', lastVerificationRunId: 9 }),
      lastVerificationRun: {
        id: 9,
        worktreeId: 'wt1',
        instanceId: null,
        taskId: TASK_ID,
        trigger: 'wait',
        status: 'failed',
        baseRef: 'origin/develop',
        startedAt: '2026-07-30T00:00:00.000Z',
        finishedAt: '2026-07-30T00:01:00.000Z',
        gates: [
          {
            id: 1,
            runId: 9,
            gateId: 'lint',
            command: 'npm run lint',
            status: 'failed',
            exitCode: 1,
            durationMs: 1200,
            logTail: null,
            startedAt: '2026-07-30T00:00:00.000Z',
            finishedAt: '2026-07-30T00:00:01.000Z',
          },
        ],
      },
    });
    await run(['show', TASK_ID]);

    expect(output()).toContain('VERIFY:    run 9 failed');
    expect(output()).toContain('GATE lint failed (exit=1)');
  });

  it('rejects an id that was never a task id', async () => {
    await run(['show', 'not-a-uuid']);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Invalid task ID format.');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });
});
