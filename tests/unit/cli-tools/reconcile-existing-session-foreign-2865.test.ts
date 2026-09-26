/**
 * Issue #2865: the reuse ("adopt") branch never takes over a same-named tmux
 * session another CommandMate server created.
 *
 * `reconcileExistingSession` is the adopt marker for the seven non-claude tools,
 * so the stub below takes exactly that branch; the ownership check itself is
 * real and only the tmux reads underneath it are mocked. Whether the session
 * was adopted is read through the production consequence of the mark: an
 * adopted pane's launch line is read once (`capturePane`) by the stale-hook-URL
 * probe (#2429).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasSession = vi.fn(async (_name: string) => true);
const getSessionWorkingDirectory = vi.fn(async (_name: string): Promise<string | null> => null);
const capturePane = vi.fn(async () => '$ ');
const reconcileSessionGeometry = vi.fn().mockResolvedValue(false);
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: (name: string) => hasSession(name),
  getSessionWorkingDirectory: (name: string) => getSessionWorkingDirectory(name),
  capturePane: () => capturePane(),
  reconcileSessionGeometry: (...args: unknown[]) => reconcileSessionGeometry(...args),
  sendSpecialKey: vi.fn(),
}));

vi.mock('@/lib/push/failure-push-notifier', () => ({
  notifyStaleHookUrlPush: vi.fn().mockResolvedValue(undefined),
  notifySessionStartFailurePush: vi.fn().mockResolvedValue(undefined),
}));

import { BaseCLITool, resetHookUrlProbesForTest } from '@/lib/cli-tools/base';
import { resetStaleHookUrlReportsForTest } from '@/lib/cli-tools/start-availability';
import {
  FOREIGN_SESSION_ERROR_CODE,
  ForeignSessionError,
  resetForeignSessionWarningsForTesting,
} from '@/lib/tmux/session-ownership';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_PATH = '/nonexistent-2865/repos/wt';

/** The reuse branch of every tool's `launchSession`, and nothing else. */
class ReusingTool extends BaseCLITool {
  readonly id: CLIToolType = 'codex';
  readonly name = 'Codex CLI';
  readonly command = 'codex';

  async isRunning(): Promise<boolean> {
    return true;
  }
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    await this.reconcileExistingSession(this.getSessionName(worktreeId, instanceId), worktreePath);
  }
  async sendMessage(): Promise<void> {}
  async killSession(): Promise<void> {}
}

beforeEach(() => {
  vi.clearAllMocks();
  hasSession.mockResolvedValue(true);
  resetHookUrlProbesForTest();
  resetStaleHookUrlReportsForTest();
  resetForeignSessionWarningsForTesting();
});

describe('[#2865] reconcileExistingSession', () => {
  it('throws ForeignSessionError for a session created in another directory, and adopts nothing', async () => {
    getSessionWorkingDirectory.mockResolvedValue('/nonexistent-2865/other-server/wt');

    const error = await new ReusingTool()
      .startSession('wt-foreign', WORKTREE_PATH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForeignSessionError);
    expect(error).toMatchObject({
      code: FOREIGN_SESSION_ERROR_CODE,
      sessionName: 'mcbd-codex-wt-foreign',
      sessionPath: '/nonexistent-2865/other-server/wt',
      worktreePath: WORKTREE_PATH,
    });
    // Nothing touched the other server's pane: no geometry snap, and no adopt
    // mark (the #2429 probe that reads an adopted pane never ran).
    expect(reconcileSessionGeometry).not.toHaveBeenCalled();
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('throws when the session_path cannot be read (fail safe)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(null);

    await expect(new ReusingTool().startSession('wt-unreadable', WORKTREE_PATH)).rejects.toBeInstanceOf(
      ForeignSessionError
    );
    expect(reconcileSessionGeometry).not.toHaveBeenCalled();
  });

  it('adopts its own session exactly as before (control)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(WORKTREE_PATH);

    await new ReusingTool().startSession('wt-owned', WORKTREE_PATH);

    expect(reconcileSessionGeometry).toHaveBeenCalledWith('mcbd-codex-wt-owned', undefined);
    // The adopt mark was set, so the adopted-pane probe read the launch line.
    expect(capturePane).toHaveBeenCalledTimes(1);
  });
});
