/**
 * CLI instance -> CLI tool resolution tests (Issue #1629, rewired in #1925)
 *
 * `--instance <id>` alone never told the server which CLI tool backs the
 * instance, so the server fell back to the worktree default: `send --instance
 * codex` started Claude, and `task show` reported `claude/codex`. The CLI now
 * resolves the roster entry once and sends the resolved tool explicitly, which
 * also fixes the endpoints that only ever trusted the caller's tool
 * (`/current-output` for capture, `/prompt-response` for respond).
 *
 * Issue #1925 moved the resolution itself to the server
 * (GET /api/worktrees/:id/resolve-target) and left the CLI as its client, so
 * these tests now state the server's verdict instead of the roster the CLI used
 * to reason over. What they pin is unchanged: the resolved tool reaches every
 * endpoint the command touches.
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

/**
 * Response of GET /api/worktrees/:id/resolve-target (Issue #1925).
 *
 * Issue #1629 answered these tests with the roster (GET /api/worktrees/:id) and
 * let the CLI apply the precedence rules itself. The rules now live on the
 * server and the CLI reads the answer, so what a test states is the server's
 * verdict rather than the raw roster it was derived from.
 */
function resolveTarget(target: {
  cliToolId: string;
  instanceId: string;
  resolvedBy?: string;
  conflict?: { instanceId: string; rosterCliTool: string; requestedCliTool: string } | null;
}) {
  return {
    data: {
      cliToolId: target.cliToolId,
      instanceId: target.instanceId,
      resolvedBy: target.resolvedBy ?? 'roster',
      conflict: target.conflict ?? null,
    },
  };
}

function bodyOf(call: [string, { body?: string }]): Record<string, unknown> {
  return JSON.parse(call[1].body ?? '{}');
}

describe('send --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('sends the roster instance\'s cliToolId when only --instance is given', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
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
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
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
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex-2' }),
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
      resolveTarget({
        cliToolId: 'codex',
        instanceId: 'codex',
        conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
      }),
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hello', '--agent', 'claude', '--instance', 'codex',
    ]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('codex'));
  });

  /**
   * Issue #1925 changed what "the roster does not know this instance" produces.
   * The CLI used to send no cliToolId at all and leave the server to guess from
   * the worktree default — the guess the server makes anyway, but made without
   * the primary-anchor stage that only the server has. Now the server answers
   * first and the CLI repeats the answer, so the tool that names the session is
   * the tool that was actually resolved.
   */
  it('sends the tool the server resolved for an instance the roster does not know', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'claude', instanceId: 'codex-9', resolvedBy: 'worktree-default' }),
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex-9']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => String(c[0]).includes('/send'));
    expect(bodyOf(sendCall as [string, { body?: string }])).toEqual({
      content: 'hello',
      cliToolId: 'claude',
      instanceId: 'codex-9',
    });
  });

  /**
   * Issue #1925 / design §4 D5 決定 3: options that depend on the tool are
   * validated AFTER the tool is known. `--model` used to be judged against
   * `--agent` alone, so `--instance copilot-2 --model …` was rejected for not
   * repeating `--agent copilot` — the roster already said what copilot-2 was,
   * and the CLI was the only thing that did not know yet (#1909).
   */
  it('accepts --model once the instance resolves to a model-capable agent', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'copilot', instanceId: 'copilot-2' }),
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hello', '--instance', 'copilot-2', '--model', 'gpt-5-mini',
    ]);

    expect(mockExit).not.toHaveBeenCalled();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => String(c[0]).includes('/send'));
    expect(bodyOf(sendCall as [string, { body?: string }])).toEqual({
      content: 'hello',
      cliToolId: 'copilot',
      instanceId: 'copilot-2',
      model: 'gpt-5-mini',
    });
  });

  it('still rejects --model when the instance resolves to an agent without models', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hello', '--instance', 'codex', '--model', 'gpt-5-mini',
    ]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--model option requires'));
  });

  it('resolves nothing when --instance is omitted', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('/send');
  });

  /**
   * Issue #1925 / DR2-008: a failing resolve is not permission to resolve
   * locally. The local path has no primary-anchor stage, so degrading to it on
   * a 500 would land the message on whatever the degraded rules point at — and
   * would do it silently, at exactly the moment the server is unwell. Only the
   * capability probe's real 404 opens that door (see
   * session-target-resolve-fallback.test.ts).
   */
  it('does not send when the server fails to resolve the instance', async () => {
    mockFetchSequence([
      { data: { error: 'boom' }, status: 500 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/send'))).toBe(false);
    expect(mockExit).toHaveBeenCalled();
  });
});

describe('capture --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('passes the resolved cliTool to /current-output', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
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

  it('resolves nothing when --instance is omitted', async () => {
    mockFetchSequence([{ data: { content: 'pane text', fullOutput: 'pane text' } }]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', 'wt1']);

    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  /**
   * Issue #1925 / DR3-015: reading is not acting. `capture` is the inner call of
   * `.claude/skills/orchestrate-monitor/scripts/monitor.sh`, which skips the
   * poll and never advances its idle streak when capture exits non-zero — with
   * MAX_POLLS=0 as the operator default. A worker whose --agent disagrees with
   * the roster would leave that loop spinning silently forever, so the
   * contradiction is reported and the roster's agent is read.
   */
  it('reads the roster agent and warns when --agent contradicts it', async () => {
    mockFetchSequence([
      resolveTarget({
        cliToolId: 'codex',
        instanceId: 'codex',
        conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
      }),
      { data: { content: 'pane text', fullOutput: 'pane text' } },
    ]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync([
      'node', 'capture', 'wt1', '--instance', 'codex', '--agent', 'claude',
    ]);

    expect(mockExit).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const outputCall = calls.find((c) => String(c[0]).includes('/current-output'));
    expect(String(outputCall?.[0])).toContain('cliTool=codex');
  });
});

describe('respond --instance resolves the roster CLI tool (Issue #1629)', () => {
  it('passes the resolved cliTool to /prompt-response', async () => {
    mockFetchSequence([
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
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
      resolveTarget({ cliToolId: 'codex', instanceId: 'codex' }),
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
