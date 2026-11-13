/**
 * The environment of the `codex --help` child that decides `--no-daemon`
 * (Issue #4343, the help-probe half of #4290).
 *
 * `codexSupportsNoDaemon` handed the child `sanitizeEnvForChildProcess()` as is,
 * so a server `CODEX_HOME` inside `/proc`, `/sys` or `/dev` — or one reaching
 * there through a symlink or a relative value — went to the child. The fix is
 * not to hand on an environment the child may fail in (whether a real codex
 * `--help` fails under it is not measured; `spawnSync` is scripted here and no
 * real CLI runs).
 *
 * Checked at three levels, because a predicate-only test would not show what
 * the launch line does with it:
 *  - the `env` given to `spawnSync`;
 *  - the `--no-daemon` flag on the launch plan, which follows the probe's answer;
 *  - the per-executable cache: no entry / true stored / false stored. The cache
 *    is NOT keyed by environment, so a false learned under a bad environment is
 *    not asked again in the same process — pinned here as a known limit.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import {
  buildCodexHelpProbeEnv,
  buildCodexLaunchPlan,
  CODEX_EMBEDDED_MODE_ARGS,
  CODEX_HOOK_TRUST_ENV_VAR,
  CODEX_NO_DAEMON_FLAG,
  codexSupportsNoDaemon,
  resetCodexNoDaemonSupportCacheForTests,
} from '@/lib/hooks/sources/codex/hooks-config';

const HELP_WITH_FLAG = [
  'Usage: codex [OPTIONS] [PROMPT]',
  '',
  '      --no-daemon',
  '          Run without the shared background server, even if it is already running',
  '',
].join('\n');

const MANAGED_ENV = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CM_AUTH_TOKEN',
  'CM_AGENT_HOOKS_INJECT',
  'CM_PORT',
  'MCBD_PORT',
  CODEX_HOOK_TRUST_ENV_VAR,
] as const;

/**
 * A CODEX_HOME inside /proc, named as data. Nothing under test creates a
 * directory from `process.env.CODEX_HOME` here — the probe only reads it, and
 * the launch plans are given `codexHome: safeHome` — so the Linux recursive-mkdir
 * spin that `tests/unit/guards/no-procfs-env-fixtures.test.ts` exists for cannot
 * be reached from these cases.
 */
const PROC_HOME = ['', 'proc', 'self', 'codex'].join('/');

const TARGET = { worktreeId: 'wt-alpha', cliToolId: 'codex' } as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let safeHome: string;
/** `<tmp>/dev-link` → `/dev`: a symlink into a virtual filesystem that exists on macOS and Linux. */
let devLink: string;

type SpawnResult = ReturnType<typeof spawnSync>;
const spawned = (fields: Record<string, unknown>): SpawnResult =>
  ({ status: 0, signal: null, stdout: '', stderr: '', ...fields }) as unknown as SpawnResult;

/** The `env` the most recent `spawnSync` call received. */
function lastSpawnEnv(): NodeJS.ProcessEnv {
  const calls = vi.mocked(spawnSync).mock.calls;
  const options = calls[calls.length - 1][2] as { env?: NodeJS.ProcessEnv };
  expect(options.env).toBeDefined();
  return options.env as NodeJS.ProcessEnv;
}

/**
 * A stand-in codex whose `--help` lists `--no-daemon` only when its environment
 * has no CODEX_HOME inside /proc, /sys or /dev — a model of "fails in such an
 * environment", not a measurement of the real CLI.
 */
function scriptHelpThatFailsUnderVirtualHome(): void {
  vi.mocked(spawnSync).mockImplementation(((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const codexHome = options?.env?.CODEX_HOME ?? '';
    const segments = codexHome.split('/');
    const resolvedIntoVirtual =
      segments.includes('proc') || segments.includes('dev') || segments.includes('dev-link');
    return resolvedIntoVirtual
      ? spawned({ status: 1, stdout: '', stderr: 'cannot read CODEX_HOME' })
      : spawned({ stdout: HELP_WITH_FLAG });
  }) as unknown as typeof spawnSync);
}

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  tmp = mkdtempSync(join(tmpdir(), 'codex-help-env-4343-'));
  safeHome = mkdtempSync(join(tmp, 'codex-home-'));
  devLink = join(tmp, 'dev-link');
  symlinkSync('/dev', devLink);
  resetCodexNoDaemonSupportCacheForTests();
  vi.mocked(spawnSync).mockReset();
});

afterEach(() => {
  resetCodexNoDaemonSupportCacheForTests();
  vi.mocked(spawnSync).mockReset();
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('codex --help child env: a CODEX_HOME in a virtual filesystem is not inherited (Issue #4343)', () => {
  // Positive controls: each of these reached the child before the fix.
  const removed: Array<[string, () => string]> = [
    ['absolute /proc', () => PROC_HOME],
    ['absolute /sys', () => '/sys/codex'],
    ['absolute /dev', () => '/dev/codex'],
    ['absolute symlink into /dev', () => join(devLink, 'codex')],
    ['relative value reaching /proc', () => relative(process.cwd(), '/proc/self/codex')],
    ['relative value through a symlink into /dev', () => relative(process.cwd(), join(devLink, 'codex'))],
  ];

  it.each(removed)('%s: the spawned env has no CODEX_HOME', (_label, value) => {
    const codexHome = value();
    process.env.CODEX_HOME = codexHome;
    process.env.CM_AUTH_TOKEN = 'secret-token';
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: HELP_WITH_FLAG }));

    codexSupportsNoDaemon('/opt/codex');

    const env = lastSpawnEnv();
    expect(env).not.toHaveProperty('CODEX_HOME');
    // The rest of the sanitiser still applies, and the parent is untouched.
    expect(env).not.toHaveProperty('CM_AUTH_TOKEN');
    expect(env).toHaveProperty('PATH');
    expect(process.env.CODEX_HOME).toBe(codexHome);
    expect(process.env.CM_AUTH_TOKEN).toBe('secret-token');
  });

  it.each(removed)('%s: buildCodexHelpProbeEnv drops it and leaves process.env alone', (_label, value) => {
    const codexHome = value();
    process.env.CODEX_HOME = codexHome;
    const env = buildCodexHelpProbeEnv();
    expect(env).not.toHaveProperty('CODEX_HOME');
    expect(env).not.toBe(process.env);
    expect(process.env.CODEX_HOME).toBe(codexHome);
  });
});

describe('codex --help child env: everything else is passed on unchanged (Issue #4343)', () => {
  // Negative controls: the behaviour before the fix, which must not move.
  const kept: Array<[string, () => string]> = [
    ['a safe absolute directory', () => safeHome],
    ['a safe relative directory', () => relative(process.cwd(), safeHome)],
    ['the empty string', () => ''],
    // Narrow on purpose: /tmp and /var are not virtual filesystems.
    ['a value under /tmp', () => '/tmp/codex-home-4343-not-created'],
    ['a value under /var', () => '/var/codex-home-4343-not-created'],
  ];

  it.each(kept)('%s: CODEX_HOME reaches the child as given', (_label, value) => {
    const codexHome = value();
    process.env.CODEX_HOME = codexHome;
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: HELP_WITH_FLAG }));

    expect(codexSupportsNoDaemon('/opt/codex')).toBe(true);

    expect(lastSpawnEnv().CODEX_HOME).toBe(codexHome);
    expect(process.env.CODEX_HOME).toBe(codexHome);
  });

  it('unset stays unset', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: HELP_WITH_FLAG }));
    codexSupportsNoDaemon('/opt/codex');
    expect(lastSpawnEnv()).not.toHaveProperty('CODEX_HOME');
  });

  it('CLAUDE_CONFIG_DIR is kept, alongside a removed CODEX_HOME', () => {
    process.env.CODEX_HOME = PROC_HOME;
    process.env.CLAUDE_CONFIG_DIR = safeHome;
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: HELP_WITH_FLAG }));
    codexSupportsNoDaemon('/opt/codex');
    const env = lastSpawnEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBe(safeHome);
    expect(env).not.toHaveProperty('CODEX_HOME');
  });

  it('keeps the bounded `--help` call and false on failure', () => {
    process.env.CODEX_HOME = PROC_HOME;
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 2, stdout: HELP_WITH_FLAG }));
    expect(codexSupportsNoDaemon('/opt/codex')).toBe(false);
    const [command, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe('/opt/codex');
    expect(args).toEqual(['--help']);
    expect(options).toMatchObject({ encoding: 'utf8', timeout: 5000 });
  });
});

describe('the launch line follows the probe (Issue #4343)', () => {
  /** A launch plan whose hooks are written to `safeHome`, never the real ~/.codex. */
  const plan = (options: { supportsNoDaemon?: boolean } = {}) =>
    buildCodexLaunchPlan('/opt/codex/bin/codex', TARGET, { codexHome: safeHome, ...options });

  it('cache empty, server CODEX_HOME in /proc: the probe succeeds and --no-daemon is on', () => {
    process.env.CODEX_HOME = PROC_HOME;
    scriptHelpThatFailsUnderVirtualHome();

    const launch = plan();

    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
    expect(lastSpawnEnv()).not.toHaveProperty('CODEX_HOME');
    expect(launch.command).toBe(
      `'/opt/codex/bin/codex' ${CODEX_EMBEDDED_MODE_ARGS} ${CODEX_NO_DAEMON_FLAG}`
    );
    // The launched codex is pinned to the home the hooks were written to.
    expect(launch.env.CODEX_HOME).toBe(safeHome);
  });

  it('cache empty, relative CODEX_HOME through a symlink into /dev: --no-daemon is on', () => {
    process.env.CODEX_HOME = relative(process.cwd(), join(devLink, 'codex'));
    scriptHelpThatFailsUnderVirtualHome();

    expect(plan().command).toContain(CODEX_NO_DAEMON_FLAG);
    expect(lastSpawnEnv()).not.toHaveProperty('CODEX_HOME');
  });

  it('cache empty, safe CODEX_HOME: unchanged — --no-daemon on, CODEX_HOME passed', () => {
    process.env.CODEX_HOME = safeHome;
    scriptHelpThatFailsUnderVirtualHome();

    expect(plan().command).toContain(CODEX_NO_DAEMON_FLAG);
    expect(lastSpawnEnv().CODEX_HOME).toBe(safeHome);
  });

  it('cache empty, help fails for another reason: false, no --no-daemon (unchanged)', () => {
    process.env.CODEX_HOME = PROC_HOME;
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 1 }));

    expect(plan().command).toBe(`'/opt/codex/bin/codex' ${CODEX_EMBEDDED_MODE_ARGS}`);
  });

  it('true already stored: no child is spawned, whatever CODEX_HOME is now', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: HELP_WITH_FLAG }));
    expect(codexSupportsNoDaemon('/opt/codex/bin/codex')).toBe(true);
    vi.mocked(spawnSync).mockClear();

    process.env.CODEX_HOME = PROC_HOME;
    expect(plan().command).toContain(CODEX_NO_DAEMON_FLAG);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it('false already stored: not asked again in this process, even once the env would pass (known limit)', () => {
    // The cache is keyed by executable path only. A false learned while the
    // child's environment was the cause stays false until the process restarts.
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 1 }));
    expect(codexSupportsNoDaemon('/opt/codex/bin/codex')).toBe(false);
    vi.mocked(spawnSync).mockClear();

    process.env.CODEX_HOME = safeHome;
    scriptHelpThatFailsUnderVirtualHome();
    expect(plan().command).not.toContain(CODEX_NO_DAEMON_FLAG);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it('an explicit supportsNoDaemon still overrides the probe and spawns nothing', () => {
    process.env.CODEX_HOME = PROC_HOME;
    expect(plan({ supportsNoDaemon: false }).command).not.toContain(CODEX_NO_DAEMON_FLAG);
    expect(plan({ supportsNoDaemon: true }).command).toContain(CODEX_NO_DAEMON_FLAG);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});
