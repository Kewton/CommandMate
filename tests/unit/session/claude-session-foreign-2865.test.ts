/**
 * Issue #2865: `startClaudeSession`'s reuse branch never takes over a
 * same-named tmux session another CommandMate server created — it refuses
 * before the health check, which could otherwise KILL that server's session.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

registerIsolatedAgentHooksDir('claude-session-foreign-2865');

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  getSessionWorkingDirectory: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

import { startClaudeSession } from '@/lib/session/claude-session';
import {
  hasSession,
  getSessionWorkingDirectory,
  createSession,
  capturePane,
  killSession,
  reconcileSessionGeometry,
} from '@/lib/tmux/tmux';
import { ForeignSessionError, resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';

const OPTIONS = { worktreeId: 'wt-2865', worktreePath: '/nonexistent-2865/repos/wt-2865' };

beforeEach(() => {
  vi.clearAllMocks();
  resetForeignSessionWarningsForTesting();
  vi.mocked(hasSession).mockResolvedValue(true);
  vi.mocked(capturePane).mockResolvedValue('❯ ');
});

describe('[#2865] startClaudeSession reuse branch', () => {
  it('throws ForeignSessionError for a session created in another directory', async () => {
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue('/nonexistent-2865/other-server/wt-2865');

    await expect(startClaudeSession(OPTIONS)).rejects.toBeInstanceOf(ForeignSessionError);

    // Refused before the health check: nothing read, killed, resized or created.
    expect(capturePane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(reconcileSessionGeometry).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reuses its own session as before (control)', async () => {
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue(OPTIONS.worktreePath);

    await startClaudeSession(OPTIONS);

    expect(reconcileSessionGeometry).toHaveBeenCalledWith('mcbd-claude-wt-2865');
    expect(createSession).not.toHaveBeenCalled();
  });
});
