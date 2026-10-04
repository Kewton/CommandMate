/**
 * Issue #3179 — `BaseCLITool.startSession` ends the "starting" record whether
 * the launch returns or throws, including when it is reached through
 * `relaunchIfToolExited`; and `beginAgentSession` is what opens it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn().mockResolvedValue(''),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/tmp/wt-3179'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
}));

// The failure path reports through a fire-and-forget import; keep it inert.
vi.mock('@/lib/cli-tools/start-availability', () => ({
  reportSessionStartFailure: vi.fn(),
  reportStaleHookUrl: vi.fn(),
}));

import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  getSessionStartingSince,
  markSessionStarting,
  resetSessionStartingState,
} from '@/lib/session/session-starting-state';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';

const WT = 'wt-3179';

class StartingProbeTool extends BaseCLITool {
  readonly id: CLIToolType = 'antigravity';
  readonly name = 'Probe';
  readonly command = 'probe';
  /** What `getSessionStartingSince` answered from inside the launch. */
  seenDuringLaunch: number | null = null;
  failWith: Error | null = null;

  async isRunning(): Promise<boolean> {
    return true;
  }

  protected async launchSession(worktreeId: string, _path: string, instanceId?: string): Promise<void> {
    // Stands in for the `beginAgentSession` every creation path calls.
    markSessionStarting(worktreeId, this.id, instanceId);
    this.seenDuringLaunch = getSessionStartingSince(worktreeId, this.id, instanceId);
    if (this.failWith) throw this.failWith;
  }

  async sendMessage(): Promise<void> {}

  async killSession(): Promise<void> {}

  protected async isToolLive(): Promise<boolean> {
    return false;
  }

  relaunch(worktreeId: string, instanceId?: string): Promise<void> {
    return this.relaunchIfToolExited(worktreeId, instanceId);
  }
}

describe('[#3179] startSession clears the starting record', () => {
  beforeEach(() => resetSessionStartingState());

  it('is set during the launch and cleared when it returns', async () => {
    const tool = new StartingProbeTool();
    await tool.startSession(WT, '/tmp/wt-3179');
    expect(tool.seenDuringLaunch).not.toBeNull();
    expect(getSessionStartingSince(WT, 'antigravity')).toBeNull();
  });

  it('is cleared when the launch throws, and the error is rethrown unchanged', async () => {
    const tool = new StartingProbeTool();
    const boom = new Error('launch failed');
    tool.failWith = boom;
    await expect(tool.startSession(WT, '/tmp/wt-3179', 'antigravity-2')).rejects.toBe(boom);
    expect(tool.seenDuringLaunch).not.toBeNull();
    expect(getSessionStartingSince(WT, 'antigravity', 'antigravity-2')).toBeNull();
  });

  it('is cleared on the relaunchIfToolExited path too', async () => {
    const tool = new StartingProbeTool();
    await tool.relaunch(WT);
    expect(tool.seenDuringLaunch).not.toBeNull();
    expect(getSessionStartingSince(WT, 'antigravity')).toBeNull();
  });

  it('beginAgentSession opens the record for the instance it fences', () => {
    beginAgentSession({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex-2' }, 5_000);
    expect(getSessionStartingSince(WT, 'codex', 'codex-2', 6_000)).toBe(5_000);
  });
});
