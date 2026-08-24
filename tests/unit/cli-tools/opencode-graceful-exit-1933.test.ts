/**
 * `OpenCodeTool.killSession` checks the whole postcondition, not half of it
 * (Issue #1933, 受入条件 S10).
 *
 * Before this Issue the method asked one question after its exit window — "does
 * the tmux session still exist?" — and force-killed on a yes. That misses the
 * failure that has no other detector anywhere in the system:
 *
 * opencode's TUI **is** an HTTP server once it is given `--port` (#1758
 * §5.1.2), and `lib/hooks/sources/opencode/ports` hands the number to the next
 * instance that asks for one. A server that outlives its pane therefore
 * collects the NEXT instance's subscription, and that instance's events are
 * filed against the wrong worktree — no exception, no warning, a perfectly
 * well-formed response.
 *
 * The port is read BEFORE the stream release, because the release is what
 * forgets it. That ordering is asserted here rather than left to a comment.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.endsWith('_MS') && typeof value === 'number' ? 0 : value,
    ])
  );
});

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  exactTarget: (name: string) => `=${name}:`,
  killSession: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/hooks/sources/opencode/ports', () => ({
  getAssignedOpencodePort: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/hooks/sources/opencode/client', () => ({
  fetchOpencodeHealth: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn().mockResolvedValue(undefined),
}));

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { hasSession, killSession as tmuxKillSession } from '@/lib/tmux/tmux';
import { releaseOpencodeEventStream } from '@/lib/hooks/sources/opencode/runtime';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { fetchOpencodeHealth } from '@/lib/hooks/sources/opencode/client';

const WORKTREE = 'wt-1933';
const SESSION = 'mcbd-opencode-wt-1933';

/** The pane is alive when the method starts, and gone by the time it checks. */
function paneExitsCleanly(): void {
  let call = 0;
  vi.mocked(hasSession).mockImplementation(async () => {
    call += 1;
    return call === 1;
  });
}

describe('OpenCodeTool.killSession postcondition (Issue #1933 S10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(getAssignedOpencodePort).mockReturnValue(null);
    vi.mocked(fetchOpencodeHealth).mockResolvedValue(null);
  });

  it('reads the assigned port before the release that forgets it', async () => {
    await new OpenCodeTool().killSession(WORKTREE);

    expect(getAssignedOpencodePort).toHaveBeenCalledWith({
      worktreeId: WORKTREE,
      cliToolId: 'opencode',
      instanceId: undefined,
    });
    expect(vi.mocked(getAssignedOpencodePort).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(releaseOpencodeEventStream).mock.invocationCallOrder[0]
    );
  });

  it('does not force-kill when the pane went and no port was ever allocated', async () => {
    paneExitsCleanly();

    await new OpenCodeTool().killSession(WORKTREE);

    expect(tmuxKillSession).not.toHaveBeenCalled();
    // Nothing to orphan, so nothing to probe.
    expect(fetchOpencodeHealth).not.toHaveBeenCalled();
  });

  it('does not force-kill when the pane went and its port fell silent', async () => {
    paneExitsCleanly();
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4231);

    await new OpenCodeTool().killSession(WORKTREE);

    expect(fetchOpencodeHealth).toHaveBeenCalledWith(4231);
    expect(tmuxKillSession).not.toHaveBeenCalled();
  });

  it('force-kills when the pane is gone but the port is still answering', async () => {
    paneExitsCleanly();
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4231);
    vi.mocked(fetchOpencodeHealth).mockResolvedValue({ healthy: true, version: '1.18.21' });

    await new OpenCodeTool().killSession(WORKTREE);

    expect(fetchOpencodeHealth).toHaveBeenCalledWith(4231);
    expect(tmuxKillSession).toHaveBeenCalledWith(SESSION);
  });

  it('force-kills a pane that outlived the exit command, without asking about the port', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4231);

    await new OpenCodeTool().killSession(WORKTREE);

    // A server answering while its pane is alive is a running agent, not an
    // orphan — so `graceful_exit_timeout` wins and the probe is never made.
    expect(fetchOpencodeHealth).not.toHaveBeenCalled();
    expect(tmuxKillSession).toHaveBeenCalledWith(SESSION);
  });

  it('still cleans up a stale tmux session that was never running', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    await new OpenCodeTool().killSession(WORKTREE);

    expect(tmuxKillSession).toHaveBeenCalledWith(SESSION);
  });
});
