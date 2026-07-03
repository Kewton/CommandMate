/**
 * instances Command Tests
 * Issue #1000
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchSequence, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

describe('createInstancesCommand', () => {
  it('creates a Command named "instances"', async () => {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    expect(cmd.name()).toBe('instances');
  });
});

describe('instances command: list (default action)', () => {
  it('lists the roster with running/auto-yes status as a table', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
        { id: 'codex-2', cliTool: 'codex', alias: 'Review', order: 1 },
      ] } },
      { data: { isRunning: true, autoYes: { enabled: false } } },
      { data: { isRunning: false, autoYes: { enabled: true } } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1']);

    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toContain('INSTANCE_ID');
    expect(output).toContain('claude');
    expect(output).toContain('codex-2');
  });

  it('outputs JSON with --json', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      ] } },
      { data: { isRunning: true, autoYes: { enabled: true } } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output).toEqual([
      { instanceId: 'claude', alias: 'Claude', cliTool: 'claude', running: true, autoYes: true },
    ]);
  });

  it('shows "No agent instances found." for an empty roster', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1']);
    expect(mockConsoleLog.mock.calls[0][0]).toBe('No agent instances found.');
  });

  it('rejects invalid worktree ID', async () => {
    // process.exit is mocked (no-op), so execution falls through past the
    // guard into listInstances(); mock fetch defensively to avoid a real call.
    mockFetchResponse({ id: '../invalid', name: 'x', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', '../invalid']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('instances command: add', () => {
  it('adds an instance with an auto-generated id', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      ] } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add', '--agent', 'codex']);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          agentInstances: [
            { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
            { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
          ],
        }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Instance added: codex-2 (codex)');
  });

  it('adds an instance with an explicit --id and --alias', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [] } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add', '--agent', 'codex', '--id', 'codex-3', '--alias', 'Review']);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({
        body: JSON.stringify({ agentInstances: [{ id: 'codex-3', cliTool: 'codex', alias: 'Review', order: 0 }] }),
      })
    );
  });

  it('rejects add without --agent', async () => {
    // process.exit is mocked (no-op); mock fetch defensively since execution
    // falls through into the rest of addInstance() after the guard.
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--agent'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects add with an invalid --agent', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add', '--agent', 'not-a-tool']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects add when the roster is already at the instance limit', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({
      id: i === 0 ? 'claude' : `claude-${i + 1}`,
      cliTool: 'claude',
      alias: 'Claude',
      order: i,
    }));
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: full });

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add', '--agent', 'codex']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('maximum'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects an explicit --id that conflicts with a different --agent', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'add', '--agent', 'codex', '--id', 'claude']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('conflicts'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('instances command: remove', () => {
  it('removes an instance from the roster', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
      ] } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'remove', 'claude-2']);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }] }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Instance removed from roster: claude-2');
  });

  it('kills the session before removing when --kill is set', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
      ] } },
      { data: { success: true } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'remove', 'claude-2', '--kill']);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/kill-session?instance=claude-2'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects removing the last remaining instance', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    ] });

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'remove', 'claude']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('last remaining'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects removing an instance id not in the roster', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
    ] });

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'remove', 'does-not-exist']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('rejects remove without an instance-id argument', async () => {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'remove']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('instances command: alias', () => {
  it('renames an instance', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 0 },
      ] } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'alias', 'claude-2', 'Review', 'Bot']);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({
        body: JSON.stringify({ agentInstances: [{ id: 'claude-2', cliTool: 'claude', alias: 'Review Bot', order: 0 }] }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Instance alias updated: claude-2 -> "Review Bot"');
  });

  it('rejects alias without a new-alias argument', async () => {
    // process.exit is mocked (no-op); with a valid instanceId, execution falls
    // through into renameInstance()'s own length check and then fetchAgentInstances.
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'alias', 'claude-2']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects an unknown instance id', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main', agentInstances: [] });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'alias', 'does-not-exist', 'New Name']);
    expect(mockExit).toHaveBeenCalledWith(99);
  });
});

describe('instances command: kill', () => {
  it('kills only the targeted instance session', async () => {
    mockFetchResponse({ success: true });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'kill', 'claude-2']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/kill-session?instance=claude-2'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Session killed: claude-2');
  });

  it('rejects kill without an instance-id argument', async () => {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'kill']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('instances command: unknown action', () => {
  it('rejects an unrecognized action', async () => {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1', 'bogus']);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('unknown action'));
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('instances command: server error handling', () => {
  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    const cmd = createInstancesCommand();
    await cmd.parseAsync(['node', 'instances', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
