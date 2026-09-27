/**
 * Issue #2866: adopting this server's pre-namespace sessions at startup.
 * tmux and the DB are stubbed; the alias table and the name rule are real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db/agent-instances-db', () => ({
  getAgentInstances: vi.fn(() => []),
}));

import { getAgentInstances } from '@/lib/db/agent-instances-db';
import { adoptLegacySessions } from '@/lib/session/adopt-legacy-sessions';
import { resolveSessionName, setActiveSessionNamespace } from '@/lib/cli-tools/session-name';
import { clearLegacyAliasesForTests, lookupLegacyAlias } from '@/lib/tmux/legacy-session-alias';
import type { TmuxSession } from '@/lib/tmux/tmux';

const NS = '0a1b2c3d';
const WT_PATH = '/work/repo-a/wt-1';

function fakeDb(worktrees: Array<{ id: string; path: string }>): Database.Database {
  return {
    prepare: vi.fn(() => ({ all: vi.fn(() => worktrees) })),
  } as unknown as Database.Database;
}

function session(name: string, path: string): TmuxSession {
  return { name, windows: 1, attached: false, path };
}

/** Plain string comparison — realpath is not what this suite is about. */
const samePath = (sessionPath: string | null, worktreePath: string): boolean => sessionPath === worktreePath;

describe('adoptLegacySessions (Issue #2866)', () => {
  beforeEach(() => {
    setActiveSessionNamespace(NS);
    vi.mocked(getAgentInstances).mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    setActiveSessionNamespace(null);
    clearLegacyAliasesForTests();
  });

  it('adopts a legacy session in the worktree directory when no new-format session exists', async () => {
    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: {
        listSessions: async () => [session('mcbd-claude-wt-1', WT_PATH)],
        isSessionOwnedBy: samePath,
      },
    });

    expect(result.adopted).toEqual([
      { worktreeId: 'wt-1', newName: `mcbd-${NS}-claude-wt-1`, legacyName: 'mcbd-claude-wt-1' },
    ]);
    expect(resolveSessionName('claude', 'wt-1')).toBe('mcbd-claude-wt-1');
    // Other tools of the same worktree have no legacy session: untouched.
    expect(resolveSessionName('codex', 'wt-1')).toBe(`mcbd-${NS}-codex-wt-1`);
  });

  it('does not adopt a foreign legacy session (different session_path)', async () => {
    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: {
        listSessions: async () => [session('mcbd-claude-wt-1', '/work/other-server/wt-1')],
        isSessionOwnedBy: samePath,
      },
    });

    expect(result.adopted).toEqual([]);
    expect(lookupLegacyAlias(`mcbd-${NS}-claude-wt-1`)).toBeUndefined();
    expect(resolveSessionName('claude', 'wt-1')).toBe(`mcbd-${NS}-claude-wt-1`);
  });

  it('does not adopt when the new-format session already exists', async () => {
    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: {
        listSessions: async () => [
          session('mcbd-claude-wt-1', WT_PATH),
          session(`mcbd-${NS}-claude-wt-1`, WT_PATH),
        ],
        isSessionOwnedBy: samePath,
      },
    });

    expect(result.adopted).toEqual([]);
    expect(resolveSessionName('claude', 'wt-1')).toBe(`mcbd-${NS}-claude-wt-1`);
  });

  it('covers roster instances as well as primaries', async () => {
    vi.mocked(getAgentInstances).mockReturnValue([
      { id: 'codex-2', cliTool: 'codex' } as ReturnType<typeof getAgentInstances>[number],
    ]);

    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: {
        listSessions: async () => [session('mcbd-codex-wt-1-2', WT_PATH)],
        isSessionOwnedBy: samePath,
      },
    });

    expect(result.adopted.map((a) => a.legacyName)).toEqual(['mcbd-codex-wt-1-2']);
    expect(resolveSessionName('codex', 'wt-1', 'codex-2')).toBe('mcbd-codex-wt-1-2');
  });

  it('does nothing without a namespace', async () => {
    setActiveSessionNamespace(null);
    const listSessions = vi.fn(async () => [session('mcbd-claude-wt-1', WT_PATH)]);

    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: { listSessions, isSessionOwnedBy: samePath },
    });

    expect(result.adopted).toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('never throws: a failed listing is reported', async () => {
    const result = await adoptLegacySessions(fakeDb([{ id: 'wt-1', path: WT_PATH }]), {
      tmux: {
        listSessions: async () => {
          throw new Error('tmux gone');
        },
      },
    });

    expect(result.adopted).toEqual([]);
    expect(result.errors).toEqual(['tmux gone']);
  });
});
