/**
 * Issue #4210 (review P2): a relative `COPILOT_HOME` on an ordinary copilot
 * launch — no role — named one `settings.json` where the server wrote the hooks
 * and another where copilot read them.
 *
 * `writeCopilotHookSettings` writes `<COPILOT_HOME>/settings.json` relative to
 * the server's cwd; copilot runs in a pane created in the worktree
 * (`cli-tools/base.ts` `createLaunchPane`) and resolves `COPILOT_HOME` there.
 * Each test pairs the cwd the file is written from (`serverCwd`) with the cwd
 * copilot runs in (`launchCwd`) and asks whether the home copilot is handed
 * names the file that was written.
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertion comes before anything is written, so an
 * implementation that returns the relative home stops there without writing
 * into the checkout (`fs` resolves against the real cwd, not the mocked one).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import {
  COPILOT_HOOK_PORT_ENV,
  COPILOT_INSTANCE_ID_ENV,
  COPILOT_WORKTREE_ID_ENV,
  buildCopilotLaunchCommand,
  getCopilotHomeDirectory,
  getCopilotSettingsPath,
} from '@/lib/hooks/sources/copilot/hook-settings';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const TARGET: AgentInstanceRef = { worktreeId: 'wt-4210', cliToolId: 'copilot', instanceId: 'copilot' };

let serverCwd: string;
let launchCwd: string;

/** The `settings.json` copilot reads, given the environment it is launched with. */
function settingsCopilotReads(env: Record<string, string>, ambient: string): string {
  return resolve(launchCwd, env.COPILOT_HOME ?? ambient, 'settings.json');
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4210-copilot-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4210-copilot-worktree-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_UAT_ISOLATION', '');
  resetSafeDirectoryWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('a relative COPILOT_HOME on a launch without a role (Issue #4210)', () => {
  it('hands copilot the absolute home the settings file was written into', () => {
    vi.stubEnv('COPILOT_HOME', 'rel-copilot');
    // Before anything is written.
    expect(isAbsolute(getCopilotHomeDirectory())).toBe(true);

    const plan = buildCopilotLaunchCommand('copilot', TARGET);
    const written = getCopilotSettingsPath();

    expect(plan.settingsPath).toBe(written);
    expect(written).toBe(join(serverCwd, 'rel-copilot', 'settings.json'));
    expect(existsSync(written)).toBe(true);
    expect(plan.env.COPILOT_HOME).toBe(join(serverCwd, 'rel-copilot'));
    // What copilot opens, started in the worktree:
    expect(settingsCopilotReads(plan.env, 'rel-copilot')).toBe(written);
  });
});

describe('what does not change (negative controls)', () => {
  it('an absolute COPILOT_HOME is not added to the launch environment', () => {
    const absolute = join(serverCwd, 'abs-copilot');
    vi.stubEnv('COPILOT_HOME', absolute);
    const plan = buildCopilotLaunchCommand('copilot', TARGET);
    expect(plan.settingsPath).toBe(join(absolute, 'settings.json'));
    expect(plan.env).not.toHaveProperty('COPILOT_HOME');
    expect(Object.keys(plan.env).sort()).toEqual(
      [COPILOT_HOOK_PORT_ENV, COPILOT_INSTANCE_ID_ENV, COPILOT_WORKTREE_ID_ENV].sort()
    );
  });

  it('an unset COPILOT_HOME is not added either', () => {
    vi.stubEnv('COPILOT_HOME', '');
    vi.stubEnv('HOME', serverCwd);
    const plan = buildCopilotLaunchCommand('copilot', TARGET);
    expect(plan.env).not.toHaveProperty('COPILOT_HOME');
  });

  it('an explicit settingsPath names no home, so none is pinned', () => {
    vi.stubEnv('COPILOT_HOME', 'rel-copilot');
    const settingsPath = join(serverCwd, 'explicit', 'settings.json');
    const plan = buildCopilotLaunchCommand('copilot', TARGET, {
      settingsPath,
      configPath: join(serverCwd, 'explicit', 'config.json'),
    });
    expect(plan.settingsPath).toBe(settingsPath);
    expect(plan.env).not.toHaveProperty('COPILOT_HOME');
  });
});
