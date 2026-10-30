/**
 * The server's session cleanup records what it stopped in the session-kill
 * ledger (Issue #3993), so env-clean sets a sibling session that sync or a
 * repository removal stopped apart as `external`. A session the cleanup did
 * not stop is not recorded (negative).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/schedule-manager', () => ({ stopScheduleForWorktree: vi.fn() }));
vi.mock('@/lib/timer-manager', () => ({ stopTimersForWorktree: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ clearAllCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: vi.fn() },
}));
vi.mock('@/lib/tmux/tmux', () => ({
  killSession: vi.fn(),
  hasSession: vi.fn(),
}));
vi.mock('@/lib/git/worktrees', () => ({ syncWorktreesToDB: vi.fn() }));
vi.mock('@/lib/db/worktree-db', () => ({ getAllWorktreePathIds: vi.fn(() => []) }));
vi.mock('@/lib/cli-tools/session-ownership', () => ({ checkSessionOwnership: vi.fn() }));

import { cleanupGlobalSessions, cleanupWorktreeSessions } from '@/lib/session-cleanup';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { hasSession, killSession } from '@/lib/tmux/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { readSessionKillRecords, SESSION_KILL_LEDGER_ROOT_ENV } from '@/lib/verification/session-kill-ledger';

describe('session cleanup — session-kill ledger (Issue #3993)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cm-session-cleanup-ledger-3993-'));
    vi.stubEnv(SESSION_KILL_LEDGER_ROOT_ENV, root);
    vi.mocked(CLIToolManager.getInstance).mockReturnValue({
      getTool: (id: CLIToolType) => ({ getSessionName: (wt: string) => `mcbd-${id}-${wt}` }),
    } as unknown as CLIToolManager);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const recorded = () => readSessionKillRecords(0, Date.now() + 1000, root);

  it('records each session it stopped as `session-cleanup` from `server` (positive)', async () => {
    const killSessionFn = vi.fn(async (_wt: string, tool: CLIToolType) => tool === 'claude' || tool === 'codex');
    const before = Date.now();

    await cleanupWorktreeSessions('wt-gone', killSessionFn);

    const records = recorded();
    expect(records.map((r) => r.instanceId).sort()).toEqual(['claude', 'codex']);
    for (const record of records) {
      expect(record).toMatchObject({
        version: 1,
        api: 'session-cleanup',
        origin: 'server',
        worktreeId: 'wt-gone',
        callerCwd: null,
        callerSession: null,
      });
      expect(record.at).toBeGreaterThanOrEqual(before);
    }
  });

  it('records nothing for sessions it did not stop, or failed to (negative)', async () => {
    const killSessionFn = vi.fn(async (_wt: string, tool: CLIToolType) => {
      if (tool === 'claude') throw new Error('tmux gone');
      return false;
    });

    await cleanupWorktreeSessions('wt-idle', killSessionFn);

    expect(recorded()).toEqual([]);
  });

  it('records the global sessions it stopped, and only those', async () => {
    vi.mocked(hasSession).mockImplementation(async (name: string) => name.startsWith('mcbd-claude-'));
    vi.mocked(killSession).mockResolvedValue(true);

    expect(await cleanupGlobalSessions()).toBe(1);

    expect(recorded().map((r) => [r.api, r.origin, r.worktreeId, r.instanceId])).toEqual([
      ['session-cleanup', 'server', GLOBAL_SESSION_WORKTREE_ID, 'claude'],
    ]);
  });
});
