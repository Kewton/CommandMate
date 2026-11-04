/**
 * Issue #4134: a root that is no longer a Git repository cannot be the same
 * repository as anything, so it stops blocking the worktrees of other roots. A
 * git that failed or timed out still does: it cannot say.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveInstanceRole, type RoleResolverDeps } from '@/lib/agent-roles/resolve';
import { createAgentRole, setRepositoryRoleState } from '@/lib/db/agent-roles-db';
import { createRepository } from '@/lib/db/db-repository';
import { runMigrations } from '@/lib/db/db-migrations';
import type { GitCommonDirProbe } from '@/lib/git/git-common-dir';

const WT = 'wt-4134';
const OWN = '/tmp/cm-4134/own-root';
const OTHER = '/tmp/cm-4134/other-root';
const WORKTREE = `/tmp/cm-4134/${WT}`;

const REPO: GitCommonDirProbe = { kind: 'repository', commonDir: '/common/.git' };

/** `identity` answers for the worktree and the root it names, which is what its identity is read from. */
function deps(other: GitCommonDirProbe, identity: GitCommonDirProbe = REPO): RoleResolverDeps {
  return {
    probeCommonDir: async (p) => (p === OTHER ? other : identity),
    pathExists: () => true,
  };
}

describe('a root that is not a repository', () => {
  let db: Database.Database;
  let role: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
    ).run(WT, WT, WORKTREE, OWN);
    role = createAgentRole(db, { name: 'r', body: 'body' }).id;
    const own = createRepository(db, { name: 'own', path: OWN, cloneSource: 'local' }).id;
    setRepositoryRoleState(db, own, 'claude', { state: 'role', roleId: role });
    createRepository(db, { name: 'other', path: OTHER, cloneSource: 'local' });
  });

  const resolve = (d: RoleResolverDeps) => resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, d);

  it('does not block: the role is sent', async () => {
    const result = await resolve(deps({ kind: 'not-repository' }));
    expect(result).toMatchObject({ kind: 'role', source: 'repository' });
  });

  it('is not counted as a member either', async () => {
    const result = await resolve(deps({ kind: 'not-repository' }));
    expect(result.repositoryIds).toHaveLength(1);
  });

  it('is not a candidate even while the worktree itself cannot be identified', async () => {
    const result = await resolve(deps({ kind: 'not-repository' }, { kind: 'failed' }));
    expect(result).toMatchObject({ kind: 'role', source: 'repository' });
  });

  it('control: a git that failed still blocks', async () => {
    const result = await resolve(deps({ kind: 'failed' }));
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'membership-undetermined' });
  });

  it('control: a root the worktree cannot be compared with still blocks when it may be a repository', async () => {
    const result = await resolve(deps({ kind: 'repository', commonDir: '/other/.git' }, { kind: 'failed' }));
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'membership-undetermined' });
  });

  it('control: a resolver injected the old way reads null as a failure, as before', async () => {
    const result = await resolve({
      resolveCommonDir: async (p) => (p === OTHER ? null : '/common/.git'),
      pathExists: () => true,
    });
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'membership-undetermined' });
  });

  it('the root a worktree names stays its root even when git no longer knows it', async () => {
    const result = await resolve(deps({ kind: 'not-repository' }, { kind: 'not-repository' }));
    expect(result).toMatchObject({ kind: 'role', source: 'repository' });
  });
});
