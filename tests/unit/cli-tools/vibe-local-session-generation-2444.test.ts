/**
 * vibe-local's creation path opens a session generation (Issue #2444).
 *
 * `beginAgentSession` is the one line every tool's `launchSession` owes the
 * rest of the system, and vibe-local was the single tool that never called it.
 * That was invisible while the call meant only "fence the previous process's
 * structured events" — vibe-local emits none — and stops being invisible the
 * moment the same call is also what retires a dead session's chat rows. Without
 * it, a vibe-local pane whose agent was killed outside CommandMate keeps
 * presenting the old conversation as the current one forever, because
 * `kill-session` (the only other writer of `archived`) 404s once there is no
 * live session left to kill.
 *
 * The two directions are asserted separately, and the ALIVE one is the load
 * bearing half: a healthy pane is the same process, and archiving its history
 * would delete a conversation the user is in the middle of.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/tmp/wt'),
}));

vi.mock('@/lib/session/agent-session-lifecycle', () => ({
  beginAgentSession: vi.fn(),
  buildAgentLaunchCommandLine: vi.fn().mockReturnValue('vibe-local -y'),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeSessionLiveness: vi.fn(),
  resolveLivenessSpec: vi.fn(() => ({ id: 'vibe-local' })),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

// vibe-local reads its Ollama model / context window straight from the DB.
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => undefined) }));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so it is true.
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { hasSession, createSession, sendKeys } from '@/lib/tmux/tmux';
import { probeSessionLiveness } from '@/lib/cli-tools/session-liveness';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';

const WORKTREE_ID = 'wt-2444';

/**
 * `launchSession` sleeps for the tmux create wait and VIBE_LOCAL_INIT_WAIT_MS
 * (5 s), and `isToolLive({confirm:true})` sleeps once more between its two
 * readings. Faked so the suite does not spend those seconds.
 */
async function startWithFakeTimers(tool: VibeLocalTool): Promise<void> {
  vi.useFakeTimers();
  try {
    const started = tool.startSession(WORKTREE_ID, '/tmp/wt');
    await vi.advanceTimersByTimeAsync(30_000);
    await started;
  } finally {
    vi.useRealTimers();
  }
}

describe('[#2444] VibeLocalTool.launchSession opens a session generation', () => {
  let tool: VibeLocalTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new VibeLocalTool();
  });

  it('calls beginAgentSession when it creates a pane', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    await startWithFakeTimers(tool);

    expect(createSession).toHaveBeenCalled();
    expect(beginAgentSession).toHaveBeenCalledTimes(1);
    expect(beginAgentSession).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      cliToolId: 'vibe-local',
      instanceId: undefined,
    });
  });

  it('carries the instance id, so a second instance retires only its own history', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    vi.useFakeTimers();
    try {
      const started = tool.startSession(WORKTREE_ID, '/tmp/wt', 'vibe-local-2');
      await vi.advanceTimersByTimeAsync(30_000);
      await started;
    } finally {
      vi.useRealTimers();
    }

    expect(beginAgentSession).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      cliToolId: 'vibe-local',
      instanceId: 'vibe-local-2',
    });
  });

  it('calls it again on the relaunch-into-the-same-pane path', async () => {
    // The pane outlived its agent (#2070): same tmux session, new process.
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(probeSessionLiveness).mockResolvedValue({ alive: false, reason: 'shell-prompt' });

    await startWithFakeTimers(tool);

    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).toHaveBeenCalled();
    expect(beginAgentSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT call it when the running agent is reused', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(probeSessionLiveness).mockResolvedValue({ alive: true });

    await startWithFakeTimers(tool);

    expect(sendKeys).not.toHaveBeenCalled();
    // Same process, same conversation. Archiving here deletes history the user
    // is still looking at, and fencing here discards a live process's events.
    expect(beginAgentSession).not.toHaveBeenCalled();
  });
});
