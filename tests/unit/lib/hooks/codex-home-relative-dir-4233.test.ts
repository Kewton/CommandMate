/**
 * Issue #4233, item 1: a relative `CODEX_HOME` named one directory where the
 * server wrote codex's `hooks.json` and relay, and another where codex read
 * them.
 *
 * The daemon runs from the package root (`src/cli/utils/daemon.ts`,
 * `cwd: packageRoot`) and `fs` resolves a relative `CODEX_HOME` against that;
 * codex is started in the worktree (`cli-tools/base.ts` `createLaunchPane`)
 * and is handed `CODEX_HOME` on its launch line (`buildCodexLaunchPlan`), so it
 * resolves the same string against the worktree. Each test pairs the cwd the
 * file is written from (`serverCwd`, the cwd this process reports) with the cwd
 * codex runs in (`launchCwd`), the #4191 / #4210 shape.
 * docs/design/relative-config-home-4233.md §3.3, #1-#7.
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertions come before anything is written, so the
 * implementation before the fix stops there without writing `rel-codex/` into
 * the checkout (`fs` resolves against the real cwd, not the mocked one).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import {
  buildCodexLaunchPlan,
  CODEX_HOME_ENV_VAR,
  getCodexHome,
} from '@/lib/hooks/sources/codex/hooks-config';
import { getCodexRelayInstallPath } from '@/lib/hooks/sources/codex/relay-install';

const TARGET = { worktreeId: 'wt-4233', cliToolId: 'codex' } as const;
const OPTIONS = { port: 4321, supportsNoDaemon: false, withAuthHeader: false } as const;

/** The launch-plan keys a hooked codex launch has always carried (#1760, #1846). */
const LAUNCH_ENV_KEYS = [
  'CODEX_HOME',
  'CM_AGENT_TOOL',
  'CM_AGENT_WORKTREE_ID',
  'CM_AGENT_INSTANCE_ID',
  'CM_HOOK_URL',
  'CM_PERMISSION_HOOK_URL',
];

let serverCwd: string;
let launchCwd: string;

/** Put a relay where `writeCodexHookSettings` looks for the installed copy. */
function installFakeRelay(home: string): string {
  const relay = getCodexRelayInstallPath(home);
  mkdirSync(dirname(relay), { recursive: true });
  writeFileSync(relay, '#!/bin/sh\nexit 0\n');
  chmodSync(relay, 0o755);
  return relay;
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4233-codex-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4233-codex-worktree-'));
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

describe('a relative CODEX_HOME (Issue #4233)', () => {
  it('#1 CodexHookOptions.codexHome is resolved against the cwd the files are written from', () => {
    expect(getCodexHome({ codexHome: 'rel-codex' })).toBe(join(serverCwd, 'rel-codex'));
  });

  it('#2 the CODEX_HOME variable is resolved the same way', () => {
    vi.stubEnv(CODEX_HOME_ENV_VAR, 'rel-codex');
    expect(getCodexHome()).toBe(join(serverCwd, 'rel-codex'));
  });

  it('#3 the CODEX_HOME on the launch line names, from the launch cwd, the hooks.json written', () => {
    vi.stubEnv(CODEX_HOME_ENV_VAR, 'rel-codex');
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getCodexHome())).toBe(true);

    const plan = buildCodexLaunchPlan('codex', TARGET, OPTIONS);
    expect(plan.settingsPath).not.toBeNull();
    const pinned = plan.env[CODEX_HOME_ENV_VAR];
    expect(resolve(launchCwd, pinned, 'hooks.json')).toBe(plan.settingsPath);
    expect(existsSync(resolve(launchCwd, pinned, 'hooks.json'))).toBe(true);
  });

  it('#4 the relay hooks.json names is absolute and is there from the launch cwd', () => {
    vi.stubEnv(CODEX_HOME_ENV_VAR, 'rel-codex');
    expect(isAbsolute(getCodexHome())).toBe(true);
    const relay = installFakeRelay(join(serverCwd, 'rel-codex'));

    const plan = buildCodexLaunchPlan('codex', TARGET, OPTIONS);
    const content = readFileSync(plan.settingsPath as string, 'utf8');
    expect(content).toContain(`'${relay}'`);
    expect(isAbsolute(relay)).toBe(true);
    expect(existsSync(resolve(launchCwd, relay))).toBe(true);
  });
});

describe('what a relative CODEX_HOME does not change (Issue #4233)', () => {
  it('#5 an absolute CODEX_HOME is kept as it is, and the launch env keeps its keys', () => {
    const home = join(serverCwd, 'abs-codex');
    vi.stubEnv(CODEX_HOME_ENV_VAR, home);
    expect(getCodexHome()).toBe(home);

    const plan = buildCodexLaunchPlan('codex', TARGET, OPTIONS);
    expect(plan.env[CODEX_HOME_ENV_VAR]).toBe(home);
    expect(Object.keys(plan.env).sort()).toEqual([...LAUNCH_ENV_KEYS].sort());
    expect(plan.settingsPath).toBe(join(home, 'hooks.json'));
  });

  it('#6 an unset CODEX_HOME is ~/.codex', () => {
    vi.stubEnv(CODEX_HOME_ENV_VAR, '');
    expect(getCodexHome()).toBe(join(homedir(), '.codex'));
    // And the suite's own pin (tests/setup.ts) is kept verbatim when it is set.
    vi.stubEnv(CODEX_HOME_ENV_VAR, join(tmpdir(), 'commandmate-test-codex-home'));
    expect(getCodexHome()).toBe(join(tmpdir(), 'commandmate-test-codex-home'));
  });

  it('#7 a value inside /proc is still refused for ~/.codex (#1774)', () => {
    expect(getCodexHome({ codexHome: '/proc/self/codex' })).toBe(join(homedir(), '.codex'));
    vi.stubEnv(CODEX_HOME_ENV_VAR, '/dev/shm/codex');
    expect(getCodexHome()).toBe(join(homedir(), '.codex'));
  });
});
