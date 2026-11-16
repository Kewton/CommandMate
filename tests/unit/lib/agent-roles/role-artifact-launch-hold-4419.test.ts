/**
 * A launch's claim on its Antigravity definition, from its preparation until its
 * pane is confirmed alive or the launch ends (Issue #4419; the windows after
 * `requested` are in `role-artifact-launch-invariant-4419.test.ts`): a role
 * deleted in between does not take the file away from it, however long it
 * takes, and a launch that ends gives the claim up.
 *
 * Driven through the real `runWithLaunchRole` / `gateLaunchRole` /
 * `renderLaunchCommandWithRole` and a real database. HOME is a private
 * temporary directory, proven before each test: the real `~/.gemini` is never
 * read or written.
 *
 * Positive controls: a claim that is released (the launch failed, or both of
 * two launches ended) lets the file go at once, and a file whose launch is on
 * record goes by its session alone.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createAgentRole, deleteAgentRole, setSystemRoleDefault } from '@/lib/db/agent-roles-db';
import { resolveArtifactLocation } from '@/lib/agent-roles/artifacts';
import {
  cleanUpDeletedRoleArtifacts,
  type RoleArtifactCleanupDeps,
  type RoleArtifactSessionPresence,
} from '@/lib/agent-roles/artifact-cleanup';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import {
  gateLaunchRole,
  renderLaunchCommandWithRole,
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runWithLaunchRole,
  type LaunchRoleSnapshot,
} from '@/lib/session/role-launch';

const WT = 'wt-4419-hold';
const DAY = 24 * 60 * 60_000;

describe('a launch holds its definition until it is on record (Issue #4419)', () => {
  let base: string;
  let home: string;
  let worktreePath: string;
  let db: Database.Database;
  let roleId: string;
  const present = new Set<string>();
  const deps: RoleArtifactCleanupDeps = {
    probeSession: async ({ instanceId }): Promise<RoleArtifactSessionPresence> =>
      present.has(instanceId) ? 'present' : 'absent',
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-hold-4419-')));
    home = join(base, 'home');
    worktreePath = join(base, 'wt');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(worktreePath);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', '');
    vi.stubEnv('CM_UAT_ISOLATION', '');
    vi.stubEnv('XDG_CONFIG_HOME', join(base, 'config'));
    // The guard: the default location must be inside the private HOME.
    expect(homedir()).toBe(home);
    const probe = resolveArtifactLocation('antigravity', 'cm-role-probe');
    if (!probe.path.startsWith(`${home}${sep}`)) throw new Error('HOME is not pinned; refusing to run');

    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
      WT,
      WT,
      worktreePath,
      join(base, 'repo')
    );
    roleId = createAgentRole(db, { name: 'Reviewer', body: 'HOLD_BODY: review carefully.' }).id;
    setSystemRoleDefault(db, 'antigravity', roleId);
    present.clear();
  });

  afterEach(() => {
    resetLaunchRoleStateForTest();
    db.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  function snapshotFor(instanceId: string): Promise<LaunchRoleSnapshot> {
    return resolveLaunchRole(db, {
      worktreeId: WT,
      cliToolId: 'antigravity',
      instanceId,
      worktreePath,
      readEnv: fixedEnvReader({}),
    });
  }

  /** The path every launch of this role writes: one namespace, one role, one injection. */
  let rolePath = '';

  /** The file is prepared before any pane exists, as `BaseCLITool` does. */
  function prepare(): string {
    expect(gateLaunchRole()).toBeNull();
    expect(existsSync(rolePath)).toBe(true);
    return rolePath;
  }

  /** The line a driver types: opens the generation and records `requested`. */
  function typeLine(instanceId: string): void {
    renderLaunchCommandWithRole(
      { target: { worktreeId: WT, cliToolId: 'antigravity', instanceId }, executablePath: 'agy', worktreePath },
      { command: 'agy', settingsPath: null, env: {} }
    );
  }

  /** A launch that finished earlier on another instance: on record, its session since gone. */
  async function earlierLaunch(instanceId = 'agy-old'): Promise<string> {
    await runWithLaunchRole(await snapshotFor(instanceId), async () => {
      expect(gateLaunchRole()).toBeNull();
      typeLine(instanceId);
    });
    const row = db
      .prepare(`SELECT artifact_path FROM agent_role_launch_records WHERE instance_id = ? AND phase = 'requested'`)
      .get(instanceId) as { artifact_path: string } | undefined;
    expect(row?.artifact_path).toBeTruthy();
    rolePath = row!.artifact_path;
    return rolePath;
  }

  async function deleteAndClean() {
    deleteAgentRole(db, roleId, { force: true });
    return (await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries;
  }

  it('a launch still before its record a day later keeps the file (beyond any timed hold)', async () => {
    const path = await earlierLaunch();
    let entries: Awaited<ReturnType<typeof deleteAndClean>> = [];
    await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      expect(prepare()).toBe(path);
      // agy --version, the pane and `agy agent` took far longer than anyone expects.
      vi.setSystemTime(Date.now() + DAY + 60_000);
      entries = await deleteAndClean();
    });
    expect(entries).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('a launch whose record could not be saved, and went on, keeps the file for this process', async () => {
    const path = await earlierLaunch();
    db.exec(`CREATE TRIGGER fail_new_record BEFORE INSERT ON agent_role_launch_records
             WHEN NEW.instance_id = 'agy-new' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      expect(prepare()).toBe(path);
      typeLine('agy-new'); // the line is typed; the record is not there
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_role_launch_records WHERE instance_id = 'agy-new'`).get()).toEqual({
      n: 0,
    });
    vi.setSystemTime(Date.now() + DAY + 60_000);
    expect(await deleteAndClean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('a launch that failed and left lets the file go at once (positive control)', async () => {
    const path = await earlierLaunch();
    const failure = await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      expect(prepare()).toBe(path);
      throw new Error('the pane could not be created');
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(await deleteAndClean()).toEqual([{ kind: 'removed', path }]);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('two launches preparing the same file: one ending does not free it for the other', async () => {
    const path = await earlierLaunch();
    let releaseSecond!: () => void;
    const secondMayEnd = new Promise<void>((resolve) => (releaseSecond = resolve));
    let secondPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => (secondPrepared = resolve));
    const second = runWithLaunchRole(await snapshotFor('agy-b'), async () => {
      expect(prepare()).toBe(path);
      secondPrepared();
      await secondMayEnd;
      throw new Error('refused later');
    }).catch(() => undefined);
    await prepared;
    await runWithLaunchRole(await snapshotFor('agy-a'), async () => {
      expect(prepare()).toBe(path);
      throw new Error('refused');
    }).catch(() => undefined);

    vi.setSystemTime(Date.now() + DAY + 60_000);
    deleteAgentRole(db, roleId, { force: true });
    expect((await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries).toEqual([
      { kind: 'kept', path, reason: 'launch-preparing' },
    ]);
    expect(existsSync(path)).toBe(true);

    releaseSecond();
    await second;
    expect((await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries).toEqual([{ kind: 'removed', path }]);
  });

  it('once `requested` is on record, the session decides (positive and negative control)', async () => {
    const path = await earlierLaunch();
    await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      expect(prepare()).toBe(path);
      typeLine('agy-new');
      present.add('agy-new');
      deleteAgentRole(db, roleId, { force: true });
      expect((await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries).toEqual([
        { kind: 'skipped', path, reason: 'in-use' },
      ]);
      // The session stopped while the launch was still settling: the hold is not what keeps it.
      present.delete('agy-new');
      expect((await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries).toEqual([{ kind: 'removed', path }]);
    });
  });
});
