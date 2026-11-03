/**
 * Issue #4115: the pure transform, the composition readers, and restart pending.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  buildRoleLaunchArguments,
  computeRoleInjection,
  OPENCODE_V2_COMMON_INSTRUCTIONS,
  renderRoleFlags,
  ROLE_WRAPPER_TEXT,
  type RoleComposition,
} from '@/lib/agent-roles/adapters';
import {
  fixedEnvReader,
  loadRoleComposition,
  parseUserOpencodeContent,
  readCodexDeveloperInstructions,
  resolveOpencodeV2EffectiveAgent,
  RoleCompositionError,
} from '@/lib/agent-roles/composition';
import { parseJsoncObject } from '@/lib/agent-roles/jsonc';
import { computeBodyFingerprint } from '@/lib/agent-roles/fingerprint';
import { prepareExplicitRoleLaunch } from '@/lib/agent-roles/explicit-launch';
import { buildInstanceRoleSettings, computeRestartPending } from '@/lib/agent-roles/management';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  recordRoleLaunch,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
  updateAgentRole,
} from '@/lib/db/agent-roles-db';
import { AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, isAgentRoleAdapterEnabled, type RoleLaunchRecord } from '@/types/agent-roles';

function role(body: string) {
  return { body, bodyFingerprint: computeBodyFingerprint(body) };
}

describe('the injection fingerprint', () => {
  const fp = (adapter: Parameters<typeof computeRoleInjection>[0], body: string, composition: RoleComposition = {}) =>
    computeRoleInjection(adapter, role(body), composition).injectionFingerprint;

  it('moves with the body and with the adapter', () => {
    expect(fp('claude', 'a')).toBe(fp('claude', 'a'));
    expect(fp('claude', 'a')).not.toBe(fp('claude', 'b'));
    expect(fp('claude', 'a')).not.toBe(fp('codex', 'a'));
  });

  it('moves with what is composed in: Codex\'s instructions, V2\'s agent, an explicit agent', () => {
    expect(fp('codex', 'a', { codexDeveloperInstructions: 'x' })).not.toBe(fp('codex', 'a'));
    expect(fp('opencode-v2', 'a', { opencodeV2EffectiveAgent: 'plan' })).not.toBe(
      fp('opencode-v2', 'a', { opencodeV2EffectiveAgent: 'build' })
    );
    expect(fp('opencode', 'a', { explicitAgent: 'plan' })).not.toBe(fp('opencode', 'a'));
  });

  it('does not move with the other keys of the user\'s env', () => {
    expect(fp('opencode', 'a', { opencodeUserContent: { model: 'x', providers: {} } })).toBe(
      fp('opencode', 'a', { opencodeUserContent: { model: 'y' } })
    );
  });

  it('holds the body only as text for the model, and records the V2 wrapper separately', () => {
    const v2 = computeRoleInjection('opencode-v2', role('BODY'), { opencodeV2EffectiveAgent: 'build' });
    expect(v2.instructions.startsWith(OPENCODE_V2_COMMON_INSTRUCTIONS)).toBe(true);
    expect(v2.instructions).toContain(ROLE_WRAPPER_TEXT);
    expect(v2.instructions.endsWith('BODY')).toBe(true);
    expect(v2.wrapperVersion).not.toBe(computeRoleInjection('claude', role('BODY'), {}).wrapperVersion);
    expect(computeRoleInjection('claude', role('BODY'), {}).instructions).not.toContain(OPENCODE_V2_COMMON_INSTRUCTIONS);
  });
});

describe('how a file reaches each CLI', () => {
  const artifact = { name: 'cm-role-x', path: '/data dir/cm-role-x.md' };

  it('Codex precedes `exec` and Copilot follows `gh copilot` in a headless argv', () => {
    expect(buildRoleLaunchArguments({ adapter: 'codex', effectiveAgent: null }, artifact, {})).toMatchObject({
      args: ['-p', 'cm-role-x'],
      headlessPosition: 'leading',
    });
    expect(buildRoleLaunchArguments({ adapter: 'copilot', effectiveAgent: null }, artifact, {})).toMatchObject({
      args: ['--agent', 'cm-role-x'],
      headlessPosition: 'leading',
    });
    expect(buildRoleLaunchArguments({ adapter: 'claude', effectiveAgent: null }, artifact, {}).headlessPosition).toBe('trailing');
  });

  it('a path with a space is quoted on a line', () => {
    expect(renderRoleFlags(['--mod', '/data dir/x.ts'])).toBe("--mod '/data dir/x.ts'");
    expect(renderRoleFlags(['-p', 'cm-role-x'])).toBe('-p cm-role-x');
  });

  it('V1 with no env of the user is a plain value; with one it is marked as carrying theirs', () => {
    const plain = buildRoleLaunchArguments({ adapter: 'opencode', effectiveAgent: null }, artifact, {});
    expect(plain.envCarriesUserValues).toBe(false);
    expect(JSON.parse(plain.env.OPENCODE_CONFIG_CONTENT)).toEqual({ instructions: [artifact.path] });
    const composed = buildRoleLaunchArguments({ adapter: 'opencode', effectiveAgent: null }, artifact, {
      opencodeUserContent: { instructions: ['a'], model: 'm' },
    });
    expect(composed.envCarriesUserValues).toBe(true);
    expect(JSON.parse(composed.env.OPENCODE_CONFIG_CONTENT)).toEqual({ instructions: ['a', artifact.path], model: 'm' });
  });

  it('V2 adds `system` to the effective agent only, keeping that agent\'s other keys', () => {
    const composed = buildRoleLaunchArguments({ adapter: 'opencode-v2', effectiveAgent: 'mine' }, artifact, {
      opencodeUserContent: { agents: { mine: { model: 'a' }, other: { model: 'b' } }, providers: { p: {} } },
    });
    expect(JSON.parse(composed.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      agents: { mine: { model: 'a', system: `{file:${artifact.path}}` }, other: { model: 'b' } },
      providers: { p: {} },
    });
  });
});

describe('V2: which agent, and whose text', () => {
  const none = { userContent: null, projectConfigs: [], globalConfigs: [], markdownDefinition: () => null };
  const file = (data: Record<string, unknown>, where = '/p.jsonc') => ({ path: where, data });

  it('explicit, env, project, global, then build', () => {
    const all = {
      ...none,
      userContent: { default_agent: 'env' },
      projectConfigs: [file({ default_agent: 'project' })],
      globalConfigs: [file({ default_agent: 'global' })],
    };
    expect(resolveOpencodeV2EffectiveAgent({ ...all, explicitAgent: 'explicit' })).toBe('explicit');
    expect(resolveOpencodeV2EffectiveAgent(all)).toBe('env');
    expect(resolveOpencodeV2EffectiveAgent({ ...all, userContent: null })).toBe('project');
    expect(resolveOpencodeV2EffectiveAgent({ ...all, userContent: null, projectConfigs: [] })).toBe('global');
    expect(resolveOpencodeV2EffectiveAgent(none)).toBe('build');
  });

  it('refuses a name that is not one, and two project files that disagree', () => {
    expect(() => resolveOpencodeV2EffectiveAgent({ ...none, userContent: { default_agent: 3 } })).toThrow(RoleCompositionError);
    expect(() => resolveOpencodeV2EffectiveAgent({ ...none, explicitAgent: '../x' })).toThrow(RoleCompositionError);
    expect(() =>
      resolveOpencodeV2EffectiveAgent({
        ...none,
        projectConfigs: [file({ default_agent: 'a' }, '/a'), file({ default_agent: 'b' }, '/b')],
      })
    ).toThrow(/different default agents/);
  });

  it.each([
    ['the env', { ...none, userContent: { agents: { build: { system: 'mine' } } } }],
    ['the project', { ...none, projectConfigs: [file({ agents: { build: { system: 'mine' } } })] }],
    ['global', { ...none, globalConfigs: [file({ agent: { build: { system: 'mine' } } })] }],
    ['a Markdown definition', { ...none, markdownDefinition: () => '/x/build.md' }],
  ])('refuses an effective agent with its own system text in %s', (_where, input) => {
    expect(() => resolveOpencodeV2EffectiveAgent(input)).toThrow(/has its own system text/);
  });

  it('another agent\'s system text is no conflict', () => {
    expect(resolveOpencodeV2EffectiveAgent({ ...none, userContent: { agents: { other: { system: 'mine' } } } })).toBe('build');
  });
});

describe('reading the user\'s settings', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-role-compose-4115-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('JSONC: comments and trailing commas, and strings left alone', () => {
    expect(parseJsoncObject('{ // c\n "a": "// not a comment", /* x */ "b": [1,2,], }')).toEqual({ a: '// not a comment', b: [1, 2] });
    expect(() => parseJsoncObject('[1]')).toThrow('not a JSON object');
    expect(() => parseJsoncObject('{"key": SECRET}')).toThrow('not valid JSONC');
  });

  it('an invalid env value says so without quoting it', () => {
    expect(parseUserOpencodeContent(undefined)).toBeNull();
    expect(parseUserOpencodeContent('  ')).toBeNull();
    let message = '';
    try {
      parseUserOpencodeContent('{"apiKey": SECRET');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('silently ignore');
    expect(message).not.toContain('SECRET');
  });

  it('Codex: absent is none, a table with another type there is refused, and it reads tables at all', () => {
    expect(readCodexDeveloperInstructions(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "m"\n[model_providers.x]\nname = \'n\'\n');
    expect(readCodexDeveloperInstructions(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'config.toml'), 'developer_instructions = """\nmulti\nline"""\n');
    expect(readCodexDeveloperInstructions(dir)).toBe('multi\nline');
    fs.writeFileSync(path.join(dir, 'config.toml'), 'developer_instructions = 3\n');
    expect(() => readCodexDeveloperInstructions(dir)).toThrow(RoleCompositionError);
  });

  it('V2 reads the files of the worktree and the config home it is told about', async () => {
    const worktree = path.join(dir, 'wt');
    const config = path.join(dir, 'xdg');
    fs.mkdirSync(path.join(worktree, '.opencode'), { recursive: true });
    fs.mkdirSync(path.join(config, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(config, 'opencode', 'opencode.jsonc'), '{ "default_agent": "plan", }');
    const read = (env: Record<string, string>) =>
      loadRoleComposition('opencode-v2', { worktreePath: worktree, readEnv: fixedEnvReader(env) });

    await expect(read({ XDG_CONFIG_HOME: config })).resolves.toMatchObject({ opencodeV2EffectiveAgent: 'plan' });
    fs.writeFileSync(path.join(worktree, '.opencode', 'opencode.jsonc'), '{ "default_agent": "mine" }');
    await expect(read({ XDG_CONFIG_HOME: config })).resolves.toMatchObject({ opencodeV2EffectiveAgent: 'mine' });

    fs.writeFileSync(path.join(worktree, 'opencode.json'), '{ broken');
    await expect(read({ XDG_CONFIG_HOME: config })).rejects.toThrow(/not valid JSONC/);
    fs.rmSync(path.join(worktree, 'opencode.json'));

    fs.mkdirSync(path.join(worktree, '.opencode', 'agents'));
    fs.writeFileSync(path.join(worktree, '.opencode', 'agents', 'mine.md'), '---\n---\nbody');
    await expect(read({ XDG_CONFIG_HOME: config })).rejects.toThrow(/has its own system text/);
  });

  it('a probe\'s explicit role goes through the same checks, with no database, and says what it ran under', async () => {
    const worktree = path.join(dir, 'wt');
    fs.mkdirSync(worktree);
    const artifacts = { dataRoot: path.join(dir, 'data'), codexHome: path.join(dir, 'codex') };
    fs.mkdirSync(artifacts.codexHome);
    const launch = await prepareExplicitRoleLaunch('codex', { id: 'probe-role', body: 'BODY' }, {
      worktreePath: worktree,
      env: {},
      namespace: 'probe',
      artifacts,
    });
    expect(launch.lineSuffix).toMatch(/^ -p cm-role-probe-probe-role-/);
    expect(launch.linePrefix).toBe('');
    expect(launch.condition).toMatchObject({ roleId: 'probe-role', adapter: 'codex', bodyFingerprint: computeBodyFingerprint('BODY') });
    expect(JSON.stringify(launch)).not.toContain('BODY');
    const v1 = await prepareExplicitRoleLaunch('opencode', { id: 'probe-role', body: 'BODY' }, {
      worktreePath: worktree,
      env: {},
      namespace: 'probe',
      artifacts,
    });
    expect(v1.linePrefix).toContain('OPENCODE_CONFIG_CONTENT=');
    expect(v1.lineSuffix).toBe('');
  });

  it('Antigravity is on only when someone says so', () => {
    expect(isAgentRoleAdapterEnabled('antigravity')).toBe(false);
    vi.stubEnv(AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, '1');
    expect(isAgentRoleAdapterEnabled('antigravity')).toBe(true);
    expect(isAgentRoleAdapterEnabled('claude')).toBe(true);
  });
});

describe('restart pending', () => {
  const WT = 'wt-restart-4115';
  const ROOT = '/tmp/cm-4115/root';
  let db: Database.Database;
  let repositoryId: string;
  let a: string;
  let b: string;

  const deps = {
    resolveCommonDir: async () => '/same/.git',
    pathExists: () => true,
    loadComposition: async (): Promise<RoleComposition> => ({ opencodeV2EffectiveAgent: 'build' }),
    currentGeneration: () => 'g1',
  };

  async function application(overrides: Partial<typeof deps> = {}) {
    const settings = await buildInstanceRoleSettings(db, WT, { ...deps, ...overrides });
    return settings.instances.find((entry) => entry.instanceId === 'claude')?.application;
  }

  function launchedWith(fingerprint: string | null, generation = 'g1'): void {
    recordRoleLaunch(db, {
      worktreeId: WT,
      instanceId: 'claude',
      cliToolId: 'claude',
      phase: 'launched',
      sessionGeneration: generation,
      source: 'system',
      repositoryId: null,
      roleId: null,
      roleName: null,
      bodyVersion: null,
      bodyFingerprint: null,
      injectionFingerprint: fingerprint,
      artifactFingerprint: null,
      adapterId: null,
      adapterVersion: null,
      wrapperVersion: null,
      artifactPath: null,
      effectiveAgent: null,
      compositionSourceFingerprint: null,
      noRoleReason: fingerprint === null ? 'no-default' : null,
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name, selected_agents) VALUES (?, ?, ?, ?, 'repo', ?)`
    ).run(WT, WT, `${ROOT}/wt`, ROOT, JSON.stringify(['claude', 'codex']));
    repositoryId = createRepository(db, { name: 'repo', path: ROOT, cloneSource: 'local' }).id;
    a = createAgentRole(db, { name: 'A', body: 'BODY A' }).id;
    b = createAgentRole(db, { name: 'B', body: 'BODY B' }).id;
  });

  afterEach(() => db.close());

  async function launchedUnderCurrentDefault(): Promise<string> {
    const next = (await application())?.effectiveNext.injectionFingerprint as string;
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    launchedWith(next);
    return next;
  }

  it('A → A is no; A → B, A → none and A → inherit-from-another are yes', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launchedUnderCurrentDefault();
    expect((await application())?.restartPending).toBe('no');

    setSystemRoleDefault(db, 'claude', b);
    expect((await application())?.restartPending).toBe('yes');

    setSystemRoleDefault(db, 'claude', null);
    const none = await application();
    expect(none?.effectiveNext.injectionFingerprint).toBeNull();
    expect(none?.restartPending).toBe('yes');

    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'role', roleId: b });
    expect((await application())?.restartPending).toBe('yes');
    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'inherit' });
    setSystemRoleDefault(db, 'claude', a);
    expect((await application())?.restartPending).toBe('no');
  });

  it('the same text from another level, or under another name, is no', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launchedUnderCurrentDefault();
    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'role', roleId: a });
    expect((await application())?.restartPending).toBe('no');
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: a });
    expect((await application())?.restartPending).toBe('no');
    updateAgentRole(db, a, { name: 'A renamed' });
    expect((await application())?.restartPending).toBe('no');
    const twin = createAgentRole(db, { name: 'Twin', body: 'BODY A' }).id;
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: twin });
    expect((await application())?.restartPending).toBe('no');
  });

  it('an edited body, and the same body through another adapter version, are yes', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launchedUnderCurrentDefault();
    updateAgentRole(db, a, { body: 'BODY A edited' });
    expect((await application())?.restartPending).toBe('yes');
    // A fingerprint of another adapter or wrapper reads the same way: it is just another value.
    updateAgentRole(db, a, { body: 'BODY A' });
    launchedWith(computeRoleInjection('codex', role('BODY A'), {}).injectionFingerprint, 'g1-other');
    expect((await application({ currentGeneration: () => 'g1-other' }))?.restartPending).toBe('yes');
  });

  it('no role launched and no role now is no; a role appearing is yes', async () => {
    launchedWith(null);
    expect((await application())?.restartPending).toBe('no');
    setSystemRoleDefault(db, 'claude', a);
    expect((await application())?.restartPending).toBe('yes');
  });

  it('with no evidence it is unknown, not "no role": no record, or another generation', async () => {
    setSystemRoleDefault(db, 'claude', a);
    expect((await application())?.restartPending).toBe('unknown');
    await launchedUnderCurrentDefault();
    // After a server restart nothing vouches for the record.
    const restarted = await application({ currentGeneration: () => null as unknown as string });
    expect(restarted?.launched).toBeNull();
    expect(restarted?.restartPending).toBe('unknown');
  });

  it('when the fingerprint cannot be computed it is unknown', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launchedUnderCurrentDefault();
    const broken = await application({ loadComposition: async () => { throw new Error('unreadable'); } });
    expect(broken?.effectiveNext.kind).toBe('role');
    expect(broken?.effectiveNext.injectionFingerprint).toBeNull();
    expect(broken?.restartPending).toBe('unknown');
  });

  it('with no deps it stays as #4114 left it', async () => {
    setSystemRoleDefault(db, 'claude', a);
    const settings = await buildInstanceRoleSettings(db, WT, { resolveCommonDir: deps.resolveCommonDir, pathExists: deps.pathExists });
    expect(settings.instances[0].application.effectiveNext.injectionFingerprint).toBeNull();
    expect(settings.instances[0].application.restartPending).toBe('unknown');
  });

  it('the pure comparison', () => {
    const record = (injectionFingerprint: string | null) => ({ injectionFingerprint }) as RoleLaunchRecord;
    expect(computeRestartPending({ computed: true, fingerprint: 'x' }, record('x'))).toBe('no');
    expect(computeRestartPending({ computed: true, fingerprint: 'x' }, record('y'))).toBe('yes');
    expect(computeRestartPending({ computed: false, fingerprint: null }, record(null))).toBe('unknown');
    expect(computeRestartPending({ computed: true, fingerprint: 'x' }, null)).toBe('unknown');
  });
});
