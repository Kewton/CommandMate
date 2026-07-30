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
    mockRoutes([
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

    await runSend(['wt1', '--contract', '.commandmate/tasks/broken.yaml']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: invalid task contract:');
    expect(mockConsoleError).toHaveBeenCalledWith('  - version: must be 1 (got 3)');
    expect(mockConsoleError).toHaveBeenCalledWith(
      '  - title: required, must be a non-empty string'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
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
