/**
 * Issue #4480: `commandmate init` / `quickstart`'s dependency check runs
 * `agy --version` only with the usage declaration.
 *
 * #4452 decided that a path the user did not aim at antigravity does not start
 * agy (`mayProbeToolVersion`). The preflight was left out: it ran
 * `agy --version` on every `init` and `quickstart`. Now, without the declaration
 * (`CM_ANTIGRAVITY_USAGE=api-key|enterprise`, from the shell, else from the
 * server's `.env`), agy is looked up on `PATH` through the file system only — no
 * child process — and reported found (version not checked) or missing. Every
 * other dependency is checked as before.
 *
 * The child processes here are real, of FAKE binaries (tests/helpers/fake-agy-path.ts):
 * `PATH` holds only a private directory whose `agy` / `claude` / `codex` record
 * their argv, and `HOME` is private. The install is treated as global, so the
 * `.env` the check reads is `<private HOME>/.commandmate/.env`, never the
 * repository's.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { installFakeAgyPath, type FakeAgyPath } from '@tests/helpers/fake-agy-path';

vi.mock('@/cli/utils/install-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/cli/utils/install-context')>()),
  isGlobalInstall: () => true,
}));

import { PreflightChecker } from '@/cli/utils/preflight';
import { runInit } from '@/cli/commands/init';

let fake: FakeAgyPath;

beforeEach(() => {
  fake = installFakeAgyPath();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fake.restore();
});

function agyRow(results: { name: string; status: string; version?: string }[]) {
  return results.find((row) => row.name === 'Antigravity CLI');
}

function writeServerEnv(lines: string): void {
  const dir = path.join(fake.root, 'home', '.commandmate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), lines);
}

describe('[#4480] preflight and agy', () => {
  it('4480 (I3): without the declaration, checkAll runs agy 0 times and reports it found but not checked', async () => {
    const result = await new PreflightChecker().checkAll();

    expect(fake.callsOf('agy')).toEqual([]);
    expect(agyRow(result.results)).toEqual({ name: 'Antigravity CLI', status: 'not_checked' });
  });

  it('4480 (I3): without the declaration and no agy on PATH, it is missing (still 0 runs)', async () => {
    fs.rmSync(path.join(fake.root, 'bin', 'agy'));

    const result = await new PreflightChecker().checkAll();

    expect(agyRow(result.results)).toEqual({ name: 'Antigravity CLI', status: 'missing' });
    expect(fake.callsOf('agy')).toEqual([]);
  });

  it.each(['API-KEY', 'yes', 'true', 'personal', ''])(
    '4480 (I3): an invalid declaration %j is no declaration (agy 0 runs)',
    async (value) => {
      vi.stubEnv('CM_ANTIGRAVITY_USAGE', value);
      await new PreflightChecker().checkAll();
      expect(fake.callsOf('agy')).toEqual([]);
    },
  );

  it.each(['api-key', 'enterprise'])(
    '4480 (I3): with CM_ANTIGRAVITY_USAGE=%s, checkAll runs agy --version once and reports its version',
    async (value) => {
      vi.stubEnv('CM_ANTIGRAVITY_USAGE', value);

      const result = await new PreflightChecker().checkAll();

      expect(fake.callsOf('agy')).toEqual(['agy --version']);
      expect(agyRow(result.results)).toEqual({ name: 'Antigravity CLI', status: 'ok', version: '1.1.18' });
    },
  );

  it('4480 (I3): the declaration in the server .env counts when the shell has none (agy once)', async () => {
    writeServerEnv('CM_ANTIGRAVITY_USAGE=api-key\n');

    const result = await new PreflightChecker().checkAll();

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(agyRow(result.results)?.status).toBe('ok');
  });

  it('4480 (I3): the shell outranks the server .env (shell personal, .env api-key → agy 0 runs)', async () => {
    writeServerEnv('CM_ANTIGRAVITY_USAGE=api-key\n');
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'personal');

    await new PreflightChecker().checkAll();

    expect(fake.callsOf('agy')).toEqual([]);
  });

  it('4480: claude and codex are still run once each with --version', async () => {
    const result = await new PreflightChecker().checkAll();

    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
    expect(result.results.find((row) => row.name === 'Claude CLI')).toMatchObject({ status: 'ok' });
    // Not on the private PATH: still reported missing, as before.
    expect(result.results.find((row) => row.name === 'tmux')).toEqual({ name: 'tmux', status: 'missing' });
  });

  it('4480 (I3): runInit without the declaration runs agy 0 times', async () => {
    // node / tmux / git are not on the private PATH, so init stops at its
    // dependency check (exit DEPENDENCY_ERROR) without writing a .env.
    const result = await runInit({ defaults: true });

    expect(result.ok).toBe(false);
    expect(fake.callsOf('agy')).toEqual([]);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
  });
});
