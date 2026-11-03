/**
 * Issue #4115: a role through a real `BaseCLITool.startSession`, a real database and
 * real files in a temporary directory. tmux is mocked; nothing else on the way is.
 *
 * Positive controls: without the wiring, a launch line has no role, a second start
 * joins the first, and a reused process is recorded. Negative: with no role the line
 * is byte for byte what `renderAgentLaunchCommand` gave before.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  getLatestRoleLaunchRecords,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
  updateAgentRole,
} from '@/lib/db/agent-roles-db';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
  prepareAgentLaunch,
} from '@/lib/session/agent-session-lifecycle';
import { renderAgentLaunchCommand } from '@/lib/hooks/sources';
import {
  forgetLaunchRoleEvidence,
  getLaunchRoleEvidence,
  moveLaunchRoleEvidence,
  noteLaunchResumedConversation,
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runningRoleProblem,
  setLaunchRoleDatabaseForTest,
  takeResumedAcrossRoleNotice,
  wasResumedAcrossRole,
} from '@/lib/session/role-launch';
import { clearSessionStarting } from '@/lib/session/session-starting-state';
import { resetSessionLaunchFlightsForTest, isSessionLaunchRoleMismatchError } from '@/lib/session/session-launch-flight';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import { readRoleLaunchRefusal, RoleLaunchRefusedError } from '@/lib/agent-roles/launch-errors';
import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR } from '@/types/agent-roles';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

const pane = vi.hoisted(() => ({ exists: false, alive: true, screen: '', cwd: '' }));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(async () => pane.exists),
  capturePane: vi.fn(async () => pane.screen),
  killSession: vi.fn(async () => {
    pane.exists = false;
    return true;
  }),
  createSession: vi.fn(async () => {
    pane.exists = true;
  }),
  reconcileSessionGeometry: vi.fn(async () => false),
  getSessionWorkingDirectory: vi.fn(async () => pane.cwd),
  sendSpecialKey: vi.fn(async () => undefined),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => undefined),
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeSessionLiveness: vi.fn(async () => ({ alive: pane.alive, reason: 'test' })),
}));

const WT = 'wt-4115';
const BODY = 'ROLE_BODY_MARKER: speak like a marketer.';

const EXECUTABLES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  'command-code': 'commandcode',
  opencode: 'opencode',
  'opencode-v2': 'opencode2',
  copilot: 'gh copilot',
  antigravity: 'agy',
};

/** The shape every driver has, and nothing else: reuse a live pane, or build a line. */
class TestTool extends BaseCLITool {
  readonly name: string;
  readonly command: string;
  lines: string[] = [];
  launches = 0;
  gate: Promise<void> | null = null;
  serverConfig: unknown = null;
  killed = 0;
  /** Codex's relaunch after its update: the same line, typed again into the same pane. */
  relaunchOnce = false;

  constructor(
    readonly id: CLIToolType,
    private readonly worktreePath: string
  ) {
    super();
    this.name = id;
    this.command = EXECUTABLES[id] ?? id;
  }

  async sendMessage(): Promise<void> {}
  async killSession(): Promise<void> {
    this.killed += 1;
    pane.exists = false;
  }
  protected async readServerConfig(): Promise<unknown> {
    return this.serverConfig;
  }
  relaunch(worktreeId: string, instanceId?: string): Promise<void> {
    return this.relaunchIfToolExited(worktreeId, instanceId);
  }
  protected async launchSession(worktreeId: string, worktreePath: string, instanceId?: string): Promise<void> {
    this.launches += 1;
    if (pane.exists && pane.alive) return;
    const target = { worktreeId, cliToolId: this.id, instanceId };
    beginAgentSession(target);
    const line = buildAgentLaunchCommandLine({ target, executablePath: this.command, worktreePath });
    pane.exists = true;
    pane.alive = true;
    if (this.gate) await this.gate;
    this.lines.push(line);
    if (this.relaunchOnce) {
      this.relaunchOnce = false;
      beginAgentSession(target);
      this.lines.push(line);
    }
    expect(worktreePath).toBe(this.worktreePath);
  }
}

let dir: string;
let worktreePath: string;
let rootPath: string;
let db: Database.Database;
let repositoryId: string;
let roleId: string;

function tool(id: CLIToolType): TestTool {
  return new TestTool(id, worktreePath);
}

function records(instanceId: string) {
  return getLatestRoleLaunchRecords(db, WT, instanceId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-role-launch-4115-'));
  worktreePath = path.join(dir, 'worktree');
  rootPath = path.join(dir, 'root');
  fs.mkdirSync(worktreePath);
  fs.mkdirSync(rootPath);
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(WT, WT, worktreePath, rootPath);
  repositoryId = createRepository(db, { name: 'repo', path: rootPath, cloneSource: 'local' }).id;
  roleId = createAgentRole(db, { name: 'Marketer', body: BODY }).id;
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  pane.exists = false;
  pane.alive = true;
  pane.screen = '';
  pane.cwd = worktreePath;
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('COPILOT_HOME', path.join(dir, 'copilot'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'config'));
  vi.stubEnv('HOME', path.join(dir, 'home'));
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', '');
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'copilot'), { recursive: true });
});

afterEach(() => {
  resetLaunchRoleStateForTest();
  resetSessionLaunchFlightsForTest();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the launch line of each adapter', () => {
  const cases: Array<[CLIToolType, (line: string, data: string) => void]> = [
    ['claude', (line, data) => expect(line).toContain(`--append-system-prompt-file ${data}/claude/cm-role-`)],
    ['codex', (line) => expect(line).toMatch(/ -p cm-role-[a-z0-9-]+$/)],
    ['command-code', (line, data) => expect(line).toContain(`--mod ${data}/command-code/cm-role-`)],
    ['copilot', (line) => expect(line).toMatch(/gh copilot --agent cm-role-[a-z0-9-]+$/)],
    ['opencode', (line, data) => expect(line).toContain(`OPENCODE_CONFIG_CONTENT='{"instructions":["${data}/opencode/cm-role-`)],
    ['opencode-v2', (line, data) => expect(line).toContain(`"agents":{"build":{"system":"{file:${data}/opencode-v2/cm-role-`)],
    ['antigravity', (line) => expect(line).toMatch(/ --agent cm-role-[a-z0-9-]+$/)],
  ];

  it.each(cases)('%s names the file and never the body', async (cliTool, check) => {
    vi.stubEnv(AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, '1');
    setSystemRoleDefault(db, cliTool, roleId);
    const instance = tool(cliTool);
    await instance.startSession(WT, worktreePath);
    expect(instance.lines).toHaveLength(1);
    check(instance.lines[0], path.join(dir, 'data'));
    expect(instance.lines[0]).not.toContain(BODY);
    expect(instance.lines[0]).not.toContain(worktreePath + '/.');
  });

  it.each(Object.keys(EXECUTABLES) as CLIToolType[])('%s with no role is byte for byte the plain line', async (cliTool) => {
    const target = { worktreeId: WT, cliToolId: cliTool };
    const context = { target, executablePath: EXECUTABLES[cliTool], worktreePath };
    const plain = renderAgentLaunchCommand(prepareAgentLaunch(context));
    // Settings exist somewhere, so this goes the whole way and not the short path.
    setSystemRoleDefault(db, 'gemini', roleId);
    const instance = tool(cliTool);
    await instance.startSession(WT, worktreePath);
    expect(instance.lines).toEqual([plain]);
  });

  it('every driver takes its line from the function the role goes through', () => {
    for (const file of ['claude-session', 'codex', 'command-code', 'copilot', 'opencode', 'opencode-v2', 'antigravity']) {
      const where = file === 'claude-session' ? 'src/lib/session' : 'src/lib/cli-tools';
      expect(fs.readFileSync(path.join(where, `${file}.ts`), 'utf8'), file).toContain('buildAgentLaunchCommandLine(');
    }
  });

  it('`CM_AGENT_HOOKS_INJECT=0` is not "no role": the role is there with hooks off', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const instance = tool('claude');
    await instance.startSession(WT, worktreePath);
    expect(instance.lines[0]).toContain('--append-system-prompt-file');
  });

  it('where it was inherited from does not change how it is passed', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const fromSystem = tool('claude');
    await fromSystem.startSession(WT, worktreePath);
    const systemEvidence = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });

    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'role', roleId });
    pane.exists = false;
    const fromRepository = tool('claude');
    await fromRepository.startSession(WT, worktreePath);

    expect(fromRepository.lines).toEqual(fromSystem.lines);
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' })?.injectionFingerprint).toBe(
      systemEvidence?.injectionFingerprint
    );
    expect(records('claude').requested?.source).toBe('repository');
  });

  it('generated files stay out of the worktree, so the gates see nothing', async () => {
    for (const cliTool of ['claude', 'codex', 'command-code', 'copilot', 'opencode', 'opencode-v2'] as const) {
      setSystemRoleDefault(db, cliTool, roleId);
      pane.exists = false;
      await tool(cliTool).startSession(WT, worktreePath);
      expect(records(cliTool).requested?.artifactPath?.startsWith(worktreePath)).toBe(false);
    }
    expect(fs.readdirSync(worktreePath)).toEqual([]);
  });
});

describe('generated content', () => {
  const NASTY = 'line1\n---\n"""\'\'\' `x` $HOME $(rm -rf /) {file:/x} {env:Y} <tag> 日本語\n---\nend';

  function artifactOf(cliTool: CLIToolType): string {
    return fs.readFileSync(records(cliTool).requested?.artifactPath as string, 'utf8');
  }

  beforeEach(() => {
    roleId = createAgentRole(db, { name: 'Nasty', body: NASTY }).id;
  });

  it('Codex: the TOML reads back to the wrapped body', async () => {
    setSystemRoleDefault(db, 'codex', roleId);
    await tool('codex').startSession(WT, worktreePath);
    const parsed = parseToml(artifactOf('codex')) as { developer_instructions: string };
    expect(parsed.developer_instructions.endsWith(NASTY)).toBe(true);
  });

  it.each(['copilot', 'antigravity'] as const)('%s: `---` in the body does not end the frontmatter', async (cliTool) => {
    vi.stubEnv(AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, '1');
    setSystemRoleDefault(db, cliTool, roleId);
    await tool(cliTool).startSession(WT, worktreePath);
    const text = artifactOf(cliTool);
    const close = text.indexOf('\n---\n', 3);
    const front = parseYaml(text.slice(4, close)) as Record<string, unknown>;
    expect(front[cliTool === 'copilot' ? 'infer' : 'subagent']).toBe(false);
    expect(text.slice(close + 5).endsWith(NASTY)).toBe(true);
  });

  it('Command Code: the mod carries the text as data, and running it runs nothing else', async () => {
    setSystemRoleDefault(db, 'command-code', roleId);
    await tool('command-code').startSession(WT, worktreePath);
    const source = artifactOf('command-code').replace('export default function', 'return function');
    const factory = new Function(source)() as (cmd: { hooks: (h: { appendSystemPrompt: () => string }) => void }) => void;
    let text = '';
    factory({ hooks: (hooks) => (text = hooks.appendSystemPrompt()) });
    expect(text.endsWith(NASTY)).toBe(true);
  });

  it('OpenCode V2: the common instructions and the body, under a wrapper version that is recorded', async () => {
    setSystemRoleDefault(db, 'opencode-v2', roleId);
    await tool('opencode-v2').startSession(WT, worktreePath);
    const text = artifactOf('opencode-v2');
    expect(text.startsWith('You are an AI agent running in OpenCode')).toBe(true);
    expect(text.endsWith(NASTY)).toBe(true);
    expect(records('opencode-v2').requested?.wrapperVersion).toContain('common');
  });
});

describe('Codex: what a profile would replace is composed in', () => {
  it('keeps `developer_instructions`, and a change there changes the fingerprint', async () => {
    fs.writeFileSync(path.join(dir, 'codex', 'config.toml'), 'developer_instructions = "USER_RULES"\n');
    setSystemRoleDefault(db, 'codex', roleId);
    await tool('codex').startSession(WT, worktreePath);
    const first = records('codex').requested;
    const text = fs.readFileSync(first?.artifactPath as string, 'utf8');
    expect((parseToml(text) as { developer_instructions: string }).developer_instructions.startsWith('USER_RULES')).toBe(true);
    expect(first?.compositionSourceFingerprint).not.toBeNull();

    fs.writeFileSync(path.join(dir, 'codex', 'config.toml'), 'developer_instructions = "OTHER"\n');
    pane.exists = false;
    await tool('codex').startSession(WT, worktreePath);
    expect(records('codex').requested?.injectionFingerprint).not.toBe(first?.injectionFingerprint);
    // The user's file is read, and only read.
    expect(fs.readFileSync(path.join(dir, 'codex', 'config.toml'), 'utf8')).toContain('OTHER');
  });

  it('a config.toml it cannot read refuses the launch', async () => {
    fs.writeFileSync(path.join(dir, 'codex', 'config.toml'), 'not = = toml');
    setSystemRoleDefault(db, 'codex', roleId);
    const instance = tool('codex');
    await expect(instance.startSession(WT, worktreePath)).rejects.toSatisfy(
      (error) => readRoleLaunchRefusal(error) === 'composition-failed'
    );
    expect(instance.launches).toBe(0);
  });
});

describe('the env the user set', () => {
  const USER = JSON.stringify({ model: 'x/model-b', providers: { x: { apiKey: 'SECRET_KEY' } }, default_agent: 'mine', agents: { mine: { model: 'y' } } });

  it('V2: keeps default_agent, model and providers in a private file; none of it is on the line', async () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', USER);
    setSystemRoleDefault(db, 'opencode-v2', roleId);
    const instance = tool('opencode-v2');
    let during = '';
    const original = instance['launchSession'].bind(instance);
    instance['launchSession'] = async (...args: Parameters<typeof original>) => {
      await original(...args);
      const file = /OPENCODE_CONFIG_CONTENT="\$\(cat '([^']+)'\)"/.exec(instance.lines[0])?.[1] as string;
      during = fs.readFileSync(file, 'utf8');
      expect(fs.statSync(file).mode & 0o077).toBe(0);
      instanceFile = file;
    };
    let instanceFile = '';
    await instance.startSession(WT, worktreePath);
    expect(instance.lines[0]).not.toContain('SECRET_KEY');
    const composed = JSON.parse(during);
    expect(composed.model).toBe('x/model-b');
    expect(composed.providers.x.apiKey).toBe('SECRET_KEY');
    expect(composed.default_agent).toBe('mine');
    expect(composed.agents.mine.model).toBe('y');
    expect(composed.agents.mine.system).toMatch(/^\{file:.*cm-role-.*\.md\}$/);
    expect(records('opencode-v2').requested?.effectiveAgent).toBe('mine');
    // Removed when the launch was over.
    expect(fs.existsSync(instanceFile)).toBe(false);
  });

  it('V1: appended to the instructions they already have', async () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"instructions":["mine.md"], /* c */ "model":"m",}');
    setSystemRoleDefault(db, 'opencode', roleId);
    const instance = tool('opencode');
    let composed: { instructions: string[]; model: string } | null = null;
    const original = instance['launchSession'].bind(instance);
    instance['launchSession'] = async (...args: Parameters<typeof original>) => {
      await original(...args);
      const file = /="\$\(cat '([^']+)'\)"/.exec(instance.lines[0])?.[1] as string;
      composed = JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    await instance.startSession(WT, worktreePath);
    const value = composed as unknown as { instructions: string[]; model: string };
    expect(value.instructions[0]).toBe('mine.md');
    expect(value.instructions[1]).toMatch(/cm-role-/);
    expect(value.model).toBe('m');
  });

  it.each(['opencode', 'opencode-v2'] as const)('%s: an invalid value refuses; V2 would have ignored it silently', async (cliTool) => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{not json');
    setSystemRoleDefault(db, cliTool, roleId);
    const instance = tool(cliTool);
    const failure = await instance.startSession(WT, worktreePath).catch((error: unknown) => error);
    expect(readRoleLaunchRefusal(failure)).toBe('composition-failed');
    expect((failure as Error).message).not.toContain('{not json');
    expect(instance.lines).toEqual([]);
  });

  it('V2: an effective agent with the user\'s own system text refuses', async () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"agents":{"build":{"system":"mine"}}}');
    setSystemRoleDefault(db, 'opencode-v2', roleId);
    await expect(tool('opencode-v2').startSession(WT, worktreePath)).rejects.toSatisfy(
      (error) => readRoleLaunchRefusal(error) === 'composition-failed'
    );
  });
});

describe('refusals send nothing and record nothing as applied', () => {
  it('Antigravity is off by default: a role refuses, and no role still starts', async () => {
    const plain = tool('antigravity');
    setSystemRoleDefault(db, 'claude', roleId);
    await plain.startSession(WT, worktreePath);
    expect(plain.lines).toHaveLength(1);

    pane.exists = false;
    setSystemRoleDefault(db, 'antigravity', roleId);
    const refused = tool('antigravity');
    await expect(refused.startSession(WT, worktreePath)).rejects.toSatisfy(
      (error) => readRoleLaunchRefusal(error) === 'adapter-disabled'
    );
    expect(refused.launches).toBe(0);
  });

  it('a home that cannot be written refuses before any pane exists', async () => {
    fs.chmodSync(path.join(dir, 'codex'), 0o500);
    try {
      setSystemRoleDefault(db, 'codex', roleId);
      const instance = tool('codex');
      await expect(instance.startSession(WT, worktreePath)).rejects.toSatisfy(
        (error) => readRoleLaunchRefusal(error) === 'artifact-failed'
      );
      expect(instance.launches).toBe(0);
      expect(pane.exists).toBe(false);
      expect(records('codex')).toEqual({ requested: null, launched: null });
    } finally {
      fs.chmodSync(path.join(dir, 'codex'), 0o700);
    }
  });

  it('a file swapped for other bytes under the same name refuses rather than being reused', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    await tool('claude').startSession(WT, worktreePath);
    const artifact = records('claude').requested?.artifactPath as string;
    fs.writeFileSync(artifact, 'tampered', { mode: 0o600 });
    pane.exists = false;
    await expect(tool('claude').startSession(WT, worktreePath)).rejects.toSatisfy(
      (error) => readRoleLaunchRefusal(error) === 'artifact-failed'
    );
  });

  it('roots that disagree refuse with the reason, and do not pick one', async () => {
    const second = createRepository(db, { name: 'repo2', path: path.join(dir, 'root2'), cloneSource: 'local' });
    fs.mkdirSync(path.join(dir, 'root2'));
    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'role', roleId });
    setRepositoryRoleState(db, second.id, 'claude', { state: 'none' });
    const snapshot = await resolveLaunchRole(
      db,
      { worktreeId: WT, cliToolId: 'claude', worktreePath, readEnv: fixedEnvReader({}) },
      { resolveCommonDir: async () => '/same/.git', pathExists: () => true }
    );
    expect(snapshot.refusal?.reason).toBe('root-settings-differ');
    expect(snapshot.injectionFingerprint).toBeNull();
  });

  it('membership-undetermined is asked once more, and refuses only if it stays that way', async () => {
    const other = path.join(dir, 'root2');
    fs.mkdirSync(other);
    const second = createRepository(db, { name: 'repo2', path: other, cloneSource: 'local' });
    setRepositoryRoleState(db, second.id, 'claude', { state: 'role', roleId });
    const input = { worktreeId: WT, cliToolId: 'claude' as const, worktreePath, readEnv: fixedEnvReader({}) };

    const asks: string[] = [];
    let answers = 0;
    const flaky = await resolveLaunchRole(db, input, {
      resolveCommonDir: async (where) => {
        asks.push(where);
        answers += 1;
        // Git fails for the other root the first time round only.
        if (where === other && asks.filter((path_) => path_ === other).length === 1) return null;
        return where === other ? '/other/.git' : '/same/.git';
      },
      pathExists: () => true,
    });
    expect(answers).toBeGreaterThan(2);
    expect(flaky.refusal).toBeNull();

    const stuck = await resolveLaunchRole(db, input, {
      resolveCommonDir: async (where) => (where === other ? null : '/same/.git'),
      pathExists: () => true,
    });
    expect(stuck.refusal?.reason).toBe('membership-undetermined');
    expect(stuck.refusal?.message).toContain(other);
  });

  it('Copilot saying it did not take the role stops the session, and nothing says applied', async () => {
    setSystemRoleDefault(db, 'copilot', roleId);
    pane.screen = '✗ Custom agent "cm-role-x" not found';
    const instance = tool('copilot');
    await expect(instance.startSession(WT, worktreePath)).rejects.toSatisfy(
      (error) => readRoleLaunchRefusal(error) === 'not-applied'
    );
    expect(instance.killed).toBe(1);
    expect(records('copilot').launched).toBeNull();
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'copilot' })).toBeNull();
  });

  it('a live process is still reconnected to when the role cannot be applied', async () => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.exists = true;
    const instance = tool('antigravity');
    await expect(instance.startSession(WT, worktreePath)).resolves.toBeUndefined();
    expect(instance.lines).toEqual([]);
  });
});

describe('launched: only on the evidence the adapter has', () => {
  it('Claude and Codex: still there after the launch', async () => {
    for (const cliTool of ['claude', 'codex'] as const) {
      setSystemRoleDefault(db, cliTool, roleId);
      pane.exists = false;
      await tool(cliTool).startSession(WT, worktreePath);
      expect(records(cliTool).launched?.roleId, cliTool).toBe(roleId);
    }
  });

  it('a process that died during the launch is not launched', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const instance = tool('claude');
    const original = instance['launchSession'].bind(instance);
    instance['launchSession'] = async (...args: Parameters<typeof original>) => {
      await original(...args);
      pane.alive = false;
    };
    await instance.startSession(WT, worktreePath);
    expect(records('claude').requested).not.toBeNull();
    expect(records('claude').launched).toBeNull();
  });

  it('Command Code and a disabled-then-enabled Antigravity stay unknown: nothing confirms them', async () => {
    vi.stubEnv(AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, '1');
    for (const cliTool of ['command-code', 'antigravity'] as const) {
      setSystemRoleDefault(db, cliTool, roleId);
      pane.exists = false;
      await tool(cliTool).startSession(WT, worktreePath);
      expect(records(cliTool).requested, cliTool).not.toBeNull();
      expect(records(cliTool).launched, cliTool).toBeNull();
    }
  });

  // The shape 2.0.18 really answers: its sources, weakest first (measured, #4115).
  const v2Sources = (system: string) => [
    { type: 'document', path: '/h/.config/opencode/opencode.jsonc', info: { model: 'm', providers: {} } },
    { type: 'directory', path: '/h/.config/opencode' },
    { type: 'document', info: { agents: { build: { system } } } },
  ];

  it('V2: its server answering with exactly the file confirms; anything else stays unknown', async () => {
    setSystemRoleDefault(db, 'opencode-v2', roleId);
    const mismatch = tool('opencode-v2');
    mismatch.serverConfig = v2Sources('other text');
    await mismatch.startSession(WT, worktreePath);
    expect(records('opencode-v2').launched).toBeNull();

    const file = records('opencode-v2').requested?.artifactPath as string;
    pane.exists = false;
    const match = tool('opencode-v2');
    match.serverConfig = v2Sources(fs.readFileSync(file, 'utf8'));
    await match.startSession(WT, worktreePath);
    expect(records('opencode-v2').launched?.artifactPath).toBe(file);
  });

  it('V2: the strongest source decides, and another agent\'s text does not confirm', async () => {
    setSystemRoleDefault(db, 'opencode-v2', roleId);
    await tool('opencode-v2').startSession(WT, worktreePath);
    const file = records('opencode-v2').requested?.artifactPath as string;
    const text = fs.readFileSync(file, 'utf8');

    pane.exists = false;
    const overridden = tool('opencode-v2');
    overridden.serverConfig = [...v2Sources(text), { type: 'document', info: { agents: { build: { system: 'stronger' } } } }];
    await overridden.startSession(WT, worktreePath);
    expect(records('opencode-v2').launched).toBeNull();

    pane.exists = false;
    const otherAgent = tool('opencode-v2');
    otherAgent.serverConfig = [{ type: 'document', info: { agents: { plan: { system: text } } } }];
    await otherAgent.startSession(WT, worktreePath);
    expect(records('opencode-v2').launched).toBeNull();
  });

  it('V1: its server listing the path confirms', async () => {
    setSystemRoleDefault(db, 'opencode', roleId);
    const instance = tool('opencode');
    const line = instance;
    const original = line['launchSession'].bind(line);
    line['launchSession'] = async (...args: Parameters<typeof original>) => {
      await original(...args);
      line.serverConfig = { instructions: [records('opencode').requested?.artifactPath] };
    };
    await instance.startSession(WT, worktreePath);
    expect(records('opencode').launched).not.toBeNull();
  });

  it('reusing a process records nothing, and keeps what was known', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    await tool('claude').startSession(WT, worktreePath);
    const before = records('claude');
    const evidence = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });

    // The default moved, and the same process is reconnected to.
    const other = createAgentRole(db, { name: 'Other', body: 'other' }).id;
    setSystemRoleDefault(db, 'claude', other);
    const again = tool('claude');
    await again.startSession(WT, worktreePath);
    expect(again.lines).toEqual([]);
    expect(records('claude').launched?.id).toBe(before.launched?.id);
    expect(records('claude').requested?.id).toBe(before.requested?.id);
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' })).toEqual(evidence);
  });

  it('no role is recorded as no role, which is not the same as unknown', async () => {
    setSystemRoleDefault(db, 'gemini', roleId);
    await tool('claude').startSession(WT, worktreePath);
    const { launched } = records('claude');
    expect(launched).not.toBeNull();
    expect(launched?.injectionFingerprint).toBeNull();
    expect(launched?.noRoleReason).toBe('no-default');
  });

  it('Codex replacing its process inside one launch: same role, and launched names the last generation', async () => {
    setSystemRoleDefault(db, 'codex', roleId);
    const instance = tool('codex');
    instance.relaunchOnce = true;
    await instance.startSession(WT, worktreePath);
    expect(instance.lines).toHaveLength(2);
    expect(instance.lines[1]).toBe(instance.lines[0]);
    const { requested, launched } = records('codex');
    const evidence = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'codex' });
    expect(launched?.sessionGeneration).toBe(evidence?.sessionGeneration);
    expect(requested?.sessionGeneration).toBe(evidence?.sessionGeneration);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM agent_role_launch_records WHERE phase = ?').get('requested') as { n: number };
    expect(rows.n).toBe(2);
  });

  it('a worktree id change moves what is known with the renamed session', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    await tool('claude').startSession(WT, worktreePath);
    const evidence = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });
    moveLaunchRoleEvidence([{ oldId: WT, newId: 'wt-renamed' }]);
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' })).toBeNull();
    expect(getLaunchRoleEvidence({ worktreeId: 'wt-renamed', cliToolId: 'claude' })).toEqual(evidence);
  });
});

describe('the automatic relaunch and concurrent starts', () => {
  it('a driver\'s relaunch goes through the same entry, and resolves the latest default', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const instance = tool('claude');
    await instance.startSession(WT, worktreePath);
    const first = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });

    const other = createAgentRole(db, { name: 'Other', body: 'OTHER' }).id;
    setSystemRoleDefault(db, 'claude', other);
    pane.alive = false;
    await instance.relaunch(WT);

    const second = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });
    expect(second?.sessionGeneration).not.toBe(first?.sessionGeneration);
    expect(second?.injectionFingerprint).not.toBe(first?.injectionFingerprint);
    expect(records('claude').requested?.roleId).toBe(other);
    expect(instance.lines).toHaveLength(2);
    expect(instance.lines[1]).not.toBe(instance.lines[0]);
  });

  it('a start asking for another role while one is in progress fails with nothing typed', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const firstTool = tool('claude');
    let release!: () => void;
    firstTool.gate = new Promise((resolve) => (release = resolve));
    const first = firstTool.startSession(WT, worktreePath);
    // Until its launch line is built.
    await vi.waitFor(() => expect(records('claude').requested).not.toBeNull());

    // The default changes while the launch is running: the new start resolves the new one.
    const other = createAgentRole(db, { name: 'Other', body: 'OTHER' }).id;
    setSystemRoleDefault(db, 'claude', other);
    const secondTool = tool('claude');
    const failure = await secondTool.startSession(WT, worktreePath).catch((error: unknown) => error);
    expect(isSessionLaunchRoleMismatchError(failure)).toBe(true);
    expect(secondTool.lines).toEqual([]);

    release();
    await first;
    // And the first kept what it resolved.
    expect(records('claude').requested?.roleId).toBe(roleId);
    expect(firstTool.lines).toHaveLength(1);
  });

  it('the same role through another name joins: it is the same injection', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const firstTool = tool('claude');
    let release!: () => void;
    firstTool.gate = new Promise((resolve) => (release = resolve));
    const first = firstTool.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(records('claude').requested).not.toBeNull());

    const twin = createAgentRole(db, { name: 'Twin', body: BODY }).id;
    setSystemRoleDefault(db, 'claude', twin);
    const logged = vi.spyOn(console, 'log');
    const secondTool = tool('claude');
    const second = secondTool.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(logged.mock.calls.flat().join('\n')).toContain('session-launch-joined'));
    logged.mockRestore();
    release();
    await Promise.all([first, second]);
    expect(firstTool.launches).toBe(1);
    expect(secondTool.launches).toBe(0);
  });

  it('two servers generating at once: one database, one file; another database, another file', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const input = { worktreeId: WT, cliToolId: 'claude' as const, worktreePath, readEnv: fixedEnvReader({}) };
    const { prepareRoleLaunch } = await import('@/lib/session/role-launch');
    const [a, b] = await Promise.all([resolveLaunchRole(db, input), resolveLaunchRole(db, input)]);
    const results = [prepareRoleLaunch(a), prepareRoleLaunch(b)];
    expect(results[0]?.artifact.path).toBe(results[1]?.artifact.path);
    expect(results[1]?.artifact.reused).toBe(true);

    const otherDbFile = path.join(dir, 'other.db');
    const otherDb = new Database(otherDbFile);
    try {
      runMigrations(otherDb);
      otherDb
        .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`)
        .run(WT, WT, worktreePath, rootPath);
      const shared = createAgentRole(otherDb, { name: 'Marketer', body: BODY });
      setSystemRoleDefault(otherDb, 'claude', shared.id);
      const c = await resolveLaunchRole(otherDb, input);
      expect(prepareRoleLaunch(c)?.artifact.path).not.toBe(results[0]?.artifact.path);
    } finally {
      otherDb.close();
    }
  });
});

describe('the home a profile is looked for in', () => {
  it.each([
    ['codex', 'CODEX_HOME', 'codex'],
    ['copilot', 'COPILOT_HOME', 'copilot'],
  ] as const)('%s with hooks off: the line names the home the file was written to', async (cliTool, name, sub) => {
    setSystemRoleDefault(db, cliTool, roleId);
    const instance = tool(cliTool);
    await instance.startSession(WT, worktreePath);
    expect(instance.lines[0]).toContain(`${name}='${path.join(dir, sub)}'`);
    expect(records(cliTool).requested?.artifactPath?.startsWith(path.join(dir, sub))).toBe(true);
  });

  it.each(['codex', 'copilot'] as const)('%s with no role: the line stays what it was', async (cliTool) => {
    setSystemRoleDefault(db, 'gemini', roleId);
    const instance = tool(cliTool);
    await instance.startSession(WT, worktreePath);
    expect(instance.lines[0]).not.toMatch(/CODEX_HOME|COPILOT_HOME/);
  });
});

describe('a launch killed midway, and the one started after it', () => {
  /** What the kill route does for a session. */
  function kill(cliTool: CLIToolType): void {
    forgetLaunchRoleEvidence({ worktreeId: WT, cliToolId: cliTool });
    clearSessionStarting(WT, cliTool);
    pane.exists = false;
  }

  it('its wait ending on the successor\'s screen writes nothing about the successor', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const old = tool('claude');
    let release!: () => void;
    old.gate = new Promise((resolve) => (release = resolve));
    const oldStart = old.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(records('claude').requested).not.toBeNull());
    const oldGeneration = records('claude').requested?.sessionGeneration;

    kill('claude');
    await tool('claude').startSession(WT, worktreePath);
    const successor = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });
    expect(successor?.sessionGeneration).not.toBe(oldGeneration);
    const launched = records('claude').launched;
    expect(launched?.sessionGeneration).toBe(successor?.sessionGeneration);

    release();
    await oldStart;
    expect(records('claude').launched?.id).toBe(launched?.id);
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' })).toEqual(successor);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM agent_role_launch_records WHERE phase = 'launched'`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('killed while its evidence was being read: the answer is not taken', async () => {
    setSystemRoleDefault(db, 'opencode', roleId);
    const old = tool('opencode');
    let answer!: (config: unknown) => void;
    old['readServerConfig'] = () => new Promise((resolve) => (answer = resolve));
    const oldStart = old.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(answer).toBeDefined());
    const file = records('opencode').requested?.artifactPath;

    kill('opencode');
    answer({ instructions: [file] });
    await oldStart;
    expect(records('opencode').launched).toBeNull();
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'opencode' })).toBeNull();
  });

  it('killed before its line was built: it opens nothing over the successor', async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    const old = tool('claude');
    let proceed!: () => void;
    const before = new Promise<void>((resolve) => (proceed = resolve));
    const original = old['launchSession'].bind(old);
    old['launchSession'] = async (...args: Parameters<typeof original>) => {
      await before;
      pane.exists = false;
      await original(...args);
    };
    const oldStart = old.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(old.launches).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    kill('claude');
    await tool('claude').startSession(WT, worktreePath);
    const successor = getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' });
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_role_launch_records').get() as { n: number }).n;
    const rowsBefore = count();

    proceed();
    await oldStart;
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'claude' })).toEqual(successor);
    expect(count()).toBe(rowsBefore);
  });

  it('Copilot: an old launch reading `✗` does not stop the successor', async () => {
    setSystemRoleDefault(db, 'copilot', roleId);
    const old = tool('copilot');
    let release!: () => void;
    old.gate = new Promise((resolve) => (release = resolve));
    const oldStart = old.startSession(WT, worktreePath);
    await vi.waitFor(() => expect(records('copilot').requested).not.toBeNull());

    kill('copilot');
    await tool('copilot').startSession(WT, worktreePath);
    pane.screen = '✗ Custom agent "cm-role-x" not found';
    release();
    await expect(oldStart).resolves.toBeUndefined();
    expect(old.killed).toBe(0);
    expect(getLaunchRoleEvidence({ worktreeId: WT, cliToolId: 'copilot' })).not.toBeNull();
  });
});

describe('OpenCode V1 continuing a conversation under another role', () => {
  /** What the driver does when it passes `-s`. */
  class ResumingTool extends TestTool {
    protected async launchSession(worktreeId: string, worktreePath_: string, instanceId?: string): Promise<void> {
      await super.launchSession(worktreeId, worktreePath_, instanceId);
      noteLaunchResumedConversation({ worktreeId, cliToolId: this.id, instanceId });
    }
  }
  const target = { worktreeId: WT, cliToolId: 'opencode' as const };
  const start = () => new ResumingTool('opencode', worktreePath).startSession(WT, worktreePath);

  it('the same role resuming: nothing to say', async () => {
    setSystemRoleDefault(db, 'opencode', roleId);
    await start();
    pane.exists = false;
    await start();
    expect(wasResumedAcrossRole(target)).toBe(false);
    expect(takeResumedAcrossRoleNotice(target)).toBe(false);
  });

  it('the default moved from A to B: said once to a send, and stays readable', async () => {
    setSystemRoleDefault(db, 'opencode', roleId);
    await start();
    setSystemRoleDefault(db, 'opencode', createAgentRole(db, { name: 'Other', body: 'OTHER' }).id);
    pane.exists = false;
    await start();
    expect(wasResumedAcrossRole(target)).toBe(true);
    expect(takeResumedAcrossRoleNotice(target)).toBe(true);
    expect(takeResumedAcrossRoleNotice(target)).toBe(false);
    expect(wasResumedAcrossRole(target)).toBe(true);
  });

  it('a driver relaunching on its own goes through it too', async () => {
    setSystemRoleDefault(db, 'opencode', roleId);
    const instance = new ResumingTool('opencode', worktreePath);
    await instance.startSession(WT, worktreePath);
    setSystemRoleDefault(db, 'opencode', null);
    pane.alive = false;
    await instance.relaunch(WT);
    expect(wasResumedAcrossRole(target)).toBe(true);
  });

  it('no record of any role before, and none now: nothing to say', async () => {
    setSystemRoleDefault(db, 'gemini', roleId);
    await start();
    expect(wasResumedAcrossRole(target)).toBe(false);
  });

  it('the real driver says so at the line that passes `-s`', () => {
    const source = fs.readFileSync('src/lib/cli-tools/opencode.ts', 'utf8');
    const note = source.indexOf('noteLaunchResumedConversation(target)');
    expect(note).toBeGreaterThan(source.indexOf('recoverOpencodeSessionId(target, worktreePath)'));
    expect(note).toBeGreaterThan(source.indexOf('if (resumeSessionId !== null) {'));
  });
});

describe('a contract, fixed at the start (INIT)', () => {
  const target = { worktreeId: WT, cliToolId: 'claude' as const };

  beforeEach(async () => {
    setSystemRoleDefault(db, 'claude', roleId);
    await tool('claude').startSession(WT, worktreePath);
  });

  it('nothing changed: it may go', async () => {
    await expect(runningRoleProblem(db, target, worktreePath)).resolves.toBeNull();
  });

  it('the default changed in between: it does not', async () => {
    const other = createAgentRole(db, { name: 'Other', body: 'OTHER' }).id;
    setSystemRoleDefault(db, 'claude', other);
    await expect(runningRoleProblem(db, target, worktreePath)).resolves.toMatch(/contract was not sent/);
  });

  it('the body was edited in between: it does not', async () => {
    updateAgentRole(db, roleId, { body: 'EDITED' });
    await expect(runningRoleProblem(db, target, worktreePath)).resolves.toMatch(/contract was not sent/);
  });

  it('renamed, or the same text from another level: it may', async () => {
    updateAgentRole(db, roleId, { name: 'Renamed' });
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId });
    await expect(runningRoleProblem(db, target, worktreePath)).resolves.toBeNull();
  });

  it('after a refusal-free restart with no evidence there is nothing to compare', async () => {
    resetLaunchRoleStateForTest();
    setLaunchRoleDatabaseForTest(db);
    await expect(runningRoleProblem(db, target, worktreePath)).resolves.toBeNull();
  });
});

it('RoleLaunchRefusedError keeps its reason through a driver\'s wrap', () => {
  const inner = new RoleLaunchRefusedError('artifact-failed', 'nope');
  const wrapped = new Error(`Failed to start Codex session: ${inner.message}`);
  expect(readRoleLaunchRefusal(wrapped)).toBe('artifact-failed');
  expect(readRoleLaunchRefusal(new Error('something else'))).toBeNull();
});
