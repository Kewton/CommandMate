/**
 * send --contract Tests (Issue #1545, Phase 2-1)
 *
 * The contract path asserts three things the pipeline depends on: the message
 * that reaches the agent is the server-composed one (not the raw goal), a
 * rejected contract exits 2 with every issue printed, and a send that never
 * landed leaves the task `failed` rather than `pending` forever.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';
import { MAX_STOP_PATTERN_LENGTH } from '../../../../src/cli/utils/api-client';

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
const COMPOSED_MESSAGE = '## 実行契約\n- 完了条件: npm run lint\n\n## タスク\ndo the work';

interface RouteResponse {
  status: number;
  data: unknown;
}

/**
 * Dispatch by URL rather than by call order: the command makes three different
 * requests and a strict sequence would pass even if it called them in an order
 * that could not work (status reported before the message was sent).
 */
function mockRoutes(routes: Array<{ match: string; method?: string; response: RouteResponse }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const route = routes.find(
      (candidate) =>
        url.includes(candidate.match) && (candidate.method ?? 'POST').toUpperCase() === method
    );
    if (!route) {
      return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    }
    const { status, data } = route.response;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
  return calls;
}

const TASK_CREATED: RouteResponse = {
  status: 201,
  data: { task: { id: TASK_ID, status: 'pending' }, message: COMPOSED_MESSAGE },
};

const SEND_OK: RouteResponse = {
  status: 201,
  data: { id: 1, role: 'user', content: COMPOSED_MESSAGE, worktreeId: 'wt1' },
};

async function runSend(argv: string[]) {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  await createSendCommand().parseAsync(['node', 'send', ...argv]);
}

/** Thrown by the terminating process.exit stand-in below. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * Run the command with a process.exit that actually stops the action, the way
 * the real one does (Issue #1608).
 *
 * The module-level spy is a no-op, so under it execution falls straight through
 * a rejected argument and goes on to create the task row anyway — which is
 * exactly what these tests exist to rule out. Without a terminating exit they
 * would pass whether or not the validation runs before the side effect.
 *
 * @returns the code of the first process.exit call, or undefined if none
 */
async function runSendUntilExit(argv: string[]): Promise<number | undefined> {
  let firstCode: number | undefined;
  mockExit.mockImplementation(((code?: number) => {
    const resolved = typeof code === 'number' ? code : 0;
    if (firstCode === undefined) {
      firstCode = resolved;
    }
    throw new ExitSignal(resolved);
  }) as never);
  try {
    await runSend(argv);
  } catch (error) {
    // The action's own catch turns the first ExitSignal into handleCommandError(),
    // which exits again; that second signal escapes parseAsync. Anything else is
    // a real failure and must not be swallowed.
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
  } finally {
    mockExit.mockImplementation((() => {}) as never);
  }
  return firstCode;
}

describe('send --contract', () => {
  it('sends the server-composed contract message, not the raw goal', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/send', response: SEND_OK },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);

    await runSend(['wt1', '--contract', '.commandmate/tasks/t.yaml']);

    const create = calls.find((c) => c.url.includes('/tasks'));
    expect(create?.body).toEqual({ contractPath: '.commandmate/tasks/t.yaml' });

    const send = calls.find((c) => c.url.includes('/send'));
    expect(send?.body).toEqual({ content: COMPOSED_MESSAGE });

    // Task creation must precede the send: the row is what the send is recorded against.
    expect(calls.findIndex((c) => c.url.includes('/tasks'))).toBeLessThan(
      calls.findIndex((c) => c.url.includes('/send'))
    );

    // The id goes to stdout so an orchestrator can capture it.
    expect(mockConsoleLog).toHaveBeenCalledWith(TASK_ID);
    expect(mockConsoleError).toHaveBeenCalledWith('Message sent.');
  });

  it('marks the task running only after the send succeeded', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/send', response: SEND_OK },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);

    await runSend(['wt1', '--contract', '.commandmate/tasks/t.yaml']);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ status: 'running' });
    expect(calls.findIndex((c) => c.url.includes('/send'))).toBeLessThan(
      calls.findIndex((c) => c.method === 'PATCH')
    );
  });

  it('forwards --agent and --instance so the task records who it was sent to', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/send', response: SEND_OK },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);

    await runSend([
      'wt1',
      '--contract',
      '.commandmate/tasks/t.yaml',
      '--agent',
      'codex',
      '--instance',
      'codex-2',
    ]);

    expect(calls.find((c) => c.url.includes('/tasks'))?.body).toEqual({
      contractPath: '.commandmate/tasks/t.yaml',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
  });

  it('prints every contract issue and exits 2 without sending', async () => {
    const calls = mockRoutes([
      {
        match: '/api/worktrees/wt1/tasks',
        response: {
          status: 400,
          data: {
            error: 'Invalid task contract',
            issues: ['version: must be 1 (got 3)', 'title: required, must be a non-empty string'],
          },
        },
      },
    ]);

    const code = await runSendUntilExit(['wt1', '--contract', '.commandmate/tasks/broken.yaml']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: invalid task contract:');
    expect(mockConsoleError).toHaveBeenCalledWith('  - version: must be 1 (got 3)');
    expect(mockConsoleError).toHaveBeenCalledWith(
      '  - title: required, must be a non-empty string'
    );
    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
    // The rejection is the server's, so the request had to be made — but
    // nothing may follow it.
    expect(calls.map((c) => c.url).filter((url) => !url.includes('/tasks'))).toEqual([]);
  });

  it('records the task as failed when the message could not be delivered', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/send', response: { status: 500, data: { error: 'boom' } } },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);

    await runSend(['wt1', '--contract', '.commandmate/tasks/t.yaml']);

    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'failed' });
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
    expect(mockExit).toHaveBeenCalled();
  });

  it('does not fail the command when the status report itself fails', async () => {
    mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/send', response: SEND_OK },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 500, data: {} } },
    ]);

    await runSend(['wt1', '--contract', '.commandmate/tasks/t.yaml']);

    expect(mockConsoleError).toHaveBeenCalledWith('Message sent.');
    expect(mockConsoleError).toHaveBeenCalledWith(
      `Warning: could not record task ${TASK_ID} as running.`
    );
  });
});

describe('send argument validation', () => {
  it('rejects a message argument alongside --contract', async () => {
    mockRoutes([{ match: '/api/worktrees/wt1/tasks', response: TASK_CREATED }]);
    await runSend(['wt1', 'hello', '--contract', '.commandmate/tasks/t.yaml']).catch(() => {});

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: --contract supplies the message; do not pass a message argument as well.'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('still requires a message when no contract is given', async () => {
    await runSend(['wt1']).catch(() => {});

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: a message argument is required unless --contract is given.'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });
});

/**
 * Issue #1608: the task row is a side effect, so every option that can be
 * judged from its own value must be judged before it. `--duration 2h` used to
 * be judged inside enableAutoYes(), which runs after the row exists: the
 * command printed `Task created: <id>` and then exited 2, leaving a `pending`
 * task for a message that was never sent.
 */
describe('send option validation happens before the task row is created', () => {
  const CONTRACT = ['--contract', '.commandmate/tasks/t.yaml'];
  const INVALID_DURATION = 'Error: Invalid duration. Must be one of: 1h, 3h, 8h';

  /** Every route the command could reach, so an early call is recorded rather than rejected. */
  function mockAllRoutes() {
    return mockRoutes([
      { match: '/api/worktrees/wt1/tasks', response: TASK_CREATED },
      { match: '/api/worktrees/wt1/auto-yes', response: { status: 200, data: {} } },
      { match: '/api/worktrees/wt1/send', response: SEND_OK },
      { match: '/api/worktrees/wt1', method: 'GET', response: { status: 200, data: { id: 'wt1', agentInstances: [] } } },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);
  }

  it('rejects an invalid --duration without creating the task row', async () => {
    const calls = mockAllRoutes();

    const code = await runSendUntilExit([
      'wt1',
      ...CONTRACT,
      '--agent',
      'claude',
      '--auto-yes',
      '--duration',
      '2h',
    ]);

    expect(mockConsoleError).toHaveBeenCalledWith(INVALID_DURATION);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
    // The reported symptom: `Task created: <id>` on stderr and the id on stdout,
    // for a message that never went out.
    expect(calls).toEqual([]);
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError).not.toHaveBeenCalledWith(expect.stringContaining('Task created:'));
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
  });

  it('rejects an invalid --duration even without --auto-yes, before sending', async () => {
    // --duration is validated on its own value, the same way --stop-pattern and
    // --model are: a value the CLI cannot honour is never silently dropped.
    const calls = mockAllRoutes();

    const code = await runSendUntilExit(['wt1', 'hello', '--duration', '90m']);

    expect(mockConsoleError).toHaveBeenCalledWith(INVALID_DURATION);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(calls).toEqual([]);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
  });

  /**
   * The symmetry the fix has to hold to: nothing that is checkable up front may
   * be checked after the task row exists. Each case is an argument the command
   * can reject on its own, paired with --contract so a leaked task row shows up.
   */
  const REJECTED_UP_FRONT: Array<{ name: string; argv: string[]; error: string }> = [
    {
      name: 'worktree id',
      argv: ['../invalid', ...CONTRACT],
      error: 'Error: Invalid worktree ID format.',
    },
    {
      name: '--agent',
      argv: ['wt1', ...CONTRACT, '--agent', 'not-an-agent'],
      error: 'Error: Invalid agent. Must be one of: ',
    },
    {
      name: '--instance',
      argv: ['wt1', ...CONTRACT, '--instance', 'bad instance!'],
      error: 'Error: Invalid --instance.',
    },
    {
      name: '--register without --instance',
      argv: ['wt1', ...CONTRACT, '--register'],
      error: 'Error: --register requires --instance.',
    },
    {
      name: '--register with a non-primary --instance and no --agent',
      argv: ['wt1', ...CONTRACT, '--instance', 'codex-2', '--register'],
      error: 'Error: --register requires --agent',
    },
    {
      name: '--stop-pattern length',
      argv: ['wt1', ...CONTRACT, '--auto-yes', '--stop-pattern', 'x'.repeat(MAX_STOP_PATTERN_LENGTH + 1)],
      error: 'Error: stop-pattern exceeds maximum length',
    },
    {
      name: '--model without a model-capable --agent',
      argv: ['wt1', ...CONTRACT, '--model', 'gpt-5-mini'],
      error: 'Error: --model option requires --agent copilot or --agent antigravity',
    },
    {
      name: '--model value',
      argv: ['wt1', ...CONTRACT, '--agent', 'copilot', '--model', 'model; rm -rf /'],
      error: 'Error: Invalid model name:',
    },
    {
      name: '--duration',
      argv: ['wt1', ...CONTRACT, '--auto-yes', '--duration', '2h'],
      error: INVALID_DURATION,
    },
  ];

  it.each(REJECTED_UP_FRONT)('rejects a bad $name with no request at all', async ({ argv, error }) => {
    const calls = mockAllRoutes();

    const code = await runSendUntilExit(argv);

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(calls).toEqual([]);
  });

  it('still enables auto-yes with a valid --duration, after the task row exists', async () => {
    const calls = mockAllRoutes();

    await runSend(['wt1', ...CONTRACT, '--agent', 'claude', '--auto-yes', '--duration', '3h']);

    const autoYes = calls.find((c) => c.url.includes('/auto-yes'));
    expect(autoYes?.body).toEqual({ enabled: true, duration: 10_800_000, cliToolId: 'claude' });
    expect(calls.findIndex((c) => c.url.includes('/tasks'))).toBeLessThan(
      calls.findIndex((c) => c.url.includes('/auto-yes'))
    );
    expect(calls.findIndex((c) => c.url.includes('/auto-yes'))).toBeLessThan(
      calls.findIndex((c) => c.url.includes('/send'))
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Message sent.');
  });

  it('defaults to 1h when --duration is omitted', async () => {
    const calls = mockAllRoutes();

    await runSend(['wt1', 'hello', '--auto-yes']);

    expect(calls.find((c) => c.url.includes('/auto-yes'))?.body).toEqual({
      enabled: true,
      duration: 3_600_000,
    });
  });
});
