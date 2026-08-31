/**
 * `scanWorktrees()` re-reads `.commandmate/agents.yaml` (Issue #2066).
 *
 * This is the half of the Issue that says "read it **at sync**". Without it the
 * declaration would still work — `getRepoDefaultSelectedAgents()` is lazy and
 * self-heals after its TTL — so a test that only checks the resolved value
 * cannot tell the two implementations apart. What separates them is *when* an
 * edit becomes visible, and that is what is asserted here: the cache is primed,
 * the file is rewritten, and the new value must be in force immediately after a
 * scan rather than a minute later.
 *
 * `child_process` is mocked because the subject is the read, not git: a real
 * repository would add three subprocesses to the unit suite to produce a
 * `git worktree list` string this file can simply hand over.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';

// Factory mock (not auto-mock) so the mock function does NOT inherit
// `util.promisify.custom` from the real exec, which would make promisify(exec)
// bypass mockImplementation entirely — see tests/unit/worktrees.test.ts.
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { scanWorktrees } from '@/lib/git/worktrees';
import {
  clearRepoAgentsConfigCache,
  getRepoDefaultSelectedAgents,
  refreshRepoAgentsConfig,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
} from '@/lib/repo-config/agents-config';

/** A clock far enough in the past that a real `Date.now()` expiry outlives it. */
const T0 = 1_000_000;

let repo: string;

function declare(contents: string): void {
  mkdirSync(join(repo, '.commandmate'), { recursive: true });
  writeFileSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
}

/**
 * The mock has no `util.promisify.custom`, so `promisify(exec)` falls back to
 * the plain callback convention and resolves with the callback's SECOND
 * argument. `scanWorktrees` destructures `{ stdout }` from that value, so the
 * mock has to hand over the object rather than the string.
 */
function gitReturns(stdout: string): void {
  vi.mocked(exec).mockImplementation(((
    _cmd: string,
    _opts: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    if (callback) callback(null, { stdout, stderr: '' });
    return {} as never;
  }) as never);
}

describe('scanWorktrees() refreshes the repository agent declaration (Issue #2066)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeTempDir('repo-agents-scan-2066-');
    declare('agents: [opencode, codex]\n');
    clearRepoAgentsConfigCache();
    // The shape `git worktree list` (no --porcelain) prints, which is what
    // `parseWorktreeOutput` matches: path, commit, [branch].
    gitReturns(`${repo}  abc1234 [main]\n`);
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  it('adopts an edit at the next scan rather than at the next TTL expiry', async () => {
    // Prime the cache the way a previous sync would have.
    expect(refreshRepoAgentsConfig(repo, T0)).toEqual(['opencode', 'codex']);

    declare('agents: [gemini, claude]\nprimary: claude\n');
    // Still stale — nothing has told the cache to look again.
    expect(getRepoDefaultSelectedAgents(repo, T0 + 1)).toEqual(['opencode', 'codex']);

    const scanned = await scanWorktrees(repo);

    expect(scanned).toHaveLength(1);
    expect(getRepoDefaultSelectedAgents(repo, T0 + 2)).toEqual(['claude', 'gemini']);
  });

  /**
   * The naive form of this test — scan, then read the value — is VACUOUS: the
   * lazy cold-miss read in `getRepoDefaultSelectedAgents()` returns the same
   * answer with the scan-time refresh deleted (found by the #2066 integration
   * review, L3). Deleting the file after the scan is what separates them: the
   * value can only still be there if the scan put it there.
   */
  it('populates the cache during the scan, not on the later read', async () => {
    await scanWorktrees(repo);

    rmSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH));

    expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['opencode', 'codex']);
  });

  it('forgets a declaration that was deleted between scans', async () => {
    expect(refreshRepoAgentsConfig(repo, T0)).toEqual(['opencode', 'codex']);
    rmSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH));

    await scanWorktrees(repo);

    expect(getRepoDefaultSelectedAgents(repo, T0 + 1)).toBeNull();
  });

  /**
   * A directory that is not a git repository returns `[]` before the read is
   * reached, so a scan of one must not overwrite whatever the cache holds for a
   * path that IS a repository under a different name. Asserted on the same path
   * both ways round, which is the only way the ordering inside `scanWorktrees`
   * is observable from outside.
   */
  it('does not touch the cache when the directory is not a git repository', async () => {
    expect(refreshRepoAgentsConfig(repo, T0)).toEqual(['opencode', 'codex']);
    declare('agents: [gemini, claude]\n');

    vi.mocked(exec).mockImplementation(((
      _cmd: string,
      _opts: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const error = new Error('fatal: not a git repository') as Error & { code?: number };
      error.code = 128;
      if (callback) callback(error, '', '');
      return {} as never;
    }) as never);

    expect(await scanWorktrees(repo)).toEqual([]);
    expect(getRepoDefaultSelectedAgents(repo, T0 + 1)).toEqual(['opencode', 'codex']);
  });
});
