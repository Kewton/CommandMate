/**
 * Issue #3312: `CM_UAT_ISOLATION=own-home` — a run under a dedicated OS user
 * writes the agents' hook files, but only inside that user's own HOME.
 *
 * Positive controls (fail before this Issue, when `own-home` was an unknown
 * value and so meant "not isolated": the files were written wherever the
 * environment pointed and nothing was refused): a different user, a different
 * HOME, a `CODEX_HOME` / `CM_AGENT_HOOKS_DIR` outside the HOME and a symlink
 * leading out of it are refused, with nothing written; a failed preparation is
 * a refusal, never a bare launch.
 *
 * Negative controls: `1` still writes nothing, and unset still writes with no
 * user check at all.
 *
 * The "dedicated user" is the test's own uid under a made-up login name:
 * `os.userInfo()` is replaced, so the account's home directory is a temp dir
 * and nothing is written under the real HOME.
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
  symlinkSync,
  writeFileSync,
} from 'fs';
import os, { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  checkUatOwnHomeWriteTargets,
  getUatIsolationMode,
  isUatIsolationEnabled,
  sharedHookWritePolicy,
  UAT_DEDICATED_USER_ENV_VAR,
  UAT_ISOLATION_ENV_VAR,
  UatIsolationLaunchRefusedError,
} from '@/config/uat-isolation';
import {
  buildCodexLaunchPlan,
  getCodexHooksPath,
  shouldTrustCodexHooks,
  writeCodexHookSettings,
} from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_RELAY_INSTALL_BASENAME,
  getCodexRelayInstallPath,
  getCodexRelayStagingPath,
} from '@/lib/hooks/sources/codex/relay-install';
import { getHookSettingsPath } from '@/lib/hooks/hook-settings-generator';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import {
  buildCopilotLaunchCommand,
  COPILOT_LAUNCH_COMMAND,
  getCopilotSettingsPath,
  getCopilotSettingsTempPath,
} from '@/lib/hooks/sources/copilot/hook-settings';
import { buildCliArgs, uatIsolationHeadlessRefusal } from '@/lib/session/claude-executor';

const MANAGED_ENV = [
  UAT_ISOLATION_ENV_VAR,
  UAT_DEDICATED_USER_ENV_VAR,
  'CODEX_HOME',
  'COPILOT_HOME',
  'CM_AGENT_HOOKS_INJECT',
  'CM_AGENT_HOOKS_DIR',
  'CM_CODEX_HOOK_TRUST',
  'CM_PORT',
  'MCBD_PORT',
  'HOME',
] as const;

const DEDICATED = 'cmcheck-3312';
const RELAY_BODY = '#!/bin/sh\n# shipped relay\nexit 0\n';
const CODEX_TARGET = { worktreeId: 'wt-own-home', cliToolId: 'codex', instanceId: 'codex' } as const;

let saved: Record<string, string | undefined>;
let originalCwd: string;
let checkout: string;
let scratch: string;
let home: string;
let outside: string;

function launchContext(cliToolId: string) {
  return {
    target: { worktreeId: 'wt-own-home', cliToolId, instanceId: cliToolId },
    executablePath: `/opt/bin/${cliToolId}`,
    worktreePath: checkout,
  } as Parameters<typeof claudeAgentEventSource.prepareLaunch>[0];
}

beforeEach(() => {
  originalCwd = process.cwd();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];

  // The checkout whose relay this "build" ships (resolved against the cwd).
  checkout = realpathSync(mkdtempSync(join(tmpdir(), 'uat-3312-checkout-')));
  mkdirSync(join(checkout, 'scripts', 'hooks'), { recursive: true });
  const shipped = join(checkout, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);
  writeFileSync(shipped, RELAY_BODY);
  chmodSync(shipped, 0o755);
  process.chdir(checkout);

  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'uat-3312-scratch-')));
  home = join(scratch, 'home');
  outside = join(scratch, 'outside');
  mkdirSync(home);
  mkdirSync(outside);

  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  mkdirSync(process.env.CODEX_HOME);
  process.env.COPILOT_HOME = join(home, '.copilot');
  process.env.CM_AGENT_HOOKS_DIR = join(home, 'run', 'hooks');
  process.env.CM_PORT = '3017';
  process.env[UAT_DEDICATED_USER_ENV_VAR] = DEDICATED;

  vi.spyOn(os, 'userInfo').mockReturnValue({
    username: DEDICATED,
    uid: process.getuid!(),
    gid: process.getgid!(),
    shell: '/bin/zsh',
    homedir: home,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTempDir(checkout);
  removeTempDir(scratch);
});

function ownHome(): void {
  process.env[UAT_ISOLATION_ENV_VAR] = 'own-home';
}

describe('the mode', () => {
  it('own-home is isolated, distinct from 1, and any other value is not', () => {
    expect(getUatIsolationMode({ CM_UAT_ISOLATION: 'own-home' })).toBe('own-home');
    expect(getUatIsolationMode({ CM_UAT_ISOLATION: '1' })).toBe('shared-read-only');
    expect(getUatIsolationMode({})).toBe('off');
    expect(getUatIsolationMode({ CM_UAT_ISOLATION: 'OWN-HOME' })).toBe('off');
    expect(isUatIsolationEnabled({ CM_UAT_ISOLATION: 'own-home' })).toBe(true);
  });

  it('the one write rule: off writes, 1 reads, own-home writes only once the targets check out', () => {
    const target = [join(home, '.codex', 'hooks.json')];
    expect(sharedHookWritePolicy('codex', target, { HOME: home })).toBe('write');
    expect(sharedHookWritePolicy('codex', target, { CM_UAT_ISOLATION: '1', HOME: home })).toBe('read-only');
    expect(
      sharedHookWritePolicy('codex', target, {
        CM_UAT_ISOLATION: 'own-home',
        CM_UAT_DEDICATED_USER: DEDICATED,
        HOME: home,
      })
    ).toBe('write');
    expect(() =>
      sharedHookWritePolicy('codex', [join(outside, 'hooks.json')], {
        CM_UAT_ISOLATION: 'own-home',
        CM_UAT_DEDICATED_USER: DEDICATED,
        HOME: home,
      })
    ).toThrow(UatIsolationLaunchRefusedError);
  });
});

describe('checkUatOwnHomeWriteTargets: the check before the launch', () => {
  const env = () => ({ CM_UAT_DEDICATED_USER: DEDICATED, HOME: home });

  it('passes for existing and not-yet-created paths inside the HOME', () => {
    expect(checkUatOwnHomeWriteTargets([join(home, '.codex'), join(home, 'a', 'b', 'c.json')], env())).toBeNull();
  });

  it('refuses when the dedicated user is not named', () => {
    expect(checkUatOwnHomeWriteTargets([], { HOME: home })).toMatch(/CM_UAT_DEDICATED_USER is not set/);
  });

  it('refuses a different user', () => {
    expect(checkUatOwnHomeWriteTargets([], { ...env(), CM_UAT_DEDICATED_USER: 'someone-else' })).toMatch(
      new RegExp(`runs as ${DEDICATED}, not as the dedicated user someone-else`)
    );
  });

  it('refuses a HOME that is not the user\'s home directory', () => {
    expect(checkUatOwnHomeWriteTargets([], { ...env(), HOME: outside })).toMatch(/is not cmcheck-3312's home directory/);
  });

  it('refuses a HOME not owned by the user', () => {
    const identity = { username: DEDICATED, uid: process.getuid!() + 1, homedir: home };
    expect(checkUatOwnHomeWriteTargets([], env(), identity)).toMatch(/is not owned by/);
  });

  it('refuses a target outside the HOME', () => {
    expect(checkUatOwnHomeWriteTargets([join(outside, 'hooks.json')], env())).toMatch(/outside cmcheck-3312's HOME/);
  });

  it('refuses a symlink inside the HOME that leads out of it', () => {
    symlinkSync(outside, join(home, 'link'));
    expect(checkUatOwnHomeWriteTargets([join(home, 'link', 'hooks.json')], env())).toMatch(
      new RegExp(`resolves to ${outside}/hooks.json, outside`)
    );
  });

  it('refuses a dangling symlink (writing through it would create a file where it points)', () => {
    symlinkSync(join(outside, 'nowhere.json'), join(home, 'dangling.json'));
    expect(checkUatOwnHomeWriteTargets([join(home, 'dangling.json')], env())).toMatch(/points nowhere/);
  });

});

describe('codex under own-home', () => {
  it('writes hooks.json and the relay inside the HOME, pins the receiver to this server, and may grant trust', () => {
    ownHome();
    const plan = buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017, supportsNoDaemon: false });

    expect(plan.settingsPath).toBe(getCodexHooksPath());
    expect(existsSync(getCodexHooksPath())).toBe(true);
    expect(existsSync(getCodexRelayInstallPath(process.env.CODEX_HOME!))).toBe(true);
    expect(plan.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(plan.env.CM_HOOK_URL).toBe('http://127.0.0.1:3017/api/hooks/agent-event');
    expect(shouldTrustCodexHooks(checkout)).toBe(true);
  });

  it('refuses a different user and writes nothing', () => {
    ownHome();
    process.env[UAT_DEDICATED_USER_ENV_VAR] = 'someone-else';
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(
      /^CM_UAT_ISOLATION=own-home: refusing to start codex: this process runs as/
    );
    expect(readdirSync(process.env.CODEX_HOME!)).toEqual([]);
  });

  it('refuses a different HOME and writes nothing', () => {
    ownHome();
    process.env.HOME = outside;
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
    expect(readdirSync(process.env.CODEX_HOME!)).toEqual([]);
  });

  it('refuses a CODEX_HOME outside the HOME and writes nothing there', () => {
    ownHome();
    process.env.CODEX_HOME = outside;
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(/outside cmcheck-3312's HOME/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a CODEX_HOME that is a symlink out of the HOME and writes nothing there', () => {
    ownHome();
    const link = join(home, '.codex-link');
    symlinkSync(outside, link);
    process.env.CODEX_HOME = link;
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a hooks.json that is a symlink out of the HOME and leaves its target alone', () => {
    ownHome();
    const target = join(outside, 'hooks.json');
    writeFileSync(target, '{}\n');
    symlinkSync(target, join(process.env.CODEX_HOME!, 'hooks.json'));
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
    expect(readdirSync(outside)).toEqual(['hooks.json']);
  });

  it('a preparation that fails is a refused launch, not a bare codex', () => {
    ownHome();
    writeFileSync(getCodexHooksPath(), '{ not json');
    expect(writeCodexHookSettings()).toBeNull();
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);

    process.env.CM_AGENT_HOOKS_INJECT = '0';
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
  });

  it('negative control — 1: writes nothing and grants no trust, even as the right user', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    expect(writeCodexHookSettings()).toBeNull();
    expect(readdirSync(process.env.CODEX_HOME!)).toEqual([]);
    expect(shouldTrustCodexHooks(checkout)).toBe(false);
  });

  it('negative control — unset: writes, with no user check (a CODEX_HOME anywhere)', () => {
    delete process.env[UAT_DEDICATED_USER_ENV_VAR];
    process.env.CODEX_HOME = outside;
    const plan = buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017, supportsNoDaemon: false });
    expect(plan.settingsPath).toBe(join(outside, 'hooks.json'));
  });
});

describe('claude under own-home', () => {
  it('writes its settings file in CM_AGENT_HOOKS_DIR inside the HOME and keeps the user source dropped', () => {
    ownHome();
    const plan = claudeAgentEventSource.prepareLaunch(launchContext('claude'));
    expect(plan.settingsPath).not.toBeNull();
    expect(plan.settingsPath!.startsWith(`${process.env.CM_AGENT_HOOKS_DIR}/`)).toBe(true);
    expect(existsSync(plan.settingsPath!)).toBe(true);
    expect(plan.command).toContain('--settings');
    expect(plan.command.endsWith('--setting-sources project,local')).toBe(true);
  });

  it('refuses a different user, and a CM_AGENT_HOOKS_DIR outside the HOME, writing nothing', () => {
    ownHome();
    process.env[UAT_DEDICATED_USER_ENV_VAR] = 'someone-else';
    expect(() => claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toThrow(UatIsolationLaunchRefusedError);
    expect(existsSync(process.env.CM_AGENT_HOOKS_DIR!)).toBe(false);

    process.env[UAT_DEDICATED_USER_ENV_VAR] = DEDICATED;
    process.env.CM_AGENT_HOOKS_DIR = join(outside, 'hooks');
    expect(() => claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toThrow(/outside cmcheck-3312's HOME/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('negative control — 1: no user check for the run\'s own settings directory', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    process.env[UAT_DEDICATED_USER_ENV_VAR] = 'someone-else';
    const plan = claudeAgentEventSource.prepareLaunch(launchContext('claude'));
    expect(plan.settingsPath).not.toBeNull();
  });
});

describe('antigravity under own-home', () => {
  const configPath = () => join(home, '.gemini', 'config', 'hooks.json');

  it('writes ~/.gemini/config/hooks.json inside the HOME', () => {
    ownHome();
    const plan = antigravityAgentEventSource.prepareLaunch(launchContext('antigravity'));
    expect(plan.settingsPath).toBe(configPath());
    expect(existsSync(configPath())).toBe(true);
    expect(plan.env.CM_HOOK_URL).toContain(':3017/');
  });

  it('refuses a different user and writes nothing', () => {
    ownHome();
    process.env[UAT_DEDICATED_USER_ENV_VAR] = 'someone-else';
    expect(() => antigravityAgentEventSource.prepareLaunch(launchContext('antigravity'))).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(existsSync(configPath())).toBe(false);
  });

  it('a preparation that fails (no relay in this build) is a refused launch', () => {
    ownHome();
    process.chdir(scratch);
    expect(() => antigravityAgentEventSource.prepareLaunch(launchContext('antigravity'))).toThrow(
      /refusing to start antigravity: ~\/\.gemini\/config\/hooks\.json could not be prepared/
    );
  });

  it('negative control — 1: writes nothing', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    expect(() => antigravityAgentEventSource.prepareLaunch(launchContext('antigravity'))).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('copilot under own-home', () => {
  const target = { worktreeId: 'wt-own-home', cliToolId: 'copilot', instanceId: 'copilot' } as const;
  const options = { relayScriptPath: '/opt/commandmate/scripts/hooks/cmate-agent-event.sh' };

  it('writes ~/.copilot/settings.json inside the HOME', () => {
    ownHome();
    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, options);
    expect(plan.settingsPath).toBe(getCopilotSettingsPath());
    expect(existsSync(getCopilotSettingsPath())).toBe(true);
    expect(plan.env.CM_HOOK_PORT).toBe('3017');
  });

  it('refuses a COPILOT_HOME outside the HOME and writes nothing there', () => {
    ownHome();
    process.env.COPILOT_HOME = outside;
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, options)).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a hooks key in config.json is a refused launch, not a bare copilot', () => {
    ownHome();
    mkdirSync(process.env.COPILOT_HOME!, { recursive: true });
    writeFileSync(join(process.env.COPILOT_HOME!, 'config.json'), '{"hooks":{"Stop":[]}}\n');
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, options)).toThrow(
      /refusing to start copilot: .*config\.json has a "hooks" key/
    );
  });

  it('negative control — unset: the same config.json still starts copilot bare', () => {
    mkdirSync(process.env.COPILOT_HOME!, { recursive: true });
    writeFileSync(join(process.env.COPILOT_HOME!, 'config.json'), '{"hooks":{"Stop":[]}}\n');
    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, options);
    expect(plan).toEqual({ command: COPILOT_LAUNCH_COMMAND, settingsPath: null, env: {} });
  });
});

describe('what own-home keeps from 1', () => {
  it('refuses headless codex exec / agy -p and drops claude -p\'s user settings', () => {
    ownHome();
    expect(uatIsolationHeadlessRefusal('codex')).toMatch(/^CM_UAT_ISOLATION=own-home: refusing to start a headless codex run/);
    expect(uatIsolationHeadlessRefusal('antigravity')).not.toBeNull();
    expect(buildCliArgs('hi', 'claude').slice(-2)).toEqual(['--setting-sources', 'project,local']);
  });
});

// ---------------------------------------------------------------------------
// The review of PR #3405 (Issue #3312): write targets checked to the file that
// is really written (temp files included), temp files that never follow a
// planted symlink, a relay that could not be updated, and a claude settings
// file that could not be written.

describe('every file own-home writes is checked, temp files included', () => {
  const outsideFile = () => {
    const file = join(outside, 'victim');
    writeFileSync(file, 'keep\n');
    return file;
  };

  it('codex: a relay temp file that is a symlink out of the HOME refuses the launch and is not written through', () => {
    ownHome();
    const victim = outsideFile();
    const relay = getCodexRelayInstallPath(process.env.CODEX_HOME!);
    mkdirSync(join(relay, '..'), { recursive: true });
    symlinkSync(victim, getCodexRelayStagingPath(relay));
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(/cmate-agent-event\.sh\.tmp resolves to/);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  it('negative control — unset: the planted temp symlink is replaced, not written through, and the relay installs', () => {
    const victim = outsideFile();
    const relay = getCodexRelayInstallPath(process.env.CODEX_HOME!);
    mkdirSync(join(relay, '..'), { recursive: true });
    symlinkSync(victim, getCodexRelayStagingPath(relay));
    const plan = buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017, supportsNoDaemon: false });
    expect(plan.settingsPath).toBe(getCodexHooksPath());
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    expect(readFileSync(relay, 'utf8')).toBe(RELAY_BODY);
  });

  it('claude: a settings file that is a symlink out of the HOME refuses the launch', () => {
    ownHome();
    const victim = outsideFile();
    const settings = getHookSettingsPath({ worktreeId: 'wt-own-home', instanceId: 'claude', cliToolId: 'claude' });
    mkdirSync(process.env.CM_AGENT_HOOKS_DIR!, { recursive: true });
    symlinkSync(victim, settings);
    expect(() => claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toThrow(/resolves to .*victim, outside/);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  it('copilot: a temp file that is a symlink out of the HOME refuses the launch and is not written through', () => {
    ownHome();
    const victim = outsideFile();
    mkdirSync(process.env.COPILOT_HOME!, { recursive: true });
    symlinkSync(victim, getCopilotSettingsTempPath(getCopilotSettingsPath()));
    const target = { worktreeId: 'wt-own-home', cliToolId: 'copilot', instanceId: 'copilot' } as const;
    expect(() =>
      buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, { relayScriptPath: '/opt/relay.sh' })
    ).toThrow(UatIsolationLaunchRefusedError);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  it('negative control — unset: copilot replaces the planted temp symlink instead of writing through it', () => {
    const victim = outsideFile();
    mkdirSync(process.env.COPILOT_HOME!, { recursive: true });
    symlinkSync(victim, getCopilotSettingsTempPath(getCopilotSettingsPath()));
    const target = { worktreeId: 'wt-own-home', cliToolId: 'copilot', instanceId: 'copilot' } as const;
    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, target, { relayScriptPath: '/opt/relay.sh' });
    expect(plan.settingsPath).toBe(getCopilotSettingsPath());
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });
});

describe('codex under own-home: a relay that could not be updated is a failed preparation', () => {
  /** `commandmate` as a FILE: the relay's directory cannot be made, inside the HOME. */
  function blockRelayDirectory(): void {
    writeFileSync(join(process.env.CODEX_HOME!, 'commandmate'), 'not a directory\n');
  }

  it('refuses the launch instead of running with an older or missing relay', () => {
    ownHome();
    blockRelayDirectory();
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(UatIsolationLaunchRefusedError);
    expect(existsSync(getCodexHooksPath())).toBe(false);
  });

  it('refuses when this build ships no relay', () => {
    ownHome();
    process.chdir(scratch);
    expect(() => buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017 })).toThrow(/ships no relay/);
  });

  it('negative control — unset: the failed install is absorbed and codex still gets a plan', () => {
    blockRelayDirectory();
    const plan = buildCodexLaunchPlan('codex', CODEX_TARGET, { port: 3017, supportsNoDaemon: false });
    expect(plan.settingsPath).toBe(getCodexHooksPath());
  });
});

describe('claude under own-home: a settings file that could not be written refuses the launch', () => {
  /** `CM_AGENT_HOOKS_DIR` as a FILE inside the HOME: the checks pass, the write fails. */
  function blockHooksDirectory(): void {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(process.env.CM_AGENT_HOOKS_DIR!, 'not a directory\n');
  }

  it('own-home: refused, never the bare claude', () => {
    ownHome();
    blockHooksDirectory();
    expect(() => claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toThrow(
      /refusing to start claude: the hook settings file could not be written/
    );
  });

  it('own-home: CM_AGENT_HOOKS_INJECT=0 is refused too', () => {
    ownHome();
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    expect(() => claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toThrow(/CM_AGENT_HOOKS_INJECT=0/);
  });

  it('negative control — 1 and unset: the bare claude, as before', () => {
    blockHooksDirectory();
    expect(claudeAgentEventSource.prepareLaunch(launchContext('claude'))).toMatchObject({ settingsPath: null });
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    const plan = claudeAgentEventSource.prepareLaunch(launchContext('claude'));
    expect(plan.settingsPath).toBeNull();
    expect(plan.command).toBe('/opt/bin/claude --setting-sources project,local');
  });
});
