/**
 * Issue #4233: what the absolute `CODEX_HOME` does to a `hooks.json` an older
 * build already wrote (docs/design/relative-config-home-4233.md §3.1.2,
 * #26-#30).
 *
 * The directory does not move (a relative home was already written under the
 * server's cwd), but the relay path inside the file goes from relative to
 * absolute. The older file is made without the older code:
 * `buildCodexHookSettings({ relayScriptPath })` honours an explicit relay path
 * verbatim, so a relative one reproduces what the older build emitted.
 *
 * Nothing is written outside the directories made under `os.tmpdir()`; the
 * relative-path assertions come before anything is written. That guard is
 * also why #27 / #28 stop early on the implementation before the fix: there
 * the file would land in the checkout, so they are negative controls of the
 * fixed code only.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative } from 'path';

const lifecycle = vi.hoisted(() => ({ buildAgentLaunchCommandLine: vi.fn(), beginAgentSession: vi.fn() }));
vi.mock('@/lib/session/agent-session-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/agent-session-lifecycle')>();
  lifecycle.buildAgentLaunchCommandLine.mockImplementation(actual.buildAgentLaunchCommandLine as never);
  lifecycle.beginAgentSession.mockImplementation(actual.beginAgentSession as never);
  return { ...actual, ...lifecycle };
});

import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { CodexTool } from '@/lib/cli-tools/codex';
import {
  buildCodexHookSettings,
  CODEX_HOME_ENV_VAR,
  CODEX_HOOK_MARKER,
  getCodexHome,
  inspectCodexSharedHooksReadOnly,
  mergeCodexHookSettings,
  writeCodexHookSettings,
  type CodexHookSettings,
} from '@/lib/hooks/sources/codex/hooks-config';
import { getCodexRelayInstallPath } from '@/lib/hooks/sources/codex/relay-install';

const OPTIONS = { port: 4321, withAuthHeader: false } as const;
const USER_HOOK = { type: 'command', command: 'echo the-users-own-hook', timeout: 5 };

let serverCwd: string;

function installFakeRelay(home: string): string {
  const relay = getCodexRelayInstallPath(home);
  mkdirSync(dirname(relay), { recursive: true });
  writeFileSync(relay, '#!/bin/sh\nexit 0\n');
  chmodSync(relay, 0o755);
  return relay;
}

function render(settings: unknown): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** What an older build wrote: CommandMate's handlers naming the relay relatively, plus the user's hook. */
function olderFile(relativeRelay: string, withUserHook: boolean): string {
  const ours = buildCodexHookSettings({ ...OPTIONS, relayScriptPath: relativeRelay });
  const existing = withUserHook ? { hooks: { Stop: [{ hooks: [USER_HOOK] }] } } : null;
  return render(mergeCodexHookSettings(existing, ours));
}

function commands(text: string): string[] {
  const parsed = JSON.parse(text) as CodexHookSettings;
  return Object.values(parsed.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4233-migrate-server-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_UAT_ISOLATION', '');
  vi.stubEnv(CODEX_HOME_ENV_VAR, 'rel-codex');
  resetSafeDirectoryWarnings();
  lifecycle.buildAgentLaunchCommandLine.mockClear();
  lifecycle.beginAgentSession.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
});

describe('a hooks.json an older build wrote under a relative CODEX_HOME (Issue #4233)', () => {
  it('#26 is rewritten with an absolute relay for CommandMate\'s handlers only; the user\'s hook stays', () => {
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getCodexHome())).toBe(true);
    const home = join(serverCwd, 'rel-codex');
    const relay = installFakeRelay(home);
    const older = olderFile(relative(serverCwd, relay), true);
    expect(older).toContain(`'${relative(serverCwd, relay)}'`);
    writeFileSync(join(home, 'hooks.json'), older);

    const settingsPath = writeCodexHookSettings(OPTIONS);
    expect(settingsPath).toBe(join(home, 'hooks.json'));
    const after = readFileSync(settingsPath as string, 'utf8');
    // The lifecycle-event handlers go through the relay; the permission hook is
    // its own inline `curl` and names no relay at all.
    const ours = commands(after).filter((command) => command.includes(CODEX_HOOK_MARKER) && command.includes('--event'));
    expect(ours.length).toBeGreaterThan(0);
    for (const command of ours) expect(command).toContain(`'${relay}'`);
    expect(after).not.toContain(`'${relative(serverCwd, relay)}'`);
    expect(commands(after)).toContain(USER_HOOK.command);
  });

  it('#27 a second write changes neither the bytes nor the mtime', () => {
    expect(isAbsolute(getCodexHome())).toBe(true);
    const home = join(serverCwd, 'rel-codex');
    installFakeRelay(home);
    const settingsPath = writeCodexHookSettings(OPTIONS) as string;
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);
    const before = { bytes: readFileSync(settingsPath, 'utf8'), mtime: statSync(settingsPath).mtimeMs };

    expect(writeCodexHookSettings(OPTIONS)).toBe(settingsPath);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before.bytes);
    expect(statSync(settingsPath).mtimeMs).toBe(before.mtime);
  });

  it('#28 the UAT read-only check refuses the older file as different, and does not touch it', () => {
    expect(isAbsolute(getCodexHome())).toBe(true);
    const home = join(serverCwd, 'rel-codex');
    const relay = installFakeRelay(home);
    const older = olderFile(relative(serverCwd, relay), false);
    writeFileSync(join(home, 'hooks.json'), older);

    vi.stubEnv('CM_UAT_ISOLATION', '1');
    const inspection = inspectCodexSharedHooksReadOnly(OPTIONS);
    expect(inspection.usable).toBe(false);
    if (inspection.usable) return;
    expect(inspection.reason).toContain('differs from what this build writes');
    expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe(older);
  });

  it('#29 an absolute CODEX_HOME writes what it always wrote (no new trust review)', () => {
    const home = join(serverCwd, 'abs-codex');
    vi.stubEnv(CODEX_HOME_ENV_VAR, home);
    const relay = installFakeRelay(home);
    // The pre-#4233 build named the installed relay of an absolute home by that
    // same absolute path, which is what the explicit option reproduces.
    const expected = render(mergeCodexHookSettings(null, buildCodexHookSettings({ ...OPTIONS, relayScriptPath: relay })));

    const settingsPath = writeCodexHookSettings(OPTIONS) as string;
    expect(readFileSync(settingsPath, 'utf8')).toBe(expected);
  });
});

describe('a live codex pane is not switched to the new home (Issue #4233)', () => {
  it('#30 neither builds a launch plan nor writes hooks.json', async () => {
    const tool = new CodexTool();
    const internals = tool as unknown as {
      requireInstalled: () => Promise<void>;
      resolveLaunchPane: () => Promise<{ sessionName: string; exists: boolean; live: boolean }>;
      launchSession: (worktreeId: string, worktreePath: string, instanceId?: string) => Promise<void>;
    };
    vi.spyOn(internals, 'requireInstalled').mockResolvedValue(undefined);
    vi.spyOn(internals, 'resolveLaunchPane').mockResolvedValue({ sessionName: 'mcbd-codex-wt-4233', exists: true, live: true });

    await internals.launchSession('wt-4233', serverCwd);
    expect(lifecycle.buildAgentLaunchCommandLine).not.toHaveBeenCalled();
    expect(lifecycle.beginAgentSession).not.toHaveBeenCalled();
    expect(() => statSync(join(serverCwd, 'rel-codex', 'hooks.json'))).toThrow();
  });
});
