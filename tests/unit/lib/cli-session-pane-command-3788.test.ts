/**
 * Issue #3788: readSessionPaneCommand() is the #1922 gateway to tmux's
 * `#{pane_current_command}` — it reads the pane of the session the tool names
 * for (worktree, instance), and passes tmux's answer through unchanged
 * (null when tmux cannot say). tmux itself is mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        id,
        getSessionName: (worktreeId: string, instanceId?: string) => `mcbd-${id}-${worktreeId}${instanceId ? `-${instanceId}` : ''}`,
      }),
    }),
  },
}));

vi.mock('@/lib/tmux/polling-tmux-transport', () => ({ getPollingTmuxTransport: vi.fn() }));

vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  getPaneCurrentCommand: vi.fn(),
}));

import { readSessionPaneCommand } from '@/lib/session/cli-session';
import { getPaneCurrentCommand } from '@/lib/tmux/tmux';

describe('[#3788] readSessionPaneCommand', () => {
  beforeEach(() => {
    vi.mocked(getPaneCurrentCommand).mockReset();
  });

  it('reads the pane of the session named for the worktree and instance', async () => {
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('zsh');
    await expect(readSessionPaneCommand('wt-3788', 'antigravity', 'antigravity-2')).resolves.toBe('zsh');
    expect(getPaneCurrentCommand).toHaveBeenCalledWith('mcbd-antigravity-wt-3788-antigravity-2');
  });

  it('passes the agent name through (negative control: not turned into a shell)', async () => {
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('agy');
    await expect(readSessionPaneCommand('wt-3788', 'antigravity')).resolves.toBe('agy');
    expect(getPaneCurrentCommand).toHaveBeenCalledWith('mcbd-antigravity-wt-3788');
  });

  it('is null when tmux cannot say', async () => {
    vi.mocked(getPaneCurrentCommand).mockResolvedValue(null);
    await expect(readSessionPaneCommand('wt-3788', 'antigravity')).resolves.toBeNull();
  });
});
