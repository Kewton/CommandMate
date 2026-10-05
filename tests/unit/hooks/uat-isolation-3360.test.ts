/**
 * Issue #3360: `CM_UAT_ISOLATION=1` — a UAT / daily-check server writes none of
 * the files it shares with the user's production server, and does not run the
 * user's own claude hooks.
 *
 * Each block has a positive control (fails on the implementation before this
 * Issue: the shared file was written, the trust was granted, the user source was
 * loaded) and a negative control (with the variable unset, nothing changes).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { CLAUDE_UAT_SETTING_SOURCES, UAT_ISOLATION_ENV_VAR } from '@/config/uat-isolation';
import {
  buildCodexLaunchPlan,
  getCodexHooksPath,
  shouldTrustCodexHooks,
  writeCodexHookSettings,
} from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_RELAY_INSTALL_BASENAME,
  getCodexRelayInstallPath,
} from '@/lib/hooks/sources/codex/relay-install';
import { writeAntigravityHooksConfig } from '@/lib/hooks/sources/antigravity/hooks-config';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';

const MANAGED_ENV = [
  UAT_ISOLATION_ENV_VAR,
  'CODEX_HOME',
  'CM_AGENT_HOOKS_INJECT',
  'CM_AGENT_HOOKS_DIR',
  'CM_CODEX_HOOK_TRUST',
  'CM_PORT',
  'MCBD_PORT',
] as const;

const RELAY_BODY = '#!/bin/sh\n# shipped relay\nexit 0\n';

let saved: Record<string, string | undefined>;
let originalCwd: string;
let checkout: string;
let codexHome: string;
let scratch: string;

beforeEach(() => {
  originalCwd = process.cwd();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];

  // A fake checkout holding the relay this "build" ships, as the cwd the
  // server resolves `scripts/hooks/cmate-agent-event.sh` against.
  checkout = mkdtempSync(join(tmpdir(), 'uat-iso-checkout-'));
  mkdirSync(join(checkout, 'scripts', 'hooks'), { recursive: true });
  const shipped = join(checkout, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);
  writeFileSync(shipped, RELAY_BODY);
  chmodSync(shipped, 0o755);
  process.chdir(checkout);

  codexHome = mkdtempSync(join(tmpdir(), 'uat-iso-codex-home-'));
  process.env.CODEX_HOME = codexHome;
  scratch = mkdtempSync(join(tmpdir(), 'uat-iso-scratch-'));
  process.env.CM_AGENT_HOOKS_DIR = join(scratch, 'hooks');
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTempDir(checkout);
  removeTempDir(codexHome);
  removeTempDir(scratch);
});

/** What a production server (no isolation) leaves in the shared `$CODEX_HOME`. */
function primeSharedCodexFilesAsProduction(): { hooks: string; relay: string } {
  expect(writeCodexHookSettings()).toBe(getCodexHooksPath());
  return {
    hooks: readFileSync(getCodexHooksPath(), 'utf8'),
    relay: readFileSync(getCodexRelayInstallPath(codexHome), 'utf8'),
  };
}

describe('codex shared files under CM_UAT_ISOLATION=1', () => {
  it('writes neither hooks.json nor the relay when they are absent, and answers null', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeCodexHookSettings()).toBeNull();
    expect(existsSync(getCodexHooksPath())).toBe(false);
    expect(existsSync(getCodexRelayInstallPath(codexHome))).toBe(false);
  });

  it('reuses a shared file that is already byte-identical, without rewriting it', () => {
    const before = primeSharedCodexFilesAsProduction();
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeCodexHookSettings()).toBe(getCodexHooksPath());
    expect(readFileSync(getCodexHooksPath(), 'utf8')).toBe(before.hooks);
  });

  it('routes the reused hooks to THIS server through the launch environment', () => {
    primeSharedCodexFilesAsProduction();
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    const plan = buildCodexLaunchPlan(
      'codex',
      { worktreeId: 'wt-uat', cliToolId: 'codex', instanceId: 'codex' },
      { port: 3017, supportsNoDaemon: false }
    );

    expect(plan.settingsPath).toBe(getCodexHooksPath());
    expect(plan.env.CM_HOOK_URL).toBe('http://127.0.0.1:3017/api/hooks/agent-event');
    expect(plan.env.CM_PERMISSION_HOOK_URL).toContain('http://127.0.0.1:3017/');
  });

  it('leaves a shared file this build would change untouched, and launches without hooks', () => {
    primeSharedCodexFilesAsProduction();
    const stale = '{\n  "hooks": {}\n}\n';
    writeFileSync(getCodexHooksPath(), stale);
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeCodexHookSettings()).toBeNull();
    expect(readFileSync(getCodexHooksPath(), 'utf8')).toBe(stale);

    const plan = buildCodexLaunchPlan(
      'codex',
      { worktreeId: 'wt-uat', cliToolId: 'codex', instanceId: 'codex' },
      { port: 3017, supportsNoDaemon: false }
    );
    expect(plan).toEqual({ command: 'codex', settingsPath: null, env: {} });
  });

  it('does not overwrite an installed relay whose bytes differ from the shipped one', () => {
    const before = primeSharedCodexFilesAsProduction();
    const otherVersion = '#!/bin/sh\n# another CommandMate version\nexit 0\n';
    writeFileSync(getCodexRelayInstallPath(codexHome), otherVersion);
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeCodexHookSettings()).toBeNull();
    expect(readFileSync(getCodexRelayInstallPath(codexHome), 'utf8')).toBe(otherVersion);
    expect(readFileSync(getCodexHooksPath(), 'utf8')).toBe(before.hooks);
  });

  it('negative control: unset, the server installs the relay and writes hooks.json as before', () => {
    expect(writeCodexHookSettings()).toBe(getCodexHooksPath());
    expect(existsSync(getCodexHooksPath())).toBe(true);
    expect(readFileSync(getCodexRelayInstallPath(codexHome), 'utf8')).toBe(RELAY_BODY);
  });

  it('only the exact value 1 turns the mode on', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = 'true';
    expect(writeCodexHookSettings()).toBe(getCodexHooksPath());
  });
});

describe('codex hook trust under CM_UAT_ISOLATION=1', () => {
  it('never answers the review with trust (that is codex writing config.toml)', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    expect(shouldTrustCodexHooks(scratch)).toBe(false);
  });

  it('negative control: unset, a worktree without .codex/hooks.json is trusted as before', () => {
    expect(shouldTrustCodexHooks(scratch)).toBe(true);
  });
});

describe('antigravity shared hooks.json under CM_UAT_ISOLATION=1', () => {
  it('does not create ~/.gemini/config/hooks.json, and answers null', () => {
    const path = join(scratch, 'gemini', 'config', 'hooks.json');
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeAntigravityHooksConfig({ path })).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('reuses a file that already holds exactly this config, and leaves another untouched', () => {
    const path = join(scratch, 'gemini', 'config', 'hooks.json');
    expect(writeAntigravityHooksConfig({ path })).toBe(path);
    const written = readFileSync(path, 'utf8');
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(writeAntigravityHooksConfig({ path })).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(written);

    const foreign = '{\n  "commandmate": {"other": true}\n}\n';
    writeFileSync(path, foreign);
    expect(writeAntigravityHooksConfig({ path })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(foreign);
  });

  it('negative control: unset, the file is written as before', () => {
    const path = join(scratch, 'gemini', 'config', 'hooks.json');
    expect(writeAntigravityHooksConfig({ path })).toBe(path);
    expect(existsSync(path)).toBe(true);
  });
});

describe('claude launch under CM_UAT_ISOLATION=1', () => {
  const context = {
    target: { worktreeId: 'wt-uat', cliToolId: 'claude' as const, instanceId: 'claude' },
    executablePath: '/opt/bin/claude',
    worktreePath: '/tmp/uat-worktree',
  };

  it('drops the user setting source and keeps --settings', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    const plan = claudeAgentEventSource.prepareLaunch(context);

    expect(plan.command).toContain(' --settings ');
    expect(plan.command.endsWith(` --setting-sources ${CLAUDE_UAT_SETTING_SOURCES}`)).toBe(true);
    expect(CLAUDE_UAT_SETTING_SOURCES).toBe('project,local');
    expect(plan.settingsPath).not.toBeNull();
    expect(existsSync(plan.settingsPath!)).toBe(true);
  });

  it('drops the user source even with injection off, and reports no settings file', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    process.env.CM_AGENT_HOOKS_INJECT = '0';

    const plan = claudeAgentEventSource.prepareLaunch(context);

    expect(plan.command).toBe(
      `/opt/bin/claude --setting-sources ${CLAUDE_UAT_SETTING_SOURCES}`
    );
    expect(plan.settingsPath).toBeNull();
  });

  it('negative control: unset, the command carries no --setting-sources', () => {
    const plan = claudeAgentEventSource.prepareLaunch(context);

    expect(plan.command).toContain(' --settings ');
    expect(plan.command).not.toContain('--setting-sources');
  });
});
