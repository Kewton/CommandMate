/**
 * Issue #4233, item 2: OpenCode V2's role composition read a relative
 * `XDG_CONFIG_HOME` / `HOME` against the server's cwd, while opencode resolves
 * it against the cwd it is started in (the worktree).
 *
 * `loadOpencodeV2Agent` (`agent-roles/composition.ts`) reads the pane's
 * environment and the global `opencode.json(c)` / `agents/*.md` from
 * `<XDG_CONFIG_HOME>/opencode`. Each test pairs the cwd this process reports
 * (`serverCwd`) with the cwd opencode is started in (`launchCwd`), and puts a
 * different `default_agent` under each so the one read is the one that answers.
 * A reused pane that was `cd`'d away is modelled by an injected launch-cwd
 * reader (tmux is never reached, as `pane-env.ts` does under test).
 * docs/design/relative-config-home-4233.md §3.2 / §3.3, #11-#14 and #21-#25.
 *
 * Only reads, apart from the fixtures made under `os.tmpdir()`; the Schedule
 * case writes its role file under a stubbed `CM_AGENT_ROLE_ARTIFACTS_DIR` there.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const execFileSpy = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  execFileSpy.mockImplementation(actual.execFile as never);
  return { ...actual, execFile: execFileSpy };
});

import {
  fixedEnvReader,
  loadRoleComposition,
  RoleCompositionError,
  type RoleLaunchCwdReader,
} from '@/lib/agent-roles/composition';
import { roleLaunchCwdReaderForPane, tmuxPaneLaunchCwdReader } from '@/lib/agent-roles/pane-env';
import { runMigrations } from '@/lib/db/db-migrations';
import { createAgentRole, setSystemRoleDefault } from '@/lib/db/agent-roles-db';
import { resolveScheduleRole } from '@/lib/session/role-launch';

let serverCwd: string;
let launchCwd: string;
let elsewhere: string;
let fakeHome: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** `<base>/<rel>/opencode/opencode.json` with this `default_agent`. */
function globalConfig(base: string, rel: string, agent: string): void {
  writeJson(join(base, rel, 'opencode', 'opencode.json'), { default_agent: agent });
}

function compose(env: Record<string, string>, readLaunchCwd?: RoleLaunchCwdReader) {
  return loadRoleComposition('opencode-v2', {
    worktreePath: launchCwd,
    readEnv: fixedEnvReader(env),
    ...(readLaunchCwd ? { readLaunchCwd } : {}),
  });
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4233-xdg-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4233-xdg-worktree-'));
  elsewhere = mkdtempSync(join(tmpdir(), 'cm-4233-xdg-cd-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'cm-4233-xdg-home-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  execFileSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of [serverCwd, launchCwd, elsewhere, fakeHome]) rmSync(dir, { recursive: true, force: true });
});

describe('a relative XDG_CONFIG_HOME / HOME for OpenCode V2 (Issue #4233)', () => {
  it('#11 is read from the launch cwd, not the server cwd', async () => {
    globalConfig(launchCwd, 'rel-xdg', 'plan');
    globalConfig(serverCwd, 'rel-xdg', 'other');
    const composition = await compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome });
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
  });

  it('#12 a Markdown definition under it, from the launch cwd, is refused like any other', async () => {
    mkdirSync(join(launchCwd, 'rel-xdg', 'opencode', 'agents'), { recursive: true });
    writeFileSync(join(launchCwd, 'rel-xdg', 'opencode', 'agents', 'build.md'), 'my own build agent');
    await expect(compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome })).rejects.toBeInstanceOf(RoleCompositionError);
  });

  it('#21 a relative HOME with no XDG_CONFIG_HOME is read from the launch cwd', async () => {
    globalConfig(launchCwd, join('rel-home', '.config'), 'plan');
    globalConfig(serverCwd, join('rel-home', '.config'), 'other');
    const composition = await compose({ HOME: 'rel-home' });
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
  });

  it('#22 a reused pane that was cd\'d away refuses instead of reading either directory', async () => {
    globalConfig(launchCwd, 'rel-xdg', 'plan');
    globalConfig(elsewhere, 'rel-xdg', 'other');
    const readLaunchCwd = vi.fn(async () => elsewhere);
    await expect(compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome }, readLaunchCwd)).rejects.toThrow(
      /is not the worktree/
    );
    expect(readLaunchCwd).toHaveBeenCalledTimes(1);
  });

  it('#22b a pane whose cwd cannot be read refuses too', async () => {
    const readLaunchCwd = vi.fn(async () => {
      throw new Error('tmux said something else');
    });
    await expect(compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome }, readLaunchCwd)).rejects.toBeInstanceOf(
      RoleCompositionError
    );
  });
});

describe('what a relative XDG_CONFIG_HOME does not change (Issue #4233)', () => {
  it('#23 a reused pane still in the worktree (spelled through its realpath) reads as #11 does', async () => {
    globalConfig(launchCwd, 'rel-xdg', 'plan');
    globalConfig(serverCwd, 'rel-xdg', 'other');
    const composition = await compose(
      { XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome },
      async () => realpathSync(launchCwd)
    );
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
  });

  it('#23b a pane that does not exist yet (null) starts in the worktree', async () => {
    globalConfig(launchCwd, 'rel-xdg', 'plan');
    const composition = await compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome }, async () => null);
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
  });

  it('#13 / #24 an absolute XDG_CONFIG_HOME is read as it is, and the pane cwd is never asked', async () => {
    const xdg = join(elsewhere, 'abs-xdg');
    writeJson(join(xdg, 'opencode', 'opencode.json'), { default_agent: 'plan' });
    const readLaunchCwd = vi.fn(async () => elsewhere);
    const composition = await compose({ XDG_CONFIG_HOME: xdg, HOME: fakeHome }, readLaunchCwd);
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
    expect(readLaunchCwd).not.toHaveBeenCalled();
  });

  it('#14 an unset XDG_CONFIG_HOME reads HOME/.config/opencode, and the pane cwd is never asked', async () => {
    writeJson(join(fakeHome, '.config', 'opencode', 'opencode.json'), { default_agent: 'plan' });
    const readLaunchCwd = vi.fn(async () => elsewhere);
    const composition = await compose({ HOME: fakeHome }, readLaunchCwd);
    expect(composition.opencodeV2EffectiveAgent).toBe('plan');
    expect(readLaunchCwd).not.toHaveBeenCalled();
  });
});

describe('a Schedule under a relative XDG_CONFIG_HOME (Issue #4233)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
    ).run('wt-4233', 'wt-4233', launchCwd, launchCwd);
    vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', join(fakeHome, 'roles'));
    vi.stubEnv('CM_UAT_ISOLATION', '');
    setSystemRoleDefault(db, 'opencode-v2', createAgentRole(db, { name: 'A', body: 'BODY A' }).id);
  });

  afterEach(() => {
    db.close();
  });

  it('#25 resolves it against the worktree the child runs in, and never asks tmux', async () => {
    globalConfig(launchCwd, 'rel-xdg', 'plan');
    globalConfig(serverCwd, 'rel-xdg', 'other');
    const result = await resolveScheduleRole(
      db,
      {
        worktreeId: 'wt-4233',
        cliToolId: 'opencode-v2',
        worktreePath: launchCwd,
        env: { XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome },
      },
      { resolveCommonDir: async () => null, pathExists: () => false }
    );
    if (result.kind !== 'role') throw new Error(`${result.kind}: ${JSON.stringify(result)}`);
    expect(Object.keys(JSON.parse(result.role.env.OPENCODE_CONFIG_CONTENT).agents)).toEqual(['plan']);
    expect(execFileSpy.mock.calls.filter(([file]) => file === 'tmux')).toEqual([]);
  });
});

describe('the pane launch-cwd reader (Issue #4233)', () => {
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  const answer = (error: Error | null, stdout: string, stderr = '') =>
    execFileSpy.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Callback) => {
      callback(error, stdout, stderr);
    });

  it('asks tmux for the pane_current_path of exactly that session', async () => {
    answer(null, '/some/where\n');
    await expect(tmuxPaneLaunchCwdReader('mcbd-opencode-v2-wt')()).resolves.toBe('/some/where');
    expect(execFileSpy).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', '=mcbd-opencode-v2-wt:', '#{pane_current_path}'],
      expect.anything(),
      expect.any(Function)
    );
  });

  it.each(["can't find session: mcbd-x", 'no server running on /tmp/tmux-501/default'])(
    'answers null (a new pane, in the worktree) when tmux says %s',
    async (stderr) => {
      answer(new Error('exit 1'), '', stderr);
      await expect(tmuxPaneLaunchCwdReader('mcbd-x')()).resolves.toBeNull();
    }
  );

  it('rejects on any other answer, so the composition refuses', async () => {
    answer(new Error('timeout'), '', 'something unexpected');
    await expect(tmuxPaneLaunchCwdReader('mcbd-x')()).rejects.toThrow();
    answer(null, '\n');
    await expect(tmuxPaneLaunchCwdReader('mcbd-x')()).rejects.toThrow();
  });

  it('is not used at all in a test run (no tmux from here)', () => {
    expect(roleLaunchCwdReaderForPane({ worktreeId: 'wt', cliToolId: 'opencode-v2' })).toBeUndefined();
  });
});
