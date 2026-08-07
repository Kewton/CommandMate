/**
 * send Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

describe('createSendCommand', () => {
  it('creates a Command named "send"', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    expect(cmd.name()).toBe('send');
  });
});

describe('send command action', () => {
  it('sends message with content key', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'hello', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello world']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'hello world' }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Message sent.');
  });

  it('sends with --agent flag (cliToolId)', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'test', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--agent', 'codex']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        body: JSON.stringify({ content: 'test', cliToolId: 'codex' }),
      })
    );
  });

  it('enables auto-yes before sending when --auto-yes', async () => {
    // Two API calls: auto-yes then send
    const mockFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') })
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') });
    global.fetch = mockFn;

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--auto-yes']);

    expect(mockFn).toHaveBeenCalledTimes(2);
    // First call: auto-yes
    expect(mockFn.mock.calls[0][0]).toContain('/auto-yes');
    // Second call: send
    expect(mockFn.mock.calls[1][0]).toContain('/send');
  });

  it('rejects invalid agent with CLI_TOOL_IDS list', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'invalid-agent']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('claude')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('codex')
    );
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects invalid worktree ID', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', '../invalid', 'hello']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects stop-pattern exceeding max length', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    const longPattern = 'x'.repeat(501);
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--auto-yes', '--stop-pattern', longPattern]);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('stop-pattern exceeds maximum length')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('sends with --model flag for copilot', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'test', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--agent', 'copilot', '--model', 'gpt-5-mini']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        body: JSON.stringify({ content: 'test', cliToolId: 'copilot', model: 'gpt-5-mini' }),
      })
    );
  });

  it('rejects --model without --agent copilot', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--model', 'gpt-5-mini']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('--model')
    );
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects --model with non-copilot agent', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'claude', '--model', 'gpt-5-mini']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('--model')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects --model with invalid characters', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'copilot', '--model', 'model; rm -rf /']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('model')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects --model exceeding max length', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    const longModel = 'a'.repeat(129);
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'copilot', '--model', longModel]);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('model')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  // Issue #989: antigravity --model support
  it('sends with --model flag for antigravity', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'test', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--agent', 'antigravity', '--model', 'Gemini 3.1 Pro (High)']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        body: JSON.stringify({ content: 'test', cliToolId: 'antigravity', model: 'Gemini 3.1 Pro (High)' }),
      })
    );
  });

  it('rejects --model with invalid characters for antigravity', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'antigravity', '--model', "model'; rm -rf ~"]);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('model')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('sends auto-yes after message when --model and --auto-yes combined', async () => {
    // With --model, auto-yes should be enabled AFTER the send (not before)
    const mockFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') });
    global.fetch = mockFn;

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--agent', 'copilot', '--model', 'gpt-5-mini', '--auto-yes']);

    expect(mockFn).toHaveBeenCalledTimes(2);
    // First call: send (with model)
    expect(mockFn.mock.calls[0][0]).toContain('/send');
    // Second call: auto-yes
    expect(mockFn.mock.calls[1][0]).toContain('/auto-yes');
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello']);
    expect(mockExit).toHaveBeenCalledWith(1); // DEPENDENCY_ERROR
  });

  // Issue #1000: --register registers an ad-hoc --instance session into the roster
  describe('--register', () => {
    // Issue #1629 prepends a roster read that resolves --instance to its CLI
    // tool, so every --instance send now opens with GET /api/worktrees/:id.
    it('registers a primary-instance id (no --agent required) after sending', async () => {
      const mockFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [] }), text: () => Promise.resolve('{"id":"wt1","agentInstances":[]}') })
        .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [] }), text: () => Promise.resolve('{"id":"wt1","agentInstances":[]}') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') });
      global.fetch = mockFn;

      const { createSendCommand } = await import('../../../../src/cli/commands/send');
      const cmd = createSendCommand();
      await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex', '--register']);

      expect(mockFn).toHaveBeenCalledTimes(4);
      expect(mockFn.mock.calls[0][0]).toContain('/api/worktrees/wt1');
      expect(mockFn.mock.calls[1][0]).toContain('/send');
      expect(mockFn.mock.calls[2][0]).toContain('/api/worktrees/wt1');
      expect(mockFn.mock.calls[3][1]).toEqual(
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }] }),
        })
      );
      expect(mockConsoleError).toHaveBeenCalledWith('Instance registered in roster: codex');
    });

    it('registers a non-primary instance when --agent is provided', async () => {
      const mockFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }] }), text: () => Promise.resolve('{}') })
        .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }] }), text: () => Promise.resolve('{}') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') });
      global.fetch = mockFn;

      const { createSendCommand } = await import('../../../../src/cli/commands/send');
      const cmd = createSendCommand();
      await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'codex', '--instance', 'codex-2', '--register']);

      expect(mockFn).toHaveBeenCalledTimes(4);
      expect(mockFn.mock.calls[3][1]).toEqual(
        expect.objectContaining({
          body: JSON.stringify({
            agentInstances: [
              { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
              { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
            ],
          }),
        })
      );
    });

    it('does not PATCH when the instance is already registered', async () => {
      const mockFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }] }), text: () => Promise.resolve('{}') })
        .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'wt1', agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }] }), text: () => Promise.resolve('{}') });
      global.fetch = mockFn;

      const { createSendCommand } = await import('../../../../src/cli/commands/send');
      const cmd = createSendCommand();
      await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex', '--register']);

      // resolution GET + send + register GET; no PATCH, the instance is known.
      expect(mockFn).toHaveBeenCalledTimes(3);
      // Issue #1629: the roster says `codex` is a codex instance, so the send
      // names codex explicitly instead of leaving it to the worktree default.
      expect(JSON.parse(mockFn.mock.calls[1][1].body)).toEqual({
        content: 'hello',
        cliToolId: 'codex',
        instanceId: 'codex',
      });
    });

    it('rejects --register without --instance', async () => {
      mockFetchResponse({ id: 1 }, 201);
      const { createSendCommand } = await import('../../../../src/cli/commands/send');
      const cmd = createSendCommand();
      await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--register']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--register requires --instance'));
      expect(mockExit).toHaveBeenCalledWith(2);
    });

    it('rejects --register with a non-primary --instance and no --agent', async () => {
      mockFetchResponse({ id: 1 }, 201);
      const { createSendCommand } = await import('../../../../src/cli/commands/send');
      const cmd = createSendCommand();
      await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--instance', 'codex-2', '--register']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--register requires --agent'));
      expect(mockExit).toHaveBeenCalledWith(2);
    });
  });
});

// Issue #1708: sending into an open prompt dialog does not reach the agent —
// the text piles up in the dialog's input line and corrupts the next `respond`.
// The server refuses with 409/PROMPT_WAITING; the CLI has to relay that as an
// instruction, because the caller most likely to hit it is an unattended runner
// that would otherwise just retry the nudge.
describe('send refuses when the session is waiting on a prompt (Issue #1708)', () => {
  const promptWaitingBody = {
    error:
      'wt1 is waiting on a prompt. Sending now would type into the prompt\'s input line ' +
      'instead of reaching the agent. Answer the prompt first: `commandmate respond wt1 <answer>`.',
    code: 'PROMPT_WAITING',
  };

  it('prints the server reason and exits with the config error code', async () => {
    mockFetchResponse(promptWaitingBody, 409);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'nudge']);

    // The FIRST thing printed, and the reason it exits. `process.exit` is a
    // no-op under test so the generic handler runs on afterwards and logs
    // "Unexpected HTTP status: 409" too — in the real CLI that line is never
    // reached, which is the whole point of exiting here.
    expect(String(mockConsoleError.mock.calls[0][0])).toContain('respond wt1');
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Message sent.');
  });

  it('still says what to do when the response carried no message', async () => {
    mockFetchResponse({ code: 'PROMPT_WAITING' }, 409);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'nudge']);

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('respond wt1'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('leaves an unrelated 409 on its generic path', async () => {
    // The code is the contract, not the status: another 409 must not be
    // reported as "answer the prompt".
    mockFetchResponse({ error: 'something else', code: 'SOMETHING_ELSE' }, 409);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello']);

    expect(mockConsoleError).not.toHaveBeenCalledWith(expect.stringContaining('respond wt1'));
  });
});

// Issue #1737: the guard now also refuses on a dialog only the agent's hooks
// reported — one that may leave no trace on screen. The flag is how an operator
// gets past a record that stuck, so it has to reach the server.
describe('send --ignore-structured-prompt (Issue #1737)', () => {
  it('asks the server to waive the structured half of the guard', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'nudge', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'nudge', '--ignore-structured-prompt',
    ]);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        body: JSON.stringify({ content: 'nudge', ignoreStructuredPromptGuard: true }),
      })
    );
  });

  it('sends the ordinary body without it', async () => {
    // Opt-in, and the field is absent rather than false: an older daemon must
    // see exactly the body it always did.
    mockFetchResponse({ id: 1, role: 'user', content: 'nudge', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'nudge']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({ body: JSON.stringify({ content: 'nudge' }) })
    );
  });
});
