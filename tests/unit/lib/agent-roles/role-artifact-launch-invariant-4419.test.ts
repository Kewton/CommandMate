/**
 * The invariant behind the cleanup of a deleted role's Antigravity definition
 * (Issue #4419, re-instruction 3): a definition a launch record names is not
 * removed until (a) that launch's pane exists and is confirmed alive, or (b) the
 * launch has failed, by any path (a launch, a Schedule, a forced deletion).
 *
 * One test per window:
 * - between `requested` being saved and the pane being created
 * - a Schedule preparing the file while a launch holds it, and the launch failing
 * - after the launch failed the file may go
 * - after the pane is confirmed alive, the session's presence decides
 * - one launch's pane being confirmed does not free another launch's claim
 *
 * Driven through the real `runWithLaunchRole` / `gateLaunchRole` /
 * `renderLaunchCommandWithRole` / `resolveScheduleRole` and a real database.
 * HOME is a private temporary directory, proven before each test: the real
 * `~/.gemini` is never read or written. Each test fails on 73489768b (the
 * claim was released when `requested` was saved, and a preparation under
 * another launch's claim left no mark of its own).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, sep } from 'path';
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
  resolveScheduleRole,
  runWithLaunchRole,
  type LaunchRoleSnapshot,
} from '@/lib/session/role-launch';

const WT = 'wt-4419-invariant';
const DAY = 24 * 60 * 60_000;

describe('a recorded definition stays until its pane is alive or its launch failed (Issue #4419)', () => {
  let base: string;
  let home: string;
  let worktreePath: string;
  let db: Database.Database;
  let roleId: string;
  /** The instances whose tmux session exists: the panes created so far. */
  const present = new Set<string>();
  const deps: RoleArtifactCleanupDeps = {
    probeSession: async ({ instanceId }): Promise<RoleArtifactSessionPresence> =>
      present.has(instanceId) ? 'present' : 'absent',
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-invariant-4419-')));
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
    roleId = createAgentRole(db, { name: 'Reviewer', body: 'INVARIANT_BODY: review carefully.' }).id;
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

  let rolePath = '';

  /** The file is prepared before any pane exists, as `BaseCLITool` does. */
  function prepare(): void {
    expect(gateLaunchRole()).toBeNull();
    expect(existsSync(rolePath)).toBe(true);
  }

  /** The line a driver builds: opens the generation and saves `requested`. The pane comes after. */
  function typeLine(instanceId: string): void {
    renderLaunchCommandWithRole(
      { target: { worktreeId: WT, cliToolId: 'antigravity', instanceId }, executablePath: 'agy', worktreePath },
      { command: 'agy', settingsPath: null, env: {} }
    );
    const row = db
      .prepare(`SELECT artifact_path FROM agent_role_launch_records WHERE instance_id = ? AND phase = 'requested'`)
      .get(instanceId) as { artifact_path: string } | undefined;
    expect(row?.artifact_path).toBe(rolePath);
  }

  /** A launch that finished earlier on another instance: on record, its session since gone. */
  async function earlierLaunch(): Promise<string> {
    await runWithLaunchRole(await snapshotFor('agy-old'), async () => {
      expect(gateLaunchRole()).toBeNull();
      renderLaunchCommandWithRole(
        { target: { worktreeId: WT, cliToolId: 'antigravity', instanceId: 'agy-old' }, executablePath: 'agy', worktreePath },
        { command: 'agy', settingsPath: null, env: {} }
      );
    });
    const row = db
      .prepare(`SELECT artifact_path FROM agent_role_launch_records WHERE instance_id = 'agy-old' AND phase = 'requested'`)
      .get() as { artifact_path: string } | undefined;
    expect(row?.artifact_path).toBeTruthy();
    rolePath = row!.artifact_path;
    return rolePath;
  }

  async function clean() {
    return (await cleanUpDeletedRoleArtifacts(db, roleId, deps)).entries;
  }

  it('between `requested` being saved and the pane being created, a forced deletion keeps it', async () => {
    const path = await earlierLaunch();
    await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      prepare();
      typeLine('agy-new');
      // `await this.createLaunchPane(...)` has not returned: tmux has no session yet.
      deleteAgentRole(db, roleId, { force: true });
      expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
      expect(existsSync(path)).toBe(true);
      // The pane is created and alive: the session keeps it from here.
      present.add('agy-new');
      expect(await clean()).toEqual([{ kind: 'skipped', path, reason: 'in-use' }]);
    });
    expect(existsSync(path)).toBe(true);
  });

  it('a Schedule preparing it while a launch holds it keeps its own guard when that launch fails', async () => {
    const path = await earlierLaunch();
    const failure = await runWithLaunchRole(await snapshotFor('agy-a'), async () => {
      prepare();
      // A Schedule of the same default role prepares the same file, with no claim of its own.
      const schedule = await resolveScheduleRole(db, { worktreeId: WT, cliToolId: 'antigravity', worktreePath, env: {} });
      if (schedule.kind !== 'role') throw new Error(schedule.kind);
      expect(schedule.role.args).toEqual(['--agent', basename(dirname(path))]);
      throw new Error('the launch failed');
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('the launch failed');

    deleteAgentRole(db, roleId, { force: true });
    // The launch's end is not the Schedule's: its run may still read the file.
    expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'recently-prepared' }]);
    expect(existsSync(path)).toBe(true);
    // Negative control: past the Schedule's own guard it goes.
    vi.setSystemTime(Date.now() + DAY + 60_000);
    expect(await clean()).toEqual([{ kind: 'removed', path }]);
  });

  it('kept while the launch is on its way, and removable once the launch failed', async () => {
    const path = await earlierLaunch();
    const failure = await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      prepare();
      typeLine('agy-new');
      deleteAgentRole(db, roleId, { force: true });
      expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
      throw new Error('the pane could not be created');
    }).catch((error: unknown) => error);
    // Only the launch's own failure: an assertion above must not pass as one.
    expect((failure as Error).message).toBe('the pane could not be created');
    expect(await clean()).toEqual([{ kind: 'removed', path }]);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('once the pane is confirmed alive and the launch returned, the session decides', async () => {
    const path = await earlierLaunch();
    await runWithLaunchRole(await snapshotFor('agy-new'), async () => {
      prepare();
      typeLine('agy-new');
      deleteAgentRole(db, roleId, { force: true });
      expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
      present.add('agy-new'); // createLaunchPane returned
    });
    expect(await clean()).toEqual([{ kind: 'skipped', path, reason: 'in-use' }]);
    expect(existsSync(path)).toBe(true);
    present.delete('agy-new'); // the session was stopped
    expect(await clean()).toEqual([{ kind: 'removed', path }]);
  });

  it("one launch's pane being confirmed does not free another launch's claim", async () => {
    const path = await earlierLaunch();
    // Both launches resolved the role before it was deleted.
    const snapshotA = await snapshotFor('agy-a');
    const snapshotB = await snapshotFor('agy-b');
    let bMayEnd!: () => void;
    const bEnds = new Promise<void>((resolve) => (bMayEnd = resolve));
    let bRecorded!: () => void;
    const recorded = new Promise<void>((resolve) => (bRecorded = resolve));
    const second = runWithLaunchRole(snapshotB, async () => {
      prepare();
      typeLine('agy-b');
      bRecorded();
      await bEnds; // its pane is not created yet
    });
    await recorded;
    await runWithLaunchRole(snapshotA, async () => {
      prepare();
      typeLine('agy-a');
      deleteAgentRole(db, roleId, { force: true });
      present.add('agy-a');
      expect(await clean()).toEqual([{ kind: 'skipped', path, reason: 'in-use' }]);
      present.delete('agy-a'); // a's session went; b's pane is still to come
      expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
    });
    expect(await clean()).toEqual([{ kind: 'kept', path, reason: 'launch-preparing' }]);
    expect(existsSync(path)).toBe(true);
    bMayEnd();
    await second;
    // b returned without a live session (its pane is gone): nothing keeps it now.
    expect(await clean()).toEqual([{ kind: 'removed', path }]);
  });
});
