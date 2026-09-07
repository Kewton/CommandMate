/**
 * `commandmate whoami` / `commandmate peers` — self-awareness (Issue #2376).
 *
 * An agent inside a CommandMate session had no way to name itself or its
 * siblings, so every delegation started with a human pasting two ids in. These
 * two commands are that step, and what is pinned here is the two properties the
 * rest of the feature rests on:
 *
 *   - OUTSIDE a session the answer is exit 3, never a guess. A wrong worktree
 *     id here would send somebody else's agent a message;
 *   - a `peers` row is a WORKING `ask` line. The acceptance criterion for the
 *     command is that a line pasted out of it runs, so the line is asserted
 *     character for character rather than by its parts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawnSync }));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  spawnSync.mockReset();
  for (const key of [
    'TMUX',
    'CM_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_CLI_TOOL',
    'CM_AGENT_WORKTREE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_AGENT_TOOL',
    'CM_LAUNCHED_BY',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  process.env = { ...SAVED_ENV };
});

/** Make `tmux display-message` answer with `name`. */
function inTmux(name: string): void {
  process.env.TMUX = '/tmp/tmux-501/default,123,0';
  spawnSync.mockReturnValue({ status: 0, stdout: `${name}\n` });
}

function stdout(): string {
  return mockConsoleLog.mock.calls.flat().join('\n');
}

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anvil-develop',
    name: 'develop',
    branch: 'develop',
    cliToolId: 'claude',
    repositoryPath: '/repos/anvil',
    repositoryName: 'anvil',
    isSessionRunning: true,
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ],
    ...overrides,
  };
}

describe('whoami: outside a CommandMate session', () => {
  it('exits 3 rather than guessing', async () => {
    mockFetchSequence([]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami']);

    expect(mockExit).toHaveBeenCalledWith(3);
    expect(stdout()).toBe('');
    expect(mockConsoleError.mock.calls.flat().join('\n'))
      .toContain('not inside a CommandMate agent session');
  });

  it('does not spawn tmux at all when $TMUX is unset', async () => {
    mockFetchSequence([]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami']);

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('exits 3 inside a tmux session CommandMate did not name', async () => {
    inTmux('my-own-session');
    mockFetchSequence([]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami']);

    expect(mockExit).toHaveBeenCalledWith(3);
  });
});

describe('whoami: inside a session', () => {
  it('reads the correlation variables CommandMate puts on the launch line', async () => {
    process.env.CM_AGENT_WORKTREE_ID = 'anvil-develop';
    process.env.CM_AGENT_INSTANCE_ID = 'codex-2';
    process.env.CM_AGENT_TOOL = 'codex';
    mockFetchSequence([{ data: { agentInstances: worktree().agentInstances } }]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload).toMatchObject({
      worktreeId: 'anvil-develop',
      instanceId: 'codex-2',
      cliToolId: 'codex',
      alias: 'Codex 2',
      source: 'env',
    });
  });

  it('falls back to the tmux session name, which is all claude leaves behind', async () => {
    inTmux('mcbd-claude-anvil-develop');
    mockFetchSequence([
      { data: { worktrees: [worktree()], repositories: [] } },
      { data: { agentInstances: worktree().agentInstances } },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload).toMatchObject({
      worktreeId: 'anvil-develop',
      instanceId: 'claude',
      cliToolId: 'claude',
      source: 'tmux-session',
      sessionName: 'mcbd-claude-anvil-develop',
    });
  });

  it('reads a second instance out of the session name when the worktree list says so', async () => {
    inTmux('mcbd-claude-anvil-develop-2');
    mockFetchSequence([
      { data: { worktrees: [worktree()], repositories: [] } },
      { data: { agentInstances: worktree().agentInstances } },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    // `anvil-develop-2` is not a worktree; `anvil-develop` is. So the trailing
    // `-2` is the instance suffix, not part of the id.
    expect(JSON.parse(stdout())).toMatchObject({
      worktreeId: 'anvil-develop',
      instanceId: 'claude-2',
    });
  });

  it('keeps the whole remainder when THAT is the worktree', async () => {
    inTmux('mcbd-claude-anvil-develop-2');
    mockFetchSequence([
      { data: { worktrees: [worktree({ id: 'anvil-develop-2' })], repositories: [] } },
      { data: { agentInstances: [] } },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    expect(JSON.parse(stdout())).toMatchObject({
      worktreeId: 'anvil-develop-2',
      instanceId: 'claude',
    });
  });
});

describe('parseSessionName', () => {
  it('splits a hyphenated tool id without eating the worktree', async () => {
    const { parseSessionName } = await import('../../../../src/cli/commands/whoami');

    // The failure a shortest-first scan produces: tool `command`, which is not
    // a tool at all.
    expect(parseSessionName('mcbd-command-code-anvil-develop')).toEqual({
      cliToolId: 'command-code',
      remainder: 'anvil-develop',
    });
    expect(parseSessionName('mcbd-vibe-local-wt')).toEqual({
      cliToolId: 'vibe-local',
      remainder: 'wt',
    });
    expect(parseSessionName('not-a-commandmate-session')).toBeNull();
    expect(parseSessionName('mcbd-claude-')).toBeNull();
  });
});

describe('peers', () => {
  it('exits 3 outside a session', async () => {
    mockFetchSequence([]);

    const { createPeersCommand } = await import('../../../../src/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers']);

    expect(mockExit).toHaveBeenCalledWith(3);
  });

  it('prints a runnable ask line for every session but the caller\'s own', async () => {
    process.env.CM_WORKTREE_ID = 'anvil-develop';
    process.env.CM_INSTANCE_ID = 'claude';
    process.env.CM_CLI_TOOL = 'claude';
    process.env.CM_LAUNCHED_BY = 'commandmate-cli';
    mockFetchSequence([{ data: { worktrees: [worktree()], repositories: [] } }]);

    const { createPeersCommand } = await import('../../../../src/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers']);

    const out = stdout();
    expect(out).toContain('anvil-develop / claude  (you)');
    expect(out).toContain(
      'commandmate ask anvil-develop --instance codex-2 "<request>"'
    );
    // The caller's own row carries no ask line: there is nothing to delegate.
    expect(out.split('\n').filter((l) => l.includes('ask anvil-develop'))).toHaveLength(1);
  });

  it('leaves out worktrees of other repositories', async () => {
    process.env.CM_WORKTREE_ID = 'anvil-develop';
    process.env.CM_INSTANCE_ID = 'claude';
    process.env.CM_CLI_TOOL = 'claude';
    const other = worktree({
      id: 'other-main',
      repositoryPath: '/repos/other',
      repositoryName: 'other',
    });
    mockFetchSequence([{ data: { worktrees: [worktree(), other], repositories: [] } }]);

    const { createPeersCommand } = await import('../../../../src/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload.peers.map((p: { worktreeId: string }) => p.worktreeId))
      .not.toContain('other-main');
    expect(payload.self).toEqual({
      worktreeId: 'anvil-develop',
      instanceId: 'claude',
      cliToolId: 'claude',
    });
  });

  it('reports the primary instance of a worktree with no roster', async () => {
    const { buildPeerRows } = await import('../../../../src/cli/commands/peers');

    const rows = buildPeerRows(
      [worktree({ agentInstances: [] })],
      {
        worktreeId: 'anvil-develop',
        instanceId: 'claude',
        cliToolId: 'claude',
        source: 'env',
        sessionName: null,
      },
      'commandmate',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: 'claude', isSelf: true, ask: null });
  });
});
