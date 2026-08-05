/**
 * wait Command Tests
 * Issue #518, #520
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { VerifyExitCode, WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const baseOutput = {
  isRunning: false,
  isComplete: true,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false, // [S2-01] boolean type (was '' string)
  thinkingMessage: null,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'idle' as const, // Issue #520: default for isRunning=false
};

describe('createWaitCommand', () => {
  it('creates a Command named "wait"', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    expect(cmd.name()).toBe('wait');
  });
});

describe('wait command action', () => {
  it('exits 0 on completion (sessionStatus=ready, isPromptWaiting=false)', async () => {
    mockFetchSequence([{ data: { ...baseOutput, isRunning: true, sessionStatus: 'ready' as const } }]);
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('exits 10 on prompt detection with JSON output', async () => {
    const promptOutput = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
    };
    mockFetchSequence([{ data: promptOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    // Check JSON output on stdout
    expect(mockConsoleLog).toHaveBeenCalled();
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.worktreeId).toBe('wt1');
    expect(output.type).toBe('yes_no');
    expect(output.question).toBe('Continue?');
  });

  it('rejects invalid worktree ID', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', '../bad-id']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });
});

describe('WaitExitCode values', () => {
  it('SUCCESS is 0', () => {
    expect(WaitExitCode.SUCCESS).toBe(0);
  });

  it('PROMPT_DETECTED is 10', () => {
    expect(WaitExitCode.PROMPT_DETECTED).toBe(10);
  });

  it('TIMEOUT is 124', () => {
    expect(WaitExitCode.TIMEOUT).toBe(124);
  });
});

describe('Issue #520: sessionStatus completion detection', () => {
  it('exits 0 when sessionStatus is ready (task completed, Path B)', async () => {
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('continues polling when sessionStatus is running, then exits 0 on ready', async () => {
    vi.useFakeTimers();
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    // Advance past the poll interval to trigger second poll
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    // Should have logged a waiting message for the first poll
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Waiting:')
    );
  });

  it('continues polling when sessionStatus is waiting (selection list, no prompt)', async () => {
    vi.useFakeTimers();
    const waitingOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'claude_selection_list',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: waitingOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('prompt detection (exit 10) takes priority over sessionStatus', async () => {
    const promptWithWaiting = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'yes_no_prompt',
      promptData: { type: 'yes_no', question: 'Allow?', options: ['y', 'n'], status: 'pending' },
    };
    mockFetchSequence([{ data: promptWithWaiting }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('falls back to isRunning-only detection when sessionStatus is undefined (old server)', async () => {
    vi.useFakeTimers();
    // Old server does not return sessionStatus
    const oldServerRunning = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: undefined,
      sessionStatusReason: undefined,
    };
    const oldServerStopped = {
      ...baseOutput,
      isRunning: false,
      sessionStatus: undefined,
      sessionStatusReason: undefined,
    };
    mockFetchSequence([{ data: oldServerRunning }, { data: oldServerStopped }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    // First poll should have continued (waiting message)
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Waiting:')
    );
  });

  it('exits 0 when sessionStatus is ready with no_recent_output reason', async () => {
    const noRecentOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'no_recent_output',
    };
    mockFetchSequence([{ data: noRecentOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('sessionStatus ready resolves before stall-timeout fires', async () => {
    vi.useFakeTimers();
    // First poll: running, second poll: ready (within stall-timeout window)
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      content: 'output-1',
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      content: 'output-1', // same content (would stall)
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1', '--stall-timeout', '300']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  // Issue #1628: Path A used to answer SUCCESS for BOTH "the session ended after
  // the agent worked" and "no session was ever there". The second reading turned a
  // wait on a worktree whose agent never started into an instant `Completed`, which
  // then handed a verdict to --verify over work nobody in this wait had watched.
  describe('Issue #1628: a session that was never running is not a completion', () => {
    const notRunning = {
      ...baseOutput,
      isRunning: false,
      sessionStatus: 'idle' as const,
      sessionStatusReason: 'session_not_running',
    };

    it('exits 21 (NOT_STARTED), not 0, when the first poll finds no session', async () => {
      mockFetchSequence([{ data: notRunning }]);

      const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
      await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

      expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
      expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Not started: wt1'));
      expect(mockConsoleError).not.toHaveBeenCalledWith(expect.stringContaining('Completed:'));
    });

    it('still exits 0 when the session goes away after having been seen running', async () => {
      vi.useFakeTimers();
      const running = {
        ...baseOutput,
        isRunning: true,
        isComplete: false,
        sessionStatus: 'running' as const,
        sessionStatusReason: 'thinking_indicator',
      };
      mockFetchSequence([{ data: running }, { data: notRunning }]);

      const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
      const promise = createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Completed: wt1'));
    });
  });

  // Issue #1628: arrow-key menus (Codex `/model` and its pager, antigravity's
  // permission menu, OpenCode's overlays) are published with isPromptWaiting=false
  // so the UI renders NavigationButtons. `wait` used to have no signal for them at
  // all and polled a stopped agent until --timeout.
  describe('Issue #1628: an active selection list is a blocked agent', () => {
    const selectionList = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      promptData: null,
      cliToolId: 'codex',
      isSelectionListActive: true,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'codex_selection_list',
    };

    it('exits 10 with a selection_list payload instead of polling until timeout', async () => {
      mockFetchSequence([{ data: selectionList }]);

      const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
      await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

      expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
      const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(output).toMatchObject({
        worktreeId: 'wt1',
        cliToolId: 'codex',
        type: 'selection_list',
        question: 'codex_selection_list',
      });
    });

    it('keeps waiting under --on-prompt human', async () => {
      vi.useFakeTimers();
      const ready = { ...baseOutput, isRunning: true, sessionStatus: 'ready' as const };
      mockFetchSequence([{ data: selectionList }, { data: ready }]);

      const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
      const promise = createWaitCommand().parseAsync([
        'node', 'wait', 'wt1', '--on-prompt', 'human',
      ]);
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Selection list active on wt1'),
      );
    });
  });

  it('includes sessionStatus in progress message', async () => {
    vi.useFakeTimers();
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    // Verify progress message includes sessionStatus [DR1-05]
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('status=running')
    );
  });
});

// =============================================================================
// Issue #1544: --verify / --require-work
// =============================================================================

interface Route {
  match: (url: string, method: string) => boolean;
  data: unknown;
  status?: number;
}

/**
 * Route fetch by URL instead of by call order.
 *
 * Multi-worktree waits poll concurrently, so a positional sequence cannot
 * express "wt1 completed, wt2 is still running" without encoding an
 * interleaving the implementation is free to change.
 */
function mockFetchRoutes(routes: Route[]) {
  const fn = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const route = routes.find(r => r.match(u, method));
    if (!route) throw new Error(`unmocked request: ${method} ${u}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.data),
      text: () => Promise.resolve(JSON.stringify(route.data)),
    };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function callSignatures(fn: ReturnType<typeof mockFetchRoutes>): string[] {
  return fn.mock.calls.map(call => {
    const init = call[1] as { method?: string } | undefined;
    return `${init?.method ?? 'GET'} ${new URL(String(call[0])).pathname}`;
  });
}

function verifyRun(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'wait',
    status: 'passed',
    baseRef: 'origin/develop',
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:01:00.000Z',
    gates: [],
    ...over,
  };
}

/**
 * A worktree whose agent has finished its turn with the session still alive —
 * the normal shape of a completion (Path B). Issue #1628 stopped treating a
 * session that was never running as a completion, so these verification tests
 * must show an agent that actually ran.
 */
const completedOutput = { ...baseOutput, isRunning: true, sessionStatus: 'ready' as const };

/** tasks + current-output + verify routes for one worktree that completes immediately. */
function completedWorktreeRoutes(
  id: string,
  runId: number,
  status: string,
  tasks: unknown[] = [],
): Route[] {
  return [
    { match: u => u.includes(`/api/worktrees/${id}/tasks`), data: { tasks } },
    { match: u => u.includes(`/api/worktrees/${id}/current-output`), data: completedOutput },
    {
      match: (u, m) => m === 'POST' && u.endsWith(`/api/worktrees/${id}/verify`),
      data: { runId },
      status: 202,
    },
    {
      match: u => u.endsWith(`/api/worktrees/${id}/verify/runs/${runId}`),
      data: { run: verifyRun({ id: runId, worktreeId: id, status }) },
    },
  ];
}

describe('Issue #1544: wait --verify / --require-work', () => {
  it('declares both options', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const flags = createWaitCommand().options.map(opt => opt.long);
    expect(flags).toEqual(expect.arrayContaining(['--verify', '--require-work']));
  });

  it('does not verify at all without --verify / --require-work', async () => {
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/current-output'), data: completedOutput },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(callSignatures(fetchMock)).toEqual(['GET /api/worktrees/wt1/current-output']);
  });

  it('chains verify after completion and exits 20 when a gate fails', async () => {
    const fetchMock = mockFetchRoutes(completedWorktreeRoutes('wt1', 1, 'failed'));

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(callSignatures(fetchMock)).toEqual([
      'GET /api/worktrees/wt1/tasks',
      'GET /api/worktrees/wt1/current-output',
      'POST /api/worktrees/wt1/verify',
      'GET /api/worktrees/wt1/verify/runs/1',
    ]);
  });

  it('exits 0 when every gate passes', async () => {
    mockFetchRoutes(completedWorktreeRoutes('wt1', 1, 'passed'));

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  // Issue #1628: the exact shape the Epic #1585 acceptance run hit — a wait that
  // never saw a session, followed by gates that pass because SOME uncommitted
  // change exists. The gates still run (their output is what the operator needs)
  // but a green run must not promote "nobody watched this agent" to success.
  it('runs the gates for a never-running session yet still exits 21, not 0', async () => {
    const routes = completedWorktreeRoutes('wt1', 1, 'passed').map(route =>
      route.match('/api/worktrees/wt1/current-output', 'GET')
        ? {
            ...route,
            data: {
              ...baseOutput,
              isRunning: false,
              sessionStatus: 'idle' as const,
              sessionStatusReason: 'session_not_running',
            },
          }
        : route,
    );
    const fetchMock = mockFetchRoutes(routes);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(callSignatures(fetchMock)).toContain('POST /api/worktrees/wt1/verify');
  });

  it('sends trigger=wait and all gates for --verify', async () => {
    const fetchMock = mockFetchRoutes(completedWorktreeRoutes('wt1', 1, 'passed'));

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    const post = fetchMock.mock.calls.find(c => (c[1] as { method?: string })?.method === 'POST');
    expect(JSON.parse((post![1] as { body: string }).body)).toEqual({
      trigger: 'wait',
      instanceId: undefined,
      gateIds: undefined,
      taskId: undefined,
    });
  });

  it('--require-work alone runs only the work-evidence gate and exits 21 when it fails', async () => {
    const fetchMock = mockFetchRoutes(completedWorktreeRoutes('wt1', 1, 'not_started'));

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--require-work']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    const post = fetchMock.mock.calls.find(c => (c[1] as { method?: string })?.method === 'POST');
    expect(JSON.parse((post![1] as { body: string }).body).gateIds).toEqual(['work-evidence']);
  });

  it('--verify subsumes --require-work rather than erroring on the pair', async () => {
    const fetchMock = mockFetchRoutes(completedWorktreeRoutes('wt1', 1, 'passed'));

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify', '--require-work']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    const post = fetchMock.mock.calls.find(c => (c[1] as { method?: string })?.method === 'POST');
    expect(JSON.parse((post![1] as { body: string }).body).gateIds).toBeUndefined();
  });

  it('does not verify when a prompt is detected (exit 10 wins)', async () => {
    const promptOutput = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
    };
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/api/worktrees/wt1/tasks'), data: { tasks: [] } },
      { match: u => u.includes('/current-output'), data: promptOutput },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    // Decidable proof that verify never ran: the task lookup and the single
    // poll are the only requests.
    expect(callSignatures(fetchMock)).toEqual([
      'GET /api/worktrees/wt1/tasks',
      'GET /api/worktrees/wt1/current-output',
    ]);
  });

  it('runs verify serially across worktrees', async () => {
    const fetchMock = mockFetchRoutes([
      ...completedWorktreeRoutes('wt1', 1, 'passed'),
      ...completedWorktreeRoutes('wt2', 2, 'passed'),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', 'wt2', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    // Concurrent verification would interleave the two POSTs before either GET.
    expect(callSignatures(fetchMock)).toEqual([
      'GET /api/worktrees/wt1/tasks',
      'GET /api/worktrees/wt2/tasks',
      'GET /api/worktrees/wt1/current-output',
      'GET /api/worktrees/wt2/current-output',
      'POST /api/worktrees/wt1/verify',
      'GET /api/worktrees/wt1/verify/runs/1',
      'POST /api/worktrees/wt2/verify',
      'GET /api/worktrees/wt2/verify/runs/2',
    ]);
  });

  it('aggregates: PROMPT_DETECTED(10) outranks VERIFY_FAILED(20)', async () => {
    const promptOutput = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      promptData: { type: 'yes_no', question: 'Continue?', options: ['yes'], status: 'pending' },
    };
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/api/worktrees/wt1/current-output'), data: promptOutput },
      ...completedWorktreeRoutes('wt2', 2, 'failed'),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', 'wt2', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    // wt2 was still verified; the priority is about the aggregate, not about skipping work.
    expect(callSignatures(fetchMock)).toContain('POST /api/worktrees/wt2/verify');
  });

  it('aggregates: VERIFY_FAILED(20) outranks NOT_STARTED(21)', async () => {
    mockFetchRoutes([
      ...completedWorktreeRoutes('wt1', 1, 'not_started'),
      ...completedWorktreeRoutes('wt2', 2, 'failed'),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', 'wt2', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });

  it('aggregates: NOT_STARTED(21) outranks TIMEOUT(124)', async () => {
    vi.useFakeTimers();
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      sessionStatus: 'running' as const,
    };
    mockFetchRoutes([
      ...completedWorktreeRoutes('wt1', 1, 'not_started'),
      { match: u => u.includes('/api/worktrees/wt2/current-output'), data: runningOutput },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync([
      'node', 'wait', 'wt1', 'wt2', '--verify', '--timeout', '5',
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });

  it('a verify API failure yields its exit code instead of a false success', async () => {
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/api/worktrees/wt1/tasks'), data: { tasks: [] } },
      { match: u => u.includes('/current-output'), data: completedOutput },
      {
        match: (u, m) => m === 'POST' && u.endsWith('/api/worktrees/wt1/verify'),
        data: { error: "Verification run 9 is already running for worktree 'wt1'", runningRunId: 9 },
        status: 409,
      },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("already in progress for 'wt1' (run 9)")
    );
    expect(callSignatures(fetchMock)).toEqual([
      'GET /api/worktrees/wt1/tasks',
      'GET /api/worktrees/wt1/current-output',
      'POST /api/worktrees/wt1/verify',
    ]);
  });
});

// =============================================================================
// Issue #1620: bind the task the wait was about
// =============================================================================

/**
 * A worker that verifies its own work — which the contract asks it to do —
 * moves its task to `succeeded`. The verification the orchestrator runs
 * afterwards then found no *active* task, judged no scope, and still reported
 * `passed`. The fix is temporal: the task id is resolved when the wait starts,
 * while the task is still in flight, and named on the run that follows.
 */
describe('Issue #1620: wait --verify binds the task it waited on', () => {
  const TASK_ID = '11111111-2222-4333-8444-555555555555';

  function postBody(fetchMock: ReturnType<typeof mockFetchRoutes>): Record<string, unknown> {
    const post = fetchMock.mock.calls.find(c => (c[1] as { method?: string })?.method === 'POST');
    return JSON.parse((post![1] as { body: string }).body);
  }

  it('names the task that was active when the wait started', async () => {
    const fetchMock = mockFetchRoutes(
      completedWorktreeRoutes('wt1', 1, 'passed', [{ id: TASK_ID, status: 'running' }]),
    );

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(postBody(fetchMock).taskId).toBe(TASK_ID);
    // Resolved before the first poll: after it, the worker's own verification
    // may already have closed the task.
    expect(callSignatures(fetchMock)[0]).toBe('GET /api/worktrees/wt1/tasks');
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=1');
  });

  it('still names it after the worker closed the task mid-wait', async () => {
    // The lookup happens once, up front; nothing re-reads the ledger later, so
    // a task that reaches `succeeded` while the agent finishes is still named.
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/api/worktrees/wt1/tasks'), data: { tasks: [{ id: TASK_ID, status: 'verifying' }] } },
      ...completedWorktreeRoutes('wt1', 1, 'passed').slice(1),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(postBody(fetchMock).taskId).toBe(TASK_ID);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('names no task when the newest one was already closed before the wait', async () => {
    // The paired case. Binding whatever is newest would let a wait on unrelated
    // work be judged against a contract that finished days ago.
    const fetchMock = mockFetchRoutes(
      completedWorktreeRoutes('wt1', 1, 'passed', [{ id: TASK_ID, status: 'succeeded' }]),
    );

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(postBody(fetchMock).taskId).toBeUndefined();
  });

  it('names the task for --require-work too', async () => {
    const fetchMock = mockFetchRoutes(
      completedWorktreeRoutes('wt1', 1, 'passed', [{ id: TASK_ID, status: 'running' }]),
    );

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--require-work']);

    expect(postBody(fetchMock).taskId).toBe(TASK_ID);
  });

  it('verifies anyway when the task ledger cannot be read', async () => {
    // An unreachable ledger is not a verdict. Losing the binding costs the
    // scope attribution; refusing to verify would cost every gate.
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/api/worktrees/wt1/tasks'), data: { error: 'boom' }, status: 500 },
      ...completedWorktreeRoutes('wt1', 1, 'passed').slice(1),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--verify']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(postBody(fetchMock).taskId).toBeUndefined();
  });

  it('does not read the ledger when no verification was asked for', async () => {
    const fetchMock = mockFetchRoutes([
      { match: u => u.includes('/current-output'), data: completedOutput },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    expect(callSignatures(fetchMock)).toEqual(['GET /api/worktrees/wt1/current-output']);
  });

  it('binds each worktree to its own task', async () => {
    const OTHER = '99999999-2222-4333-8444-555555555555';
    const fetchMock = mockFetchRoutes([
      ...completedWorktreeRoutes('wt1', 1, 'passed', [{ id: TASK_ID, status: 'running' }]),
      ...completedWorktreeRoutes('wt2', 2, 'passed', [{ id: OTHER, status: 'running' }]),
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', 'wt2', '--verify']);

    const posts = fetchMock.mock.calls
      .filter(c => (c[1] as { method?: string })?.method === 'POST')
      .map(c => [
        new URL(String(c[0])).pathname,
        JSON.parse((c[1] as { body: string }).body).taskId,
      ]);
    expect(posts).toEqual([
      ['/api/worktrees/wt1/verify', TASK_ID],
      ['/api/worktrees/wt2/verify', OTHER],
    ]);
  });
});

/**
 * Issue #1699: a prompt Auto-Yes refused to answer must say so.
 *
 * Before this, `wait` printed "Waiting for human response..." either way, so a
 * deny pattern that had latched onto a finished turn and was suppressing every
 * subsequent prompt looked exactly like an ordinary wait for a human. Two
 * workers sat stalled behind that ambiguity for the better part of an hour.
 */
describe('Issue #1699: policy suppression is reported while waiting', () => {
  const suppression = {
    reason: 'deny-pattern',
    mode: 'allow-listed',
    promptType: 'multiple_choice',
    pattern: 'rm -rf',
    at: Date.now(),
  };

  const suppressedPrompt = (lastSuppression: unknown) => ({
    ...baseOutput,
    isRunning: true,
    isPromptWaiting: true,
    sessionStatus: 'waiting' as const,
    promptData: {
      type: 'multiple_choice',
      question: 'Do you want to make this edit to foo.ts?',
      options: [{ number: 1, label: 'Yes', isDefault: true }],
      status: 'pending',
      approvalTarget: 'Edit file\n\n  src/foo.ts\n\nDo you want to make this edit to foo.ts?',
    },
    autoYes: { enabled: true, expiresAt: null, lastSuppression },
  });

  it('names the reason and pattern on stderr in --on-prompt human mode', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      { data: suppressedPrompt({ ...suppression, at: Date.now() }) },
      { data: { ...baseOutput, isRunning: true, sessionStatus: 'ready' as const } },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync([
      'node', 'wait', 'wt1', '--on-prompt', 'human',
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    const stderr = mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
    expect(stderr).toContain('Waiting for human response');
    expect(stderr).toContain('auto-yes suppressed this prompt by contract policy');
    expect(stderr).toContain('reason=deny-pattern');
    expect(stderr).toContain('pattern="rm -rf"');
  });

  it('carries the suppression and the judged text in the exit-10 payload', async () => {
    mockFetchSequence([{ data: suppressedPrompt({ ...suppression, at: Date.now() }) }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.autoYesSuppression).toMatchObject({
      reason: 'deny-pattern',
      mode: 'allow-listed',
      pattern: 'rm -rf',
    });
    expect(output.approvalTarget).toContain('src/foo.ts');
  });

  it('stays silent about a suppression that is no longer being refreshed', async () => {
    // The record is rewritten on every poll while the prompt is on screen, so a
    // stale one belongs to some earlier prompt and is not why this wait is stuck.
    mockFetchSequence([
      { data: suppressedPrompt({ ...suppression, at: Date.now() - 10 * 60_000 }) },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    const stderr = mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
    expect(stderr).not.toContain('auto-yes suppressed');
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.autoYesSuppression).toBeUndefined();
  });

  it('says nothing when no policy is in force', async () => {
    mockFetchSequence([{ data: suppressedPrompt(null) }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);

    const stderr = mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
    expect(stderr).not.toContain('auto-yes suppressed');
  });
});
