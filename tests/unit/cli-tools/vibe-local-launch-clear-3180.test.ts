/**
 * vibe-local types its launch line behind `clear 2>/dev/null; printf '\033[3J'; ` like every other tool
 * (Issue #3180). It is the one launcher that does not go through
 * `buildAgentLaunchCommandLine`, so it is asserted on its own.
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
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeSessionLiveness: vi.fn(),
  resolveLivenessSpec: vi.fn(() => ({ id: 'vibe-local' })),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => undefined) }));

vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { hasSession, sendKeys } from '@/lib/tmux/tmux';
import { probeSessionLiveness } from '@/lib/cli-tools/session-liveness';

async function startWithFakeTimers(tool: VibeLocalTool): Promise<void> {
  vi.useFakeTimers();
  try {
    const started = tool.startSession('wt-3180', '/tmp/wt');
    await vi.advanceTimersByTimeAsync(30_000);
    await started;
  } finally {
    vi.useRealTimers();
  }
}

describe('[#3180] VibeLocalTool types its launch line behind `clear 2>/dev/null; `', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on a new pane', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    await startWithFakeTimers(new VibeLocalTool());

    expect(sendKeys).toHaveBeenCalledWith('mcbd-vibe-local-wt-3180', "clear 2>/dev/null; printf '\\033[3J'; vibe-local -y", true);
  });

  it('on the relaunch into a pane the agent has left (#2070)', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(probeSessionLiveness).mockResolvedValue({ alive: false, reason: 'shell-prompt' });

    await startWithFakeTimers(new VibeLocalTool());

    expect(sendKeys).toHaveBeenCalledWith('mcbd-vibe-local-wt-3180', "clear 2>/dev/null; printf '\\033[3J'; vibe-local -y", true);
  });
});
