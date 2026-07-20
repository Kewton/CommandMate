/**
 * npx-runner tests
 * Issue #1395: npx GUI self-update — warmup/version fetch, daemon relaunch, env hygiene.
 *
 * MF-SEC-1 parity with npm-runner: every command uses spawnSync with array args
 * (never a shell string). Seams are module-level vi.mock (D-9), mirroring
 * update.test.ts: the real npx-runner runs on top of a mocked child_process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';
import { homedir } from 'os';

vi.mock('child_process');

import {
  warmNpxLatest,
  spawnNpxDaemon,
  sanitizeNpxEnv,
  stableNpxCwd,
  NPX_WARMUP_TIMEOUT_MS,
} from '../../../../src/cli/utils/npx-runner';

const PACKAGE_NAME = 'commandmate';

let logs: string[];

/** Build a spawnSync result (mirrors update.test.ts) */
function spawnResult(
  overrides: Partial<childProcess.SpawnSyncReturns<string>>
): childProcess.SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as childProcess.SpawnSyncReturns<string>;
}

/** Point spawnSync at a single canned result. */
function mockSpawn(result: childProcess.SpawnSyncReturns<string>): void {
  vi.mocked(childProcess.spawnSync).mockReturnValue(
    result as unknown as ReturnType<typeof childProcess.spawnSync>
  );
}

/** The args passed to the most recent spawnSync call. */
function lastArgs(): string[] {
  const calls = vi.mocked(childProcess.spawnSync).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

/** The options passed to the most recent spawnSync call. */
function lastOptions(): childProcess.SpawnSyncOptions {
  const calls = vi.mocked(childProcess.spawnSync).mock.calls;
  return calls[calls.length - 1][2] as childProcess.SpawnSyncOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

describe('sanitizeNpxEnv', () => {
  it('strips npm_config_* / npm_lifecycle_* so a leaked npm env cannot skew npx resolution', () => {
    const sanitized = sanitizeNpxEnv({
      npm_config_registry: 'http://evil.example/',
      npm_config_cache: '/tmp/old-cache',
      npm_lifecycle_event: 'start',
      npm_lifecycle_script: 'next start',
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CM_AUTH_TOKEN_HASH: 'abc',
      CM_PORT: '3000',
    });

    expect(sanitized.npm_config_registry).toBeUndefined();
    expect(sanitized.npm_config_cache).toBeUndefined();
    expect(sanitized.npm_lifecycle_event).toBeUndefined();
    expect(sanitized.npm_lifecycle_script).toBeUndefined();
  });

  it('also strips other npm_* runtime vars (npm_package_*, npm_command, npm_execpath)', () => {
    const sanitized = sanitizeNpxEnv({
      npm_package_name: 'commandmate',
      npm_command: 'run-script',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      KEEP: 'yes',
    });

    expect(sanitized.npm_package_name).toBeUndefined();
    expect(sanitized.npm_command).toBeUndefined();
    expect(sanitized.npm_execpath).toBeUndefined();
    expect(sanitized.KEEP).toBe('yes');
  });

  it('passes CM_* and PATH through untouched (config continuity; PATH left intact to locate npx)', () => {
    const sanitized = sanitizeNpxEnv({
      CM_AUTH_TOKEN_HASH: 'abc',
      CM_PORT: '3000',
      CM_BIND: '127.0.0.1',
      PATH: '/usr/local/bin:/usr/bin',
    });

    expect(sanitized.CM_AUTH_TOKEN_HASH).toBe('abc');
    expect(sanitized.CM_PORT).toBe('3000');
    expect(sanitized.CM_BIND).toBe('127.0.0.1');
    expect(sanitized.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('does not mutate the input env (returns a fresh object)', () => {
    const input = { npm_config_registry: 'http://x/', KEEP: '1' };
    const sanitized = sanitizeNpxEnv(input);

    expect(input.npm_config_registry).toBe('http://x/');
    expect(sanitized).not.toBe(input);
  });

  it('defaults to process.env when no env is given', () => {
    const original = process.env.npm_config_registry;
    process.env.npm_config_registry = 'http://leak/';
    try {
      const sanitized = sanitizeNpxEnv();
      expect(sanitized.npm_config_registry).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = original;
    }
  });
});

describe('stableNpxCwd (Issue #1410)', () => {
  it('returns an absolute home directory (never the npx cache package dir)', () => {
    const cwd = stableNpxCwd();
    expect(cwd).toBe(homedir());
    expect(cwd).not.toMatch(/_npx/);
  });
});

describe('warmNpxLatest', () => {
  it('invokes `npx --yes <pkg>@latest --version` with array argv and no shell', () => {
    mockSpawn(spawnResult({ stdout: '0.10.4\n', status: 0 }));

    warmNpxLatest(PACKAGE_NAME);

    const call = vi.mocked(childProcess.spawnSync).mock.calls[0];
    expect(call[0]).toBe('npx');
    expect(call[1]).toEqual(['--yes', `${PACKAGE_NAME}@latest`, '--version']);
    expect(lastOptions()).not.toHaveProperty('shell', true);
  });

  it('runs with a sanitized env and a dedicated warmup timeout', () => {
    mockSpawn(spawnResult({ stdout: '0.10.4\n', status: 0 }));

    warmNpxLatest(PACKAGE_NAME);

    const options = lastOptions();
    expect(options.timeout).toBe(NPX_WARMUP_TIMEOUT_MS);
    // env must be present and must not carry npm_config_* through.
    const env = options.env as NodeJS.ProcessEnv;
    expect(env).toBeDefined();
    expect(Object.keys(env).some((k) => /^npm_/i.test(k))).toBe(false);
  });

  it('runs from a stable cwd (home dir) so npx cache churn cannot invalidate process.cwd() — Issue #1410', () => {
    mockSpawn(spawnResult({ stdout: '0.10.4\n', status: 0 }));

    warmNpxLatest(PACKAGE_NAME);

    // The inherited cwd would be the npx cache package dir, which npx deletes
    // while fetching; an absolute stable cwd keeps the child's process.cwd() valid.
    expect(lastOptions().cwd).toBe(homedir());
  });

  it('keeps the warmup timeout comfortably under the GUI 5-minute timeout', () => {
    // A stalled download must abort (downtime 0) and log before the banner times out.
    expect(NPX_WARMUP_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000);
  });

  it('returns the parsed version on success', () => {
    mockSpawn(spawnResult({ stdout: '0.10.4\n', status: 0 }));

    expect(warmNpxLatest(PACKAGE_NAME)).toEqual({ success: true, version: '0.10.4' });
  });

  it('extracts the version even when npx prints extra noise around it', () => {
    mockSpawn(spawnResult({ stdout: 'npm notice\n0.11.0\n', status: 0 }));

    expect(warmNpxLatest(PACKAGE_NAME)).toMatchObject({ success: true, version: '0.11.0' });
  });

  it('fails when npx is not installed (ENOENT)', () => {
    mockSpawn(
      spawnResult({
        status: null,
        error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
      })
    );

    const result = warmNpxLatest(PACKAGE_NAME);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/npx/i);
  });

  it('fails on a warmup timeout (spawnSync error)', () => {
    mockSpawn(
      spawnResult({
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      })
    );

    expect(warmNpxLatest(PACKAGE_NAME).success).toBe(false);
  });

  it('fails on a non-zero exit and surfaces stderr', () => {
    mockSpawn(spawnResult({ status: 1, stderr: 'network error' }));

    const result = warmNpxLatest(PACKAGE_NAME);
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
  });

  it('fails when the output has no parseable version', () => {
    mockSpawn(spawnResult({ status: 0, stdout: 'not a version\n' }));

    expect(warmNpxLatest(PACKAGE_NAME).success).toBe(false);
  });
});

describe('spawnNpxDaemon', () => {
  it('invokes `npx --yes <pkg>@latest start --daemon` with array argv and no shell', () => {
    mockSpawn(spawnResult({ status: 0 }));

    spawnNpxDaemon(PACKAGE_NAME);

    expect(lastArgs()).toEqual(['--yes', `${PACKAGE_NAME}@latest`, 'start', '--daemon']);
    expect(lastOptions()).not.toHaveProperty('shell', true);
  });

  it('runs with a sanitized env (no npm_* leakage into the relaunch)', () => {
    mockSpawn(spawnResult({ status: 0 }));

    spawnNpxDaemon(PACKAGE_NAME);

    const env = lastOptions().env as NodeJS.ProcessEnv;
    expect(Object.keys(env).some((k) => /^npm_/i.test(k))).toBe(false);
  });

  it('runs from a stable cwd (home dir) so a deleted npx cache dir does not crash the relaunch — Issue #1410', () => {
    mockSpawn(spawnResult({ status: 0 }));

    spawnNpxDaemon(PACKAGE_NAME);

    // This is the step that crashed with ENOENT (uv_cwd) when it inherited the
    // (now-deleted) npx cache dir as its cwd; a stable absolute cwd prevents it.
    expect(lastOptions().cwd).toBe(homedir());
  });

  it('reports success when the relaunch exits 0', () => {
    mockSpawn(spawnResult({ status: 0 }));

    expect(spawnNpxDaemon(PACKAGE_NAME)).toMatchObject({ success: true, status: 0 });
  });

  it('reports failure with the exit code when the relaunch fails', () => {
    mockSpawn(spawnResult({ status: 3, stderr: 'start failed' }));

    const result = spawnNpxDaemon(PACKAGE_NAME);
    expect(result.success).toBe(false);
    expect(result.status).toBe(3);
  });

  it('fails when npx is not installed (ENOENT)', () => {
    mockSpawn(
      spawnResult({
        status: null,
        error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
      })
    );

    expect(spawnNpxDaemon(PACKAGE_NAME).success).toBe(false);
  });

  it('echoes the relaunch output so it lands in the update log', () => {
    mockSpawn(spawnResult({ status: 0, stdout: 'server started\n' }));

    spawnNpxDaemon(PACKAGE_NAME);

    expect(logs.join('\n')).toContain('server started');
  });
});
