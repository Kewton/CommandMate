/**
 * `commandmate peers`: each row's status is its own instance's (Issue #4346, item 5).
 *
 * Before: every row of a worktree printed the worktree's aggregate word, so once
 * any session in it was up (`isSessionRunning`), a codex / antigravity that was
 * not running at all still read `ready` — and an `ask` line pasted against it
 * would type into a session that was never started. The list API already sends
 * the un-aggregated `sessionStatusByInstance` (the map `ls`'s AUTO_YES column
 * reads), so the word comes from there: the instance's own entry, then the tool's
 * (`sessionStatusByCli`, a server whose map lacks the alias), then — only for a
 * row with neither map (a server older than #875, or `?includeStatus=0`) — the
 * aggregate as before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { buildPeerRows } from '@/cli/commands/peers';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

const SAVED_ENV = { ...process.env };

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  process.env = { ...SAVED_ENV };
});

const off = { isRunning: false, isWaitingForResponse: false, isProcessing: false };
const ready = { isRunning: true, isWaitingForResponse: false, isProcessing: false };
const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
const waiting = { isRunning: true, isWaitingForResponse: true, isProcessing: false };

const SELF = {
  worktreeId: 'anvil-develop',
  instanceId: 'claude',
  cliToolId: 'claude',
  source: 'env' as const,
  sessionName: null,
};

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anvil-develop',
    name: 'develop',
    cliToolId: 'claude',
    repositoryPath: '/repos/anvil',
    repositoryName: 'anvil',
    // The aggregate: claude is up, so the worktree reads `ready`.
    isSessionRunning: true,
    isWaitingForResponse: false,
    isProcessing: false,
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
      { id: 'antigravity', cliTool: 'antigravity', alias: 'Antigravity', order: 2 },
    ],
    ...overrides,
  };
}

function statusByInstance(rows: ReturnType<typeof buildPeerRows>): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.instanceId, row.status]));
}

describe('[#4346] peers: the status is the instance’s own', () => {
  it('a codex / antigravity that is not running reads idle, though the worktree is ready (red before: ready)', () => {
    const rows = buildPeerRows(
      [worktree({ sessionStatusByInstance: { claude: ready, codex: off, antigravity: off } })],
      SELF,
      'commandmate',
    );
    expect(statusByInstance(rows)).toEqual({ claude: 'ready', codex: 'idle', antigravity: 'idle' });
  });

  it('each instance keeps its own word: waiting, running, ready', () => {
    const rows = buildPeerRows(
      [
        worktree({
          isWaitingForResponse: true,
          isProcessing: true,
          sessionStatusByInstance: { claude: ready, codex: running, antigravity: waiting },
        }),
      ],
      SELF,
      'commandmate',
    );
    expect(statusByInstance(rows)).toEqual({ claude: 'ready', codex: 'running', antigravity: 'waiting' });
  });

  it('an instance missing from the per-instance map reads its tool’s entry', () => {
    const rows = buildPeerRows(
      [
        worktree({
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
          ],
          sessionStatusByInstance: { claude: ready },
          sessionStatusByCli: { claude: ready, codex: off },
        }),
      ],
      SELF,
      'commandmate',
    );
    expect(statusByInstance(rows)).toEqual({ claude: 'ready', 'codex-2': 'idle' });
  });

  it('(negative control) a row with neither map reads the worktree’s aggregate, as before', () => {
    const rows = buildPeerRows([worktree()], SELF, 'commandmate');
    expect(statusByInstance(rows)).toEqual({ claude: 'ready', codex: 'ready', antigravity: 'ready' });
  });

  it('the primary of a worktree with no roster reads its own entry too', () => {
    const rows = buildPeerRows(
      [worktree({ agentInstances: [], sessionStatusByInstance: { claude: running } })],
      SELF,
      'commandmate',
    );
    expect(statusByInstance(rows)).toEqual({ claude: 'running' });
  });

  it('peers --json carries the per-instance word', async () => {
    process.env.CM_WORKTREE_ID = 'anvil-develop';
    process.env.CM_INSTANCE_ID = 'claude';
    process.env.CM_CLI_TOOL = 'claude';
    mockFetchSequence([
      {
        data: {
          worktrees: [worktree({ sessionStatusByInstance: { claude: ready, codex: off, antigravity: off } })],
          repositories: [],
        },
      },
    ]);

    const { createPeersCommand } = await import('@/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers', '--json']);

    const payload = JSON.parse(mockConsoleLog.mock.calls.flat().join('\n'));
    const words = Object.fromEntries(
      payload.peers.map((p: { instanceId: string; status: string }) => [p.instanceId, p.status]),
    );
    expect(words).toEqual({ claude: 'ready', codex: 'idle', antigravity: 'idle' });
  });
});
