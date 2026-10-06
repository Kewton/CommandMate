/**
 * Issue #3312: under `CM_UAT_ISOLATION=own-home` claude's launch plan can be
 * refused (wrong user / HOME / write target). The plan is built BEFORE the tmux
 * session, as codex's is, so a refused launch leaves no empty pane behind.
 *
 * Positive control: before this fix `createSession` ran first. Negative control:
 * outside own-home the session is still created (here it throws a sentinel
 * right there, so nothing past it runs).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

registerIsolatedAgentHooksDir('claude-session-own-home-3312');

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
import { createSession, hasSession, sendKeys } from '@/lib/tmux/tmux';

const OPTIONS = { worktreeId: 'wt-3312', worktreePath: '/nonexistent-3312/repos/wt-3312' };
const MANAGED = ['CM_UAT_ISOLATION', 'CM_UAT_DEDICATED_USER'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(createSession).mockRejectedValue(new Error('sentinel: createSession reached'));
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('[#3312] startClaudeSession builds the launch plan before the tmux session', () => {
  it('own-home with the wrong user: refused, and no session is created', async () => {
    process.env.CM_UAT_ISOLATION = 'own-home';
    process.env.CM_UAT_DEDICATED_USER = 'someone-else-3312';

    await expect(startClaudeSession(OPTIONS)).rejects.toThrow();
    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('negative control: not isolated, the session is created as before', async () => {
    await expect(startClaudeSession(OPTIONS)).rejects.toThrow();
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
