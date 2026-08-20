/**
 * The config files CommandMate writes for gemini and antigravity, and the
 * promise that writing either one does not destroy the other (Issue #1762).
 *
 * gemini and antigravity share `~/.gemini`. On a machine with both installed it
 * holds gemini's `settings.json` and OAuth credentials, antigravity's
 * `config/hooks.json`, and antigravity's own state under `antigravity/` and
 * `antigravity-cli/` — so "write the config file" has a blast radius here that
 * it does not have for Claude or codex, and every way of getting it wrong is
 * silent. The acceptance criterion Issue #1762 states is therefore two-directional
 * and is the middle section of this file: **injecting gemini leaves
 * antigravity's configuration intact, and injecting antigravity leaves
 * gemini's.**
 *
 * Everything happens inside a temporary `HOME`. `os.homedir()` reads `$HOME` on
 * POSIX, which is what makes that possible without stubbing a module — and
 * without it this suite would rewrite the developer's own agy configuration.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  ANTIGRAVITY_HOOK_NAME,
  buildAntigravityHookConfig,
  getAntigravityHooksConfigPath,
  mergeAntigravityHooksConfig,
  writeAntigravityHooksConfig,
  buildAntigravityLaunchCommand,
} from '@/lib/hooks/sources/antigravity/hooks-config';
import {
  buildGeminiHookGroups,
  buildGeminiLaunchCommand,
  GEMINI_HOOK_TIMEOUT_MS,
  getGeminiSettingsPath,
  mergeGeminiHookSettings,
  writeGeminiHookSettings,
  type GeminiHookMatcherGroup,
} from '@/lib/hooks/sources/gemini/settings-generator';
import { renderAgentLaunchCommand } from '@/lib/hooks/sources';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { geminiAgentEventSource, prepareGeminiLaunch } from '@/lib/hooks/sources/gemini/source';

const WT = 'wt-1762';
const RELAY = '/opt/commandmate/scripts/hooks/cmate-agent-event.sh';

const dirs: string[] = [];
let home: string;
let worktree: string;

/** A private HOME, so `~/.gemini` is this test's and not the developer's. */
function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * The `~/.gemini` tree of somebody who already uses both tools.
 *
 * Every file here is content CommandMate has never seen and must not lose.
 */
function seedSharedTree(root: string): {
  geminiUserSettings: string;
  agyHooks: string;
  agyCliSettings: string;
} {
  mkdirSync(join(root, '.gemini', 'config'), { recursive: true });
  mkdirSync(join(root, '.gemini', 'antigravity-cli'), { recursive: true });

  const geminiUserSettings = join(root, '.gemini', 'settings.json');
  writeFileSync(
    geminiUserSettings,
    `${JSON.stringify(
      {
        security: { auth: { selectedType: 'oauth-personal' } },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] },
      },
      null,
      2
    )}\n`
  );

  const agyHooks = join(root, '.gemini', 'config', 'hooks.json');
  writeFileSync(
    agyHooks,
    `${JSON.stringify(
      {
        'lint-checker': {
          PostToolUse: [
            { matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh' }] },
          ],
        },
      },
      null,
      2
    )}\n`
  );

  const agyCliSettings = join(root, '.gemini', 'antigravity-cli', 'settings.json');
  writeFileSync(agyCliSettings, `${JSON.stringify({ trustedWorkspaces: ['/somewhere'] }, null, 2)}\n`);

  return { geminiUserSettings, agyHooks, agyCliSettings };
}

beforeEach(() => {
  home = makeTempDir('cmate-1762-home-');
  worktree = makeTempDir('cmate-1762-wt-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTempDir(dir);
  }
});

// ===========================================================================
// gemini — <worktree>/.gemini/settings.json
// ===========================================================================

describe('gemini settings.json', () => {
  it('registers the five events with a consumer, and no others', () => {
    const groups = buildGeminiHookGroups(RELAY, { worktreeId: WT });

    expect(Object.keys(groups)).toEqual([
      'SessionStart',
      'BeforeAgent',
      'AfterAgent',
      'Notification',
      'SessionEnd',
    ]);
    // Mapped by the source but deliberately not registered: gemini runs hooks
    // synchronously, so these would be two blocking round trips per tool call
    // for a `running` that `BeforeAgent` has already established.
    expect(groups.BeforeTool).toBeUndefined();
    expect(groups.AfterTool).toBeUndefined();
  });

  it('bakes the correlation key and the event word into every command', () => {
    // Mutation 2 for the config half: change one `--event` word here and this
    // row goes red. The relay has no other way to learn either value — gemini's
    // payload names the event, but `--event` is what a *hand*-checked config
    // reads back, and `--worktree-id` is the only thing that survives an
    // environment that does not reach the hook.
    const groups = buildGeminiHookGroups(RELAY, { worktreeId: WT });
    const commandOf = (event: string) => groups[event][0].hooks[0].command;

    expect(commandOf('SessionStart')).toContain('--event session_start');
    expect(commandOf('BeforeAgent')).toContain('--event user_prompt_submit');
    expect(commandOf('AfterAgent')).toContain('--event stop');
    expect(commandOf('Notification')).toContain('--event notification');
    expect(commandOf('SessionEnd')).toContain('--event session_end');

    for (const event of Object.keys(groups)) {
      expect(commandOf(event), event).toContain(`--tool gemini`);
      expect(commandOf(event), event).toContain(`--worktree-id '${WT}'`);
      expect(commandOf(event), event).toContain('--stdin-json');
      // #1757 R7: `type:"http"` is Claude's alone. The relay is the only
      // delivery mechanism gemini has.
      expect(groups[event][0].hooks[0].type).toBe('command');
    }
  });

  it('states the handler timeout in MILLISECONDS, which is gemini’s unit alone', () => {
    // Found by running it. `timeout: 5` — the seconds figure every other tool
    // takes, and what #1757 §8.2 R13 recorded as "the unit is seconds
    // everywhere" — produced this against a live v0.55.1 session:
    //
    //   Hook execution error: Hook timed out after 5ms
    //   Hook execution for SessionStart: 0 succeeded, 1 failed …
    //
    // The hooks were registered, disclosed in the banner and executed, and were
    // killed before curl could open a socket. Every event was lost while the
    // configuration looked entirely correct. The bundle agrees:
    // `DEFAULT_HOOK_TIMEOUT = 6e4` and the message is `… after ${timeout}ms`.
    //
    // Reverting this to `HOOK_TIMEOUT_SECONDS` is the mutation that reproduces
    // a silent, total loss of gemini events, so it is asserted as a number.
    expect(GEMINI_HOOK_TIMEOUT_MS).toBe(5000);
    const groups = buildGeminiHookGroups(RELAY, { worktreeId: WT });
    for (const event of Object.keys(groups)) {
      expect(groups[event][0].hooks[0].timeout, event).toBe(5000);
    }
  });

  it('never carries the instance id, because one file serves every instance', () => {
    // `gemini` and `gemini-2` share `<worktree>/.gemini/settings.json`. An
    // instance written into it would label both sessions with whichever started
    // last, which is a misattributed approval waiting to happen.
    const primary = buildGeminiHookGroups(RELAY, { worktreeId: WT, instanceId: 'gemini' });
    const second = buildGeminiHookGroups(RELAY, { worktreeId: WT, instanceId: 'gemini-2' });
    expect(second).toEqual(primary);
    expect(JSON.stringify(primary)).not.toContain('gemini-2');
  });

  it('writes into the worktree and merges rather than replaces', () => {
    const settingsPath = getGeminiSettingsPath(worktree);
    mkdirSync(join(worktree, '.gemini'), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          model: 'gemini-3-pro',
          contextFileName: 'GEMINI.md',
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'team-hook.sh' }] }],
            BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'audit.sh' }] }],
          },
        },
        null,
        2
      )}\n`
    );

    expect(writeGeminiHookSettings(worktree, { worktreeId: WT })).toBe(settingsPath);

    const written = readJson(settingsPath);
    // Every unrelated key survives.
    expect(written.model).toBe('gemini-3-pro');
    expect(written.contextFileName).toBe('GEMINI.md');
    // The team's own hooks survive, including on an event CommandMate registers…
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe('team-hook.sh');
    // …and on one it does not.
    expect(written.hooks.BeforeTool).toEqual([
      { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'audit.sh' }] },
    ]);
    // And ours is appended after theirs.
    expect(written.hooks.SessionStart).toHaveLength(2);
    expect(written.hooks.SessionStart[1].hooks[0].command).toContain('--event session_start');
  });

  it('is idempotent: relaunching does not accumulate handlers', () => {
    writeGeminiHookSettings(worktree, { worktreeId: WT });
    const first = readFileSync(getGeminiSettingsPath(worktree), 'utf8');

    writeGeminiHookSettings(worktree, { worktreeId: WT });
    writeGeminiHookSettings(worktree, { worktreeId: WT });

    expect(readFileSync(getGeminiSettingsPath(worktree), 'utf8')).toBe(first);
    expect(readJson(getGeminiSettingsPath(worktree)).hooks.SessionStart).toHaveLength(1);
  });

  it('leaves another worktree’s CommandMate hooks alone', () => {
    // Two CommandMate servers, or a worktree re-registered under a new id. Ours
    // is identified by all three of relay, tool and *this* worktree id, so an
    // entry naming a different worktree is somebody else's and is kept.
    const settingsPath = getGeminiSettingsPath(worktree);
    writeGeminiHookSettings(worktree, { worktreeId: 'wt-other' });
    writeGeminiHookSettings(worktree, { worktreeId: WT });

    const commands = readJson(settingsPath).hooks.SessionStart.map(
      (group: GeminiHookMatcherGroup) => group.hooks[0].command
    );
    expect(commands).toHaveLength(2);
    expect(commands.some((c: string) => c.includes(`--worktree-id 'wt-other'`))).toBe(true);
    expect(commands.some((c: string) => c.includes(`--worktree-id '${WT}'`))).toBe(true);
  });

  it('preserves a hand-edited hooks value that is not even an array', () => {
    const settingsPath = getGeminiSettingsPath(worktree);
    mkdirSync(join(worktree, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ hooks: { PreCompress: 'nonsense' } })}\n`);

    writeGeminiHookSettings(worktree, { worktreeId: WT });

    expect(readJson(settingsPath).hooks.PreCompress).toBe('nonsense');
  });

  it('merges into nothing when there is no file yet', () => {
    const merged = mergeGeminiHookSettings(null, buildGeminiHookGroups(RELAY, { worktreeId: WT }), WT);
    expect(Object.keys(merged)).toEqual(['hooks']);
  });

  it('fails open when the worktree cannot be written to', () => {
    // A path whose parent is a regular file: every OS answers ENOTDIR
    // immediately. (Never a `/proc` path — see
    // tests/unit/guards/no-procfs-env-fixtures.test.ts.)
    const blocker = join(worktree, 'not-a-dir');
    writeFileSync(blocker, 'x');
    expect(writeGeminiHookSettings(join(blocker, 'nested'), { worktreeId: WT })).toBeNull();
  });
});

// ===========================================================================
// antigravity — ~/.gemini/config/hooks.json
// ===========================================================================

describe('antigravity hooks.json', () => {
  it('is the one global file agy reads', () => {
    expect(getAntigravityHooksConfigPath()).toBe(join(home, '.gemini', 'config', 'hooks.json'));
  });

  it('puts SessionStart, PostToolUse and Stop on the relay — and never PreToolUse', () => {
    // Was `expect(Object.keys(config)).toEqual([…three…])` +
    // `expect(config.PreToolUse).toBeUndefined()` until Issue #1779, which
    // registered `PreToolUse` against its own receiver. The claim underneath
    // both assertions is unchanged and is what is asserted here instead: **the
    // relay must never be the thing answering `PreToolUse`**, because
    // `cmate-agent-event.sh` ends in `curl … >/dev/null` and cannot return a
    // verdict at all. What changed is that there is now a second command that
    // can. See `antigravity-permission-1779.test.ts`, which runs it.
    const config = buildAntigravityHookConfig(RELAY);

    expect(Object.keys(config)).toEqual(['SessionStart', 'PostToolUse', 'Stop', 'PreToolUse']);

    const preToolUse = JSON.stringify(config.PreToolUse);
    expect(preToolUse).not.toContain(RELAY);
    expect(preToolUse).not.toContain('cmate-agent-event.sh');
  });

  it('bakes the event word into every command, because the payload cannot carry it', () => {
    // Mutation 2 for antigravity. There is no name table to break — an agy
    // payload has no event-name field at all — so the mapping *is* this
    // argument, and breaking one of these three words is what goes red.
    const config = buildAntigravityHookConfig(RELAY);

    expect((config.SessionStart as { command: string }[])[0].command).toContain(
      '--event session_start'
    );
    expect(
      (config.PostToolUse as { hooks: { command: string }[] }[])[0].hooks[0].command
    ).toContain('--event post_tool_use');
    expect((config.Stop as { command: string }[])[0].command).toContain('--event stop');
  });

  it('states the handler timeout in SECONDS, unlike gemini', () => {
    // agy's bundled `hooks.md`: "timeout (int, optional): Execution timeout in
    // seconds. Defaults to 30." Verified live — a `timeout: 5` handler delivered
    // `session_start`, `post_tool_use` and `stop` without being killed, where
    // the same number in gemini's file meant 5 milliseconds. The two tools share
    // a config *tree* and do not share this unit.
    const config = buildAntigravityHookConfig(RELAY);
    expect((config.SessionStart as { timeout: number }[])[0].timeout).toBe(5);
    expect((config.PostToolUse as { hooks: { timeout: number }[] }[])[0].hooks[0].timeout).toBe(5);
  });

  it('uses agy’s grouped shape for tool events and its flat shape for the rest', () => {
    const config = buildAntigravityHookConfig(RELAY);
    expect((config.PostToolUse as { matcher: string }[])[0].matcher).toBe('*');
    expect((config.SessionStart as { type: string }[])[0].type).toBe('command');
    expect(config.Stop as unknown as Array<Record<string, unknown>>).toEqual([
      expect.objectContaining({ type: 'command' }),
    ]);
  });

  it('carries no worktree or instance, because one file serves the whole machine', () => {
    // The correlation lives in `CM_HOOK_URL` instead — see the launch commands
    // below. A key written here would be wrong for every session but one.
    const serialised = JSON.stringify(buildAntigravityHookConfig(RELAY));
    expect(serialised).not.toContain('--worktree-id');
    expect(serialised).not.toContain('--instance-id');
    expect(serialised).not.toContain('--url');
  });

  it('occupies exactly one named hook and leaves the others alone', () => {
    const { agyHooks } = seedSharedTree(home);

    expect(writeAntigravityHooksConfig()).toBe(agyHooks);

    const written = readJson(agyHooks);
    expect(written['lint-checker']).toEqual({
      PostToolUse: [
        { matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh' }] },
      ],
    });
    expect(Object.keys(written)).toEqual(['lint-checker', ANTIGRAVITY_HOOK_NAME]);
  });

  it('is idempotent', () => {
    seedSharedTree(home);
    writeAntigravityHooksConfig();
    const first = readFileSync(getAntigravityHooksConfigPath(), 'utf8');
    writeAntigravityHooksConfig();
    expect(readFileSync(getAntigravityHooksConfigPath(), 'utf8')).toBe(first);
  });

  it('creates the file when the user has none', () => {
    expect(writeAntigravityHooksConfig()).toBe(getAntigravityHooksConfigPath());
    expect(Object.keys(readJson(getAntigravityHooksConfigPath()))).toEqual([ANTIGRAVITY_HOOK_NAME]);
  });

  it('replaces its own key rather than nesting into it', () => {
    const merged = mergeAntigravityHooksConfig(
      { [ANTIGRAVITY_HOOK_NAME]: { Stop: [{ type: 'command', command: 'stale', timeout: 5 }] } },
      buildAntigravityHookConfig(RELAY)
    );
    expect(JSON.stringify(merged)).not.toContain('stale');
  });
});

// ===========================================================================
// The shared tree, in both directions — the acceptance criterion
// ===========================================================================

describe('the shared ~/.gemini tree survives both injections', () => {
  it('injecting antigravity leaves gemini’s configuration byte-identical', () => {
    const { geminiUserSettings, agyCliSettings } = seedSharedTree(home);
    const before = { gemini: sha256(geminiUserSettings), agy: sha256(agyCliSettings) };

    writeAntigravityHooksConfig();

    expect(sha256(geminiUserSettings)).toBe(before.gemini);
    expect(sha256(agyCliSettings)).toBe(before.agy);
  });

  it('injecting gemini leaves antigravity’s configuration byte-identical', () => {
    const { agyHooks, agyCliSettings } = seedSharedTree(home);
    writeAntigravityHooksConfig();
    const before = { hooks: sha256(agyHooks), cli: sha256(agyCliSettings) };

    // The worst case for the collision: a worktree whose own `.gemini` directory
    // *is* the shared tree. Nothing about gemini's generator may reach outside
    // `<worktree>/.gemini/settings.json`, and this is what proves it — a
    // generator that wrote `config/hooks.json`, or that rewrote the directory,
    // would take antigravity out here and nowhere else.
    expect(writeGeminiHookSettings(home, { worktreeId: WT })).toBe(
      join(home, '.gemini', 'settings.json')
    );

    expect(sha256(agyHooks)).toBe(before.hooks);
    expect(sha256(agyCliSettings)).toBe(before.cli);
  });

  it('and the user’s own gemini settings survive that same write', () => {
    const { geminiUserSettings } = seedSharedTree(home);

    writeGeminiHookSettings(home, { worktreeId: WT });

    const written = readJson(geminiUserSettings);
    expect(written.security).toEqual({ auth: { selectedType: 'oauth-personal' } });
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe('my-own-hook.sh');
  });

  it('interleaved injections converge instead of fighting', () => {
    const { geminiUserSettings, agyHooks } = seedSharedTree(home);

    writeGeminiHookSettings(home, { worktreeId: WT });
    writeAntigravityHooksConfig();
    writeGeminiHookSettings(home, { worktreeId: 'wt-second' });
    writeAntigravityHooksConfig();

    expect(readJson(agyHooks)['lint-checker']).toBeDefined();
    expect(readJson(agyHooks)[ANTIGRAVITY_HOOK_NAME]).toBeDefined();
    expect(readJson(geminiUserSettings).hooks.SessionStart).toHaveLength(3);
    expect(readJson(geminiUserSettings).security).toBeDefined();
  });
});

// ===========================================================================
// Launch commands and the rollback switch
// ===========================================================================

describe('launch commands', () => {
  const URL_RE = (tool: string, instance: string) =>
    new RegExp(
      `^CM_HOOK_URL='http://127\\.0\\.0\\.1:\\d+/api/hooks/agent-event\\?tool=${tool}` +
        `&worktreeId=${WT}&instanceId=${instance}' `
    );

  it('carries the instance for gemini, which the settings file cannot', () => {
    const plan = buildGeminiLaunchCommand('gemini', { worktreeId: WT, instanceId: 'gemini-2' });
    // #1846: the variable is declared data now, not a prefix baked into the
    // command — and the rendered line is what it always was.
    expect(Object.keys(plan.env)).toEqual(['CM_HOOK_URL']);
    expect(plan.command).toBe(`'gemini'`);
    const rendered = renderAgentLaunchCommand({ ...plan, settingsPath: null });
    expect(rendered).toMatch(URL_RE('gemini', 'gemini-2'));
    expect(rendered.endsWith(` 'gemini'`)).toBe(true);
  });

  it('carries the worktree AND instance for antigravity, which has nowhere else to put them', () => {
    const plan = buildAntigravityLaunchCommand('agy', {
      worktreeId: WT,
      instanceId: 'antigravity',
    });
    expect(Object.keys(plan.env)).toEqual(['CM_HOOK_URL', 'CM_PERMISSION_HOOK_URL']);
    expect(plan.command).toBe(`'agy'`);
    const rendered = renderAgentLaunchCommand({ ...plan, settingsPath: null });
    expect(rendered).toMatch(URL_RE('antigravity', 'antigravity'));
    expect(rendered.endsWith(` 'agy'`)).toBe(true);
  });

  it('leaves room for the caller’s own flags after the executable', () => {
    // `AntigravityTool.startSession` appends `--model`, so the env prefix has to
    // stay in front and the executable has to be the last token.
    const base = renderAgentLaunchCommand({
      ...buildAntigravityLaunchCommand('agy', { worktreeId: WT }),
      settingsPath: null,
    });
    expect(`${base} --model 'Gemini 3.1 Pro (High)'`).toMatch(/'agy' --model 'Gemini 3\.1 Pro \(High\)'$/);
  });

  it('keeps shell syntax out of `command` on every source that needs an env', () => {
    // The #1846 invariant, asserted rather than described: a `NAME=value`
    // prefix inside `command` is invisible to a launcher that is not a shell,
    // and four sources had written one. Nothing may put one back.
    const plans = [
      buildGeminiLaunchCommand('gemini', { worktreeId: WT }),
      buildAntigravityLaunchCommand('agy', { worktreeId: WT }),
    ];
    for (const plan of plans) {
      expect(plan.command).not.toMatch(/^[A-Z_][A-Z0-9_]*=/);
      expect(Object.keys(plan.env).length).toBeGreaterThan(0);
    }
  });

  it('refuses to inject an instance id the receiver would reject', () => {
    const bad = { worktreeId: WT, instanceId: '../../etc/passwd' };
    expect(buildGeminiLaunchCommand('gemini', bad)).toEqual({ command: 'gemini', env: {} });
    expect(buildAntigravityLaunchCommand('agy', bad)).toEqual({ command: 'agy', env: {} });
  });
});

describe('CM_AGENT_HOOKS_INJECT=0', () => {
  beforeEach(() => vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0'));

  it('leaves the gemini launch command byte-identical to the pre-#1762 one', () => {
    expect(buildGeminiLaunchCommand('gemini', { worktreeId: WT, instanceId: 'gemini' })).toEqual({
      command: 'gemini',
      env: {},
    });
    expect(
      geminiAgentEventSource.prepareLaunch({
        target: { worktreeId: WT, cliToolId: 'gemini', instanceId: 'gemini' },
        executablePath: 'gemini',
        worktreePath: worktree,
      })
    ).toEqual({ command: 'gemini', settingsPath: null, env: {} });
  });

  it('leaves the antigravity launch command byte-identical to the pre-#1762 one', () => {
    expect(buildAntigravityLaunchCommand('agy', { worktreeId: WT })).toEqual({
      command: 'agy',
      env: {},
    });
    expect(
      antigravityAgentEventSource.prepareLaunch({
        target: { worktreeId: WT, cliToolId: 'antigravity' },
        executablePath: 'agy',
        worktreePath: worktree,
      })
    ).toEqual({ command: 'agy', settingsPath: null, env: {} });
  });

  it('writes no file for either tool', () => {
    seedSharedTree(home);
    const { agyHooks, geminiUserSettings } = seedSharedTree(home);
    const before = { agy: sha256(agyHooks), gemini: sha256(geminiUserSettings) };

    expect(writeAntigravityHooksConfig()).toBeNull();
    expect(writeGeminiHookSettings(worktree, { worktreeId: WT })).toBeNull();
    expect(
      prepareGeminiLaunch({
        target: { worktreeId: WT, cliToolId: 'gemini' },
        executablePath: 'gemini',
        worktreePath: worktree,
      }).settingsPath
    ).toBeNull();

    expect(sha256(agyHooks)).toBe(before.agy);
    expect(sha256(geminiUserSettings)).toBe(before.gemini);
  });
});
