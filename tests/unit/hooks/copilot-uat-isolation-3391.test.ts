/**
 * Issue #3391: under `CM_UAT_ISOLATION=1` a server writes nothing to copilot's
 * shared `~/.copilot/settings.json` — the one file for the machine, shared with
 * the production server and naming a relay by checkout path.
 *
 * Same shape as codex and antigravity (Issue #3360): a file that already holds
 * exactly what this build writes into an empty file is used as it is; anything
 * else (missing, different, mixed with the user's own hooks, shadowed by a
 * `hooks` key in `config.json`) refuses the launch with the reason.
 *
 * Positive controls fail on the implementation before this Issue (the file was
 * written and a `.cmate-backup` made; a non-matching file started copilot
 * anyway). Negative controls: with the variable unset, nothing changes.
 *
 * `COPILOT_HOME` points into a temp directory for the whole file.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  UAT_ISOLATION_ENV_VAR,
  UatIsolationLaunchRefusedError,
} from '@/config/uat-isolation';
import {
  buildCopilotHookSettings,
  buildCopilotLaunchCommand,
  COPILOT_LAUNCH_COMMAND,
  COPILOT_SETTINGS_BACKUP_SUFFIX,
  getCopilotSettingsPath,
  inspectCopilotHookSettingsReadOnly,
  mergeCopilotHookSettings,
  writeCopilotHookSettings,
} from '@/lib/hooks/sources/copilot/hook-settings';
import { copilotAgentEventSource } from '@/lib/hooks/sources/copilot/source';

const MANAGED_ENV = [UAT_ISOLATION_ENV_VAR, 'COPILOT_HOME', 'CM_AGENT_HOOKS_INJECT', 'CM_PORT'] as const;
const RELAY = '/opt/commandmate/scripts/hooks/cmate-agent-event.sh';
const OPTIONS = { relayScriptPath: RELAY };
const TARGET = { worktreeId: 'wt-uat-3391', cliToolId: 'copilot', instanceId: 'copilot' } as const;

let saved: Record<string, string | undefined>;
let home: string;
let settingsPath: string;

/** What this build writes into an empty file. */
function ownContent(): string {
  return `${JSON.stringify(mergeCopilotHookSettings({}, buildCopilotHookSettings(OPTIONS)), null, 2)}\n`;
}

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'uat-3391-copilot-home-'));
  process.env.COPILOT_HOME = home;
  process.env.CM_PORT = '4321';
  settingsPath = getCopilotSettingsPath();
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTempDir(home);
});

describe('CM_UAT_ISOLATION=1: copilot ~/.copilot/settings.json is never written (Issue #3391)', () => {
  beforeEach(() => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
  });

  it('missing file: writes nothing (no settings.json, no backup, no lock) and refuses the launch', () => {
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toThrow(
      /refusing to start copilot: .*settings\.json does not exist/
    );
    expect(readdirSync(home)).toEqual([]);
  });

  it('matching file (CommandMate hooks only): used read-only, bytes and mtime untouched', () => {
    writeFileSync(settingsPath, ownContent());
    const before = statSync(settingsPath).mtimeMs;

    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS);

    expect(plan.settingsPath).toBe(settingsPath);
    expect(plan.env.CM_AGENT_WORKTREE_ID).toBe(TARGET.worktreeId);
    expect(plan.env.CM_HOOK_PORT).toBe('4321');
    expect(readFileSync(settingsPath, 'utf8')).toBe(ownContent());
    expect(statSync(settingsPath).mtimeMs).toBe(before);
    expect(readdirSync(home)).toEqual(['settings.json']);
  });

  it('a file holding a different build\'s hooks: refused, not rewritten, no backup', () => {
    const other = `${JSON.stringify(
      mergeCopilotHookSettings({}, buildCopilotHookSettings({ relayScriptPath: '/elsewhere/relay.sh' })),
      null,
      2
    )}\n`;
    writeFileSync(settingsPath, other);

    expect(() => writeCopilotHookSettings(OPTIONS)).toThrow(/differs from what this build writes/);
    expect(readFileSync(settingsPath, 'utf8')).toBe(other);
    expect(existsSync(`${settingsPath}${COPILOT_SETTINGS_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('this build\'s hooks plus the user\'s own hook: refused as foreign, with its own reason', () => {
    const userHook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl http://127.0.0.1:3000/x' }] }] } };
    const mixed = `${JSON.stringify(mergeCopilotHookSettings(userHook, buildCopilotHookSettings(OPTIONS)), null, 2)}\n`;
    writeFileSync(settingsPath, mixed);

    const inspection = inspectCopilotHookSettingsReadOnly(OPTIONS);
    expect(inspection.usable).toBe(false);
    expect(inspection.usable === false && inspection.reason).toMatch(/hooks \(or keys\) CommandMate did not write/);
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe(mixed);
  });

  it('a hooks key in config.json (copilot migrates it over settings.json): refused', () => {
    writeFileSync(settingsPath, ownContent());
    writeFileSync(join(home, 'config.json'), '{"hooks":{"Stop":[{"type":"command","command":"x"}]}}\n');

    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toThrow(
      /config\.json has a "hooks" key/
    );
  });

  it('CM_AGENT_HOOKS_INJECT=0 is refused rather than launching a bare copilot', () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    expect(() => buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toThrow(
      /refusing to start copilot: CM_AGENT_HOOKS_INJECT=0/
    );
  });

  it('the registered source\'s prepareLaunch refuses the same way', () => {
    expect(() =>
      copilotAgentEventSource.prepareLaunch({
        target: TARGET,
        executablePath: COPILOT_LAUNCH_COMMAND,
        worktreePath: '/tmp/wt-uat-3391',
      })
    ).toThrow(/refusing to start copilot/);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('negative control: CM_UAT_ISOLATION unset, the launch writes as before', () => {
  it('writes settings.json into an empty home and launches with hooks', () => {
    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS);

    expect(plan.settingsPath).toBe(settingsPath);
    expect(readFileSync(settingsPath, 'utf8')).toBe(ownContent());
  });

  it('rewrites a different file (keeping a backup) instead of refusing', () => {
    writeFileSync(settingsPath, '{"theme":"dark"}\n');

    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS);

    expect(plan.settingsPath).toBe(settingsPath);
    expect(readFileSync(`${settingsPath}${COPILOT_SETTINGS_BACKUP_SUFFIX}`, 'utf8')).toBe('{"theme":"dark"}\n');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('dark');
  });

  it('CM_AGENT_HOOKS_INJECT=0 still returns the bare command', () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    expect(buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS)).toEqual({
      command: COPILOT_LAUNCH_COMMAND,
      settingsPath: null,
      env: {},
    });
  });
});
