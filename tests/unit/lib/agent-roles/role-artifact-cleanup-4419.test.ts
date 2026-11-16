/**
 * Removing a deleted role's Antigravity definitions (Issue #4419).
 *
 * HOME is a private temporary directory for every test, and each test first
 * proves that the agents directory resolves inside it: the real `~/.gemini` is
 * never read or written.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { computeFingerprint } from '@/lib/agent-roles/fingerprint';
import { homedir, tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createAgentRole, deleteAgentRole, recordRoleLaunch } from '@/lib/db/agent-roles-db';
import {
  buildArtifactName,
  deriveServerNamespace,
  inspectRoleArtifact,
  removeRoleArtifact,
  resolveArtifactLocation,
  ROLE_ARTIFACT_PREPARED_HOLD_MS,
  writeRoleArtifact,
} from '@/lib/agent-roles/artifacts';
import {
  cleanUpDeletedRoleArtifacts,
  type RoleArtifactCleanupDeps,
} from '@/lib/agent-roles/artifact-cleanup';

const WT = 'wt-4419';

function fingerprintOf(path: string): string {
  return computeFingerprint(readFileSync(path));
}
let fp = 0;
/** A fresh injection fingerprint, so every write is a new name. */
function nextFingerprint(): string {
  fp += 1;
  return fp.toString(16).padStart(12, '0').padEnd(64, '0');
}

describe('cleanUpDeletedRoleArtifacts (Issue #4419)', () => {
  let base: string;
  let home: string;
  let agents: string;
  let db: Database.Database;
  const dead: RoleArtifactCleanupDeps = { probeSession: async () => 'absent' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-cleanup-4419-')));
    home = join(base, 'home');
    mkdirSync(home, { mode: 0o700 });
    vi.stubEnv('HOME', home);
    vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', '');
    vi.stubEnv('CM_UAT_ISOLATION', '');
    agents = join(home, '.gemini', 'config', 'agents');
    // The guard: the default location must be inside the private HOME.
    expect(homedir()).toBe(home);
    const probe = resolveArtifactLocation('antigravity', 'cm-role-probe');
    if (!probe.path.startsWith(`${home}${sep}`)) throw new Error('HOME is not pinned; refusing to run');
    expect(dirname(dirname(probe.path))).toBe(agents);

    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
      WT,
      WT,
      join(base, 'wt'),
      join(base, 'repo')
    );
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    // Undo any chmod a test made, so the directory can be removed.
    if (existsSync(agents)) {
      chmodSync(agents, 0o700);
      for (const entry of readdirSync(agents)) chmodSync(join(agents, entry), 0o700);
    }
    rmSync(base, { recursive: true, force: true });
  });

  /** Write a definition for this role as a launch would, and its launch records. */
  function launch(
    roleId: string,
    options: { instanceId?: string; generation?: string; namespace?: string } = {}
  ): { name: string; path: string } {
    const name = buildArtifactName({
      namespace: options.namespace ?? deriveServerNamespace(db.name),
      roleId,
      injectionFingerprint: nextFingerprint(),
    });
    const artifact = writeRoleArtifact({ adapter: 'antigravity', name, instructions: 'be a reviewer' });
    record(roleId, { ...options, path: artifact.path, artifactFingerprint: artifact.artifactFingerprint });
    return { name, path: artifact.path };
  }

  function record(
    roleId: string | null,
    options: { instanceId?: string; generation?: string; path: string | null; artifactFingerprint: string | null }
  ): void {
    for (const phase of ['requested', 'launched'] as const) {
      recordRoleLaunch(db, {
        worktreeId: WT,
        instanceId: options.instanceId ?? 'antigravity',
        cliToolId: 'antigravity',
        phase,
        sessionGeneration: options.generation ?? `g-${nextFingerprint().slice(0, 12)}`,
        source: 'instance',
        repositoryId: null,
        roleId,
        roleName: roleId === null ? null : 'Reviewer',
        bodyVersion: roleId === null ? null : 1,
        bodyFingerprint: roleId === null ? null : 'b'.repeat(64),
        injectionFingerprint: null,
        artifactFingerprint: options.artifactFingerprint,
        adapterId: roleId === null ? null : 'antigravity',
        adapterVersion: null,
        wrapperVersion: null,
        artifactPath: options.path,
        effectiveAgent: null,
        compositionSourceFingerprint: null,
        noRoleReason: roleId === null ? 'no-default' : null,
      });
    }
  }

  function role(name = 'Reviewer'): string {
    return createAgentRole(db, { name, body: 'be a reviewer' }).id;
  }

  /** Past the hold a launch's preparation puts on its file. */
  function afterTheHold(): void {
    vi.setSystemTime(Date.now() + ROLE_ARTIFACT_PREPARED_HOLD_MS + 1000);
  }

  async function deleteAndClean(roleId: string, deps: RoleArtifactCleanupDeps = dead, aged = true) {
    deleteAgentRole(db, roleId, { force: true });
    if (aged) afterTheHold();
    return (await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries;
  }

  it('removes the deleted role\'s definitions and nothing else (positive control)', async () => {
    const doomed = role('Doomed');
    const other = role('Other');
    const first = launch(doomed);
    const second = launch(doomed); // an edited body: a second name for the same role
    const kept = launch(other);
    // The user's own agent, and a lookalike of the doomed role's name that no record names.
    mkdirSync(join(agents, 'my-agent'), { mode: 0o700 });
    writeFileSync(join(agents, 'my-agent', 'agent.md'), '---\nname: my-agent\n---\nmine\n', { mode: 0o600 });
    const lookalike = join(agents, `cm-role-${deriveServerNamespace(db.name)}-${doomed}-ffffffffffff`);
    mkdirSync(lookalike, { mode: 0o700 });
    writeFileSync(join(lookalike, 'agent.md'), 'not ours\n', { mode: 0o600 });

    const entries = await deleteAndClean(doomed);

    expect(entries).toEqual(
      expect.arrayContaining([
        { kind: 'removed', path: first.path },
        { kind: 'removed', path: second.path },
      ])
    );
    expect(entries).toHaveLength(2);
    expect(existsSync(dirname(first.path))).toBe(false);
    expect(existsSync(dirname(second.path))).toBe(false);
    expect(readdirSync(agents).sort()).toEqual(
      [kept.name, 'my-agent', `cm-role-${deriveServerNamespace(db.name)}-${doomed}-ffffffffffff`].sort()
    );
  });

  it('removes nothing while the role exists (negative control)', async () => {
    const id = role();
    const { path } = launch(id);
    const { entries } = await cleanUpDeletedRoleArtifacts(db, id, dead);
    expect(entries).toEqual([{ kind: 'skipped', path, reason: 'role-exists' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('a role that never ran on Antigravity has nothing to remove', async () => {
    const id = role();
    expect(await deleteAndClean(id)).toEqual([]);
  });

  it('keeps a definition whose bytes are not the recorded ones', async () => {
    const id = role();
    const { path } = launch(id);
    writeFileSync(path, '---\nname: edited\n---\nby hand\n', { mode: 0o600 });
    expect(await deleteAndClean(id)).toEqual([{ kind: 'kept', path, reason: 'content-mismatch' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('keeps a definition whose directory holds anything else', async () => {
    const id = role();
    const { path } = launch(id);
    writeFileSync(join(dirname(path), 'notes.md'), 'mine\n', { mode: 0o600 });
    expect(await deleteAndClean(id)).toEqual([{ kind: 'kept', path, reason: 'foreign-entries' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('skips a recorded name that is not this server\'s name for the role', async () => {
    const id = role();
    const { path } = launch(id, { namespace: 'otherns1' });
    expect(await deleteAndClean(id)).toEqual([{ kind: 'skipped', path, reason: 'not-this-role' }]);
    expect(existsSync(path)).toBe(true);
  });

  describe('a session that may still read it', () => {
    it('keeps it while a live session\'s latest launch runs on it', async () => {
      const id = role();
      const { path } = launch(id, { instanceId: 'agy-1' });
      const asked: string[] = [];
      const entries = await deleteAndClean(id, {
        probeSession: async (target) => {
          asked.push(`${target.worktreeId}/${target.cliToolId}/${target.instanceId}`);
          return 'present';
        },
      });
      expect(entries).toEqual([{ kind: 'skipped', path, reason: 'in-use' }]);
      expect(asked).toEqual([`${WT}/antigravity/agy-1`]);
      expect(existsSync(path)).toBe(true);
    });

    it('keeps it when tmux answers unknown', async () => {
      const id = role();
      const { path } = launch(id);
      const entries = await deleteAndClean(id, { probeSession: async () => 'unknown' });
      expect(entries).toEqual([{ kind: 'skipped', path, reason: 'liveness-unknown' }]);
      expect(existsSync(path)).toBe(true);
    });

    it('keeps it when the probe throws', async () => {
      const id = role();
      const { path } = launch(id);
      const entries = await deleteAndClean(id, {
        probeSession: async () => {
          throw new Error('tmux is not answering');
        },
      });
      expect(entries).toEqual([{ kind: 'skipped', path, reason: 'liveness-unknown' }]);
      expect(existsSync(path)).toBe(true);
    });

    it('removes it once the live session was relaunched without it', async () => {
      const id = role();
      const { path } = launch(id);
      record(null, { path: null, artifactFingerprint: null });
      const entries = await deleteAndClean(id, { probeSession: async () => 'present' });
      expect(entries).toEqual([{ kind: 'removed', path }]);
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('a launch that prepared it but has not recorded it yet (review P2)', () => {
    it('keeps a definition a launch in this process wrote within the hold', async () => {
      const id = role();
      const { path } = launch(id);
      expect(await deleteAndClean(id, dead, false)).toEqual([{ kind: 'kept', path, reason: 'recently-prepared' }]);
      expect(existsSync(path)).toBe(true);
    });

    it('a reuse or an inspection by a later launch renews the hold', async () => {
      const id = role();
      const { name, path } = launch(id);
      afterTheHold();
      // Another instance prepares the same file: reused, then inspected before its launch.
      inspectRoleArtifact({ adapter: 'antigravity', name, path, expectedFingerprint: fingerprintOf(path) });
      expect(await deleteAndClean(id, dead, false)).toEqual([{ kind: 'kept', path, reason: 'recently-prepared' }]);
      afterTheHold();
      expect((await cleanUpDeletedRoleArtifacts(db, id, dead)).entries).toEqual([{ kind: 'removed', path }]);
    });
  });

  describe('between the last check and the unlink (review P3-1)', () => {
    it('leaves a file that was replaced after it was checked', async () => {
      const id = role();
      const { path } = launch(id);
      const bytes = readFileSync(path);
      const entries = await deleteAndClean(id, {
        ...dead,
        removalHooks: {
          beforeUnlink: () => {
            // Same bytes, another inode: not the file that was checked.
            renameSync(path, `${path}.old`);
            writeFileSync(path, bytes, { mode: 0o600 });
            rmSync(`${path}.old`);
          },
        },
      });
      expect(entries).toEqual([{ kind: 'kept', path, reason: 'replaced' }]);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('never fails the deletion', () => {
    it('a directory that cannot be removed after agent.md is reported (review P3-2)', async () => {
      const id = role();
      const { path } = launch(id);
      chmodSync(agents, 0o500);
      const entries = await deleteAndClean(id);
      chmodSync(agents, 0o700);
      expect(entries).toEqual([{ kind: 'failed', path, reason: 'directory-left:EACCES' }]);
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dirname(path))).toEqual([]);
    });

    it('a missing agents directory is reported, not thrown', async () => {
      const id = role();
      const { path } = launch(id);
      rmSync(join(home, '.gemini'), { recursive: true, force: true });
      expect(await deleteAndClean(id)).toEqual([{ kind: 'kept', path, reason: 'missing' }]);
    });

    it('a permission the filesystem refuses is reported, not thrown', async () => {
      const id = role();
      const { path } = launch(id);
      chmodSync(dirname(path), 0o500);
      const entries = await deleteAndClean(id);
      expect(entries).toEqual([{ kind: 'failed', path, reason: 'EACCES' }]);
      chmodSync(dirname(path), 0o700);
      expect(existsSync(path)).toBe(true);
    });

    it('CM_UAT_ISOLATION=1 leaves the shared home alone', async () => {
      const id = role();
      const { path } = launch(id);
      vi.stubEnv('CM_UAT_ISOLATION', '1');
      expect(await deleteAndClean(id)).toEqual([{ kind: 'kept', path, reason: 'read-only' }]);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('removeRoleArtifact refuses another adapter and a path that is not where the name lives', () => {
    const name = buildArtifactName({ namespace: 'ns', roleId: 'r1', injectionFingerprint: nextFingerprint() });
    expect(removeRoleArtifact({ adapter: 'copilot', name, path: '/x', expectedFingerprint: 'f' })).toEqual({
      kind: 'kept',
      path: '/x',
      reason: 'unsupported-adapter',
    });
    const elsewhere = join(base, 'elsewhere', name, 'agent.md');
    expect(removeRoleArtifact({ adapter: 'antigravity', name, path: elsewhere, expectedFingerprint: 'f' })).toEqual({
      kind: 'kept',
      path: elsewhere,
      reason: 'unexpected-location',
    });
  });
});
