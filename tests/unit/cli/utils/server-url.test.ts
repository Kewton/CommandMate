/**
 * Server URL Resolution Tests
 * Issue #1266: .env must win over exported variables, because that is the precedence
 * daemon.start() hands the child process that actually serves.
 *
 * loadEffectiveEnv() runs against real dotenv and real .env files on disk: mocking dotenv
 * here would assert our own assumption about the very behaviour under test (dotenv leaves an
 * already-exported variable untouched).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const envSetup = vi.hoisted(() => ({ getEnvPath: vi.fn() }));

vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: envSetup.getEnvPath,
}));

import { resolveServerEndpoint, loadEffectiveEnv } from '../../../../src/cli/utils/server-url';

describe('resolveServerEndpoint', () => {
  it('should default to http://127.0.0.1:3000 when nothing is configured', () => {
    expect(resolveServerEndpoint({})).toEqual({
      port: 3000,
      bind: '127.0.0.1',
      protocol: 'http',
      url: 'http://127.0.0.1:3000',
    });
  });

  it('should use the configured port and bind address', () => {
    const endpoint = resolveServerEndpoint({ CM_PORT: '3101', CM_BIND: '192.168.1.5' });

    expect(endpoint.port).toBe(3101);
    expect(endpoint.url).toBe('http://192.168.1.5:3101');
  });

  it('should report a 0.0.0.0 bind as a dialable 127.0.0.1', () => {
    const endpoint = resolveServerEndpoint({ CM_BIND: '0.0.0.0', CM_PORT: '3101' });

    expect(endpoint.bind).toBe('0.0.0.0');
    expect(endpoint.url).toBe('http://127.0.0.1:3101');
  });

  it('should report https when both cert and key are configured', () => {
    const endpoint = resolveServerEndpoint({
      CM_HTTPS_CERT: '/certs/localhost.pem',
      CM_HTTPS_KEY: '/certs/localhost-key.pem',
    });

    expect(endpoint.protocol).toBe('https');
    expect(endpoint.url).toBe('https://127.0.0.1:3000');
  });

  // server.ts:160 serves HTTPS only when both are present, so a lone cert must stay http
  it('should stay http when a cert is configured without a key', () => {
    const endpoint = resolveServerEndpoint({ CM_HTTPS_CERT: '/certs/localhost.pem' });

    expect(endpoint.protocol).toBe('http');
    expect(endpoint.url).toBe('http://127.0.0.1:3000');
  });
});

describe('loadEffectiveEnv', () => {
  let dir: string;
  let mainEnvPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-1266-'));
    mainEnvPath = join(dir, '.env');
    envSetup.getEnvPath.mockReturnValue(mainEnvPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // The bug: the shell exports CM_PORT=3000, .env says 3101, the server listens on 3101.
  it('should give .env precedence over an exported variable', () => {
    writeFileSync(mainEnvPath, 'CM_PORT=3101\n');
    vi.stubEnv('CM_PORT', '3000');

    expect(loadEffectiveEnv().CM_PORT).toBe('3101');
    expect(resolveServerEndpoint(loadEffectiveEnv()).url).toBe('http://127.0.0.1:3101');
  });

  it('should keep exported variables that .env does not define', () => {
    writeFileSync(mainEnvPath, 'CM_PORT=3101\n');
    vi.stubEnv('CM_BIND', '0.0.0.0');

    expect(loadEffectiveEnv().CM_BIND).toBe('0.0.0.0');
  });

  it('should layer a worktree .env over the main one', () => {
    writeFileSync(mainEnvPath, 'CM_PORT=3101\nCM_BIND=127.0.0.1\n');
    const worktreeEnvPath = join(dir, '135.env');
    writeFileSync(worktreeEnvPath, 'CM_PORT=3135\n');
    vi.stubEnv('CM_PORT', '3000');

    const env = loadEffectiveEnv(worktreeEnvPath);

    expect(env.CM_PORT).toBe('3135');
    // Keys the worktree .env omits still come from the main one
    expect(env.CM_BIND).toBe('127.0.0.1');
  });

  it('should fall back to the main .env when the worktree .env is absent', () => {
    writeFileSync(mainEnvPath, 'CM_PORT=3101\n');
    vi.stubEnv('CM_PORT', '3000');

    expect(loadEffectiveEnv(join(dir, 'missing.env')).CM_PORT).toBe('3101');
  });

  it('should not throw when no .env exists at all', () => {
    vi.stubEnv('CM_PORT', '3000');

    expect(loadEffectiveEnv().CM_PORT).toBe('3000');
  });
});
