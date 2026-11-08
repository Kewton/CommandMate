/**
 * Issue #4233: how far the absolute `CODEX_HOME` pin reaches
 * (docs/design/relative-config-home-4233.md §3.1.1, #17-#20).
 *
 * A launch whose hooks were prepared pins the (now absolute) home it wrote
 * `hooks.json` to. A role pins the home its profile is in, hooks or not. The
 * `bare` fallback — hooks off, or a `hooks.json` this server must not touch —
 * stays byte-identical to the pre-#1760 launch (no `CODEX_HOME` added), and
 * under UAT isolation that fallback is still a refusal (#3360).
 *
 * Each test pairs the cwd the files are written from (`serverCwd`, the cwd
 * this process reports) with the cwd codex runs in (`launchCwd`). Nothing is
 * written outside the directories made under `os.tmpdir()`; the relative-path
 * assertions come before anything is written.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { UatIsolationLaunchRefusedError } from '@/config/uat-isolation';
import { buildRoleLaunchArguments } from '@/lib/agent-roles/adapters';
import { resolveArtifactLocation, writeRoleArtifact } from '@/lib/agent-roles/artifacts';
import { buildCodexLaunchPlan, CODEX_HOME_ENV_VAR, getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';

const TARGET = { worktreeId: 'wt-4233', cliToolId: 'codex' } as const;
const OPTIONS = { port: 4321, supportsNoDaemon: false, withAuthHeader: false } as const;
const NAME = 'cm-role-ns-0011223344556677-efefefefefef';

let serverCwd: string;
let launchCwd: string;

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4233-pin-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4233-pin-worktree-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_UAT_ISOLATION', '');
  vi.stubEnv(CODEX_HOME_ENV_VAR, 'rel-codex');
  resetSafeDirectoryWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('the CODEX_HOME pin under a relative CODEX_HOME (Issue #4233)', () => {
  it('#17 hooks prepared, no role: the pinned home is, from the launch cwd, the home hooks.json was written to', () => {
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getCodexHome())).toBe(true);
    const plan = buildCodexLaunchPlan('codex', TARGET, OPTIONS);
    expect(plan.settingsPath).not.toBeNull();
    expect(resolve(launchCwd, plan.env[CODEX_HOME_ENV_VAR])).toBe(dirname(plan.settingsPath as string));
  });

  it('#18 hooks off, with a role: the role pins an absolute home holding its profile', () => {
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    expect(isAbsolute(resolveArtifactLocation('codex', NAME).path)).toBe(true);
    mkdirSync(join(serverCwd, 'rel-codex'));

    expect(buildCodexLaunchPlan('codex', TARGET, OPTIONS).env).toEqual({});
    const artifact = writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'be a reviewer' });
    const role = buildRoleLaunchArguments({ adapter: 'codex', effectiveAgent: null }, artifact, {});
    const pinned = role.env[CODEX_HOME_ENV_VAR];
    expect(isAbsolute(pinned)).toBe(true);
    expect(dirname(artifact.path)).toBe(pinned);
    expect(existsSync(join(resolve(launchCwd, pinned), `${NAME}.config.toml`))).toBe(true);
  });
});

describe('the bare fallback stays as it was (Issue #4233, #1760 / #3360 kept)', () => {
  it('#19 hooks off, no role: the bare plan, no CODEX_HOME, no hooks.json', () => {
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    expect(buildCodexLaunchPlan('codex', TARGET, OPTIONS)).toEqual({ command: 'codex', settingsPath: null, env: {} });
    expect(existsSync(join(serverCwd, 'rel-codex', 'hooks.json'))).toBe(false);
  });

  it('#20 an unreadable hooks.json: bare and untouched, and refused under UAT isolation', () => {
    expect(isAbsolute(getCodexHome())).toBe(true);
    const settings = join(serverCwd, 'rel-codex', 'hooks.json');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{ not json');

    expect(buildCodexLaunchPlan('codex', TARGET, OPTIONS)).toEqual({ command: 'codex', settingsPath: null, env: {} });
    expect(readFileSync(settings, 'utf8')).toBe('{ not json');

    vi.stubEnv('CM_UAT_ISOLATION', '1');
    expect(() => buildCodexLaunchPlan('codex', TARGET, OPTIONS)).toThrow(UatIsolationLaunchRefusedError);
    expect(readFileSync(settings, 'utf8')).toBe('{ not json');
  });
});
