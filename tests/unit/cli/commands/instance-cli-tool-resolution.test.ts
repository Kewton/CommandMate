/**
 * CLI instance -> CLI tool resolution tests (Issue #1629)
 *
 * `--instance <id>` alone never told the server which CLI tool backs the
 * instance, so the server fell back to the worktree default: `send --instance
 * codex` started Claude, and `task show` reported `claude/codex`. The CLI now
 * resolves the roster entry once and sends the resolved tool explicitly, which
 * also fixes the endpoints that only ever trusted the caller's tool
 * (`/current-output` for capture, `/prompt-response` for respond).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

/** Roster response shape returned by GET /api/worktrees/:id. */
function roster(instances: Array<{ id: string; cliTool: string }>) {
  return {
    data: {
      id: 'wt1',
      name: 'main',
      agentInstances: instances.map((inst, order) => ({
        ...inst,
        alias: inst.id,
        order,
      })),
    },
  };
}

function bodyOf(call: [string, { body?: string }]): Record<string, unknown> {
  return JSON.parse(call[1].body ?? '{}');
}

describe('send --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('sends the roster instance\'s cliToolId when only --instance is given', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
      { data: { id: 1, role: 'user', content: 'hello' }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => String(c[0]).includes('/send'));
    expect(sendCall).toBeDefined();
    expect(bodyOf(sendCall as [string, { body?: string }])).toEqual({
      content: 'hello',
      cliToolId: 'codex',
      instanceId: 'codex',
    });
  });

  it('creates the --contract task against the resolved CLI tool', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
      { data: { task: { id: 'task-1' }, message: 'do the thing' }, status: 201 },
      { data: { id: 1, role: 'user', content: 'do the thing' }, status: 201 },
      { data: {}, status: 200 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', '--instance', 'codex', '--contract', '.commandmate/tasks/t.yaml',
    ]);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const taskCall = calls.find((c) => String(c[0]).includes('/tasks'));
    expect(taskCall).toBeDefined();
    expect(bodyOf(taskCall as [string, { body?: string }])).toEqual({
      contractPath: '.commandmate/tasks/t.yaml',
      cliToolId: 'codex',
      instanceId: 'codex',
    });
  });

  it('enables auto-yes against the resolved CLI tool', async () => {
    mockFetchSequence([
      roster([{ id: 'codex-2', cliTool: 'codex' }]),
      { data: {}, status: 200 },
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hi', '--instance', 'codex-2', '--auto-yes',
    ]);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const autoYesCall = calls.find((c) => String(c[0]).includes('/auto-yes'));
    expect(autoYesCall).toBeDefined();
    expect(bodyOf(autoYesCall as [string, { body?: string }])).toMatchObject({
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
  });

  it('rejects --agent that contradicts the roster before sending anything', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hello', '--agent', 'claude', '--instance', 'codex',
    ]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('codex'));
  });

  it('leaves the body unchanged for an instance the roster does not know', async () => {
    mockFetchSequence([
      roster([{ id: 'claude', cliTool: 'claude' }]),
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex-9']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => String(c[0]).includes('/send'));
    expect(bodyOf(sendCall as [string, { body?: string }])).toEqual({
      content: 'hello',
      instanceId: 'codex-9',
    });
  });

  it('does not fetch the roster when --instance is omitted', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('/send');
  });

  it('warns and falls back when the roster cannot be read', async () => {
    mockFetchSequence([
      { data: { error: 'boom' }, status: 500 },
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex']);

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => String(c[0]).includes('/send'));
    expect(bodyOf(sendCall as [string, { body?: string }])).toEqual({
      content: 'hello',
      instanceId: 'codex',
    });
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('capture --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('passes the resolved cliTool to /current-output', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
      { data: { content: 'pane text', fullOutput: 'pane text' } },
    ]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', 'wt1', '--instance', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const outputCall = calls.find((c) => String(c[0]).includes('/current-output'));
    expect(outputCall).toBeDefined();
    expect(String(outputCall?.[0])).toContain('cliTool=codex');
    expect(String(outputCall?.[0])).toContain('instance=codex');
  });

  it('does not fetch the roster when --instance is omitted', async () => {
    mockFetchSequence([{ data: { content: 'pane text', fullOutput: 'pane text' } }]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', 'wt1']);

    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('respond --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('passes the resolved cliTool to /prompt-response', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
      { data: { success: true } },
    ]);

    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', 'yes', '--instance', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const promptCall = calls.find((c) => String(c[0]).includes('/prompt-response'));
    expect(promptCall).toBeDefined();
    expect(bodyOf(promptCall as [string, { body?: string }])).toEqual({
      answer: 'yes',
      cliTool: 'codex',
      instanceId: 'codex',
    });
  });
});

describe('auto-yes --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('passes the resolved cliToolId to /auto-yes', async () => {
    mockFetchSequence([
      roster([{ id: 'codex', cliTool: 'codex' }]),
      { data: {} },
    ]);

    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    await createAutoYesCommand().parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--instance', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const autoYesCall = calls.find((c) => String(c[0]).includes('/auto-yes'));
    expect(autoYesCall).toBeDefined();
    expect(bodyOf(autoYesCall as [string, { body?: string }])).toMatchObject({
      cliToolId: 'codex',
      instanceId: 'codex',
    });
  });
});
