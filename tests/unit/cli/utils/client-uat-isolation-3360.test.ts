/**
 * Issue #3360: a UAT / daily-check CLI (`CM_UAT_ISOLATION=1`) reads no `.env` and never
 * falls back to the default port 3000, which is the user's production server.
 *
 * Measured while writing this Issue: a CLI with no `CM_PORT` exported and no `.env` dialled
 * 3000 and listed production's worktrees. Real dotenv and a real file on disk, as in
 * server-url.test.ts — mocking dotenv would assert our own assumption about it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const envSetup = vi.hoisted(() => ({ getEnvPath: vi.fn() }));

vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: envSetup.getEnvPath,
}));

import { loadClientEnv } from '../../../../src/cli/utils/server-url';
import { ApiClient, ApiError } from '../../../../src/cli/utils/api-client';
import { ExitCode } from '../../../../src/cli/types';
import { UAT_ISOLATION_ENV_VAR } from '../../../../src/config/uat-isolation';
import { removeTempDir } from '@tests/helpers/temp-dir';

const MANAGED = [UAT_ISOLATION_ENV_VAR, 'CM_PORT', 'CM_BIND', 'CM_AUTH_TOKEN'] as const;

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const k of MANAGED) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'client-uat-iso-'));
  envPath = join(dir, '.env');
  // The production .env a global CLI would read: it names the production port.
  writeFileSync(envPath, 'CM_PORT=3996\nCM_BIND=127.0.0.1\n');
  envSetup.getEnvPath.mockReset();
  envSetup.getEnvPath.mockReturnValue(envPath);
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  removeTempDir(dir);
});

describe('loadClientEnv under CM_UAT_ISOLATION=1', () => {
  it('does not read the .env file at all', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    const env = loadClientEnv();

    expect(env.CM_PORT).toBeUndefined();
    expect(envSetup.getEnvPath).not.toHaveBeenCalled();
  });

  it('negative control: unset, the .env port is used as before', () => {
    expect(loadClientEnv().CM_PORT).toBe('3996');
  });
});

describe('ApiClient under CM_UAT_ISOLATION=1', () => {
  it('refuses to fall back to port 3000 when CM_PORT is not exported', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    let thrown: unknown;
    try {
      new ApiClient();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect((thrown as ApiError).message).toContain('CM_PORT');
  });

  it('dials only the exported CM_PORT, ignoring the .env', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    process.env.CM_PORT = '3017';

    expect(new ApiClient().serverUrl).toBe('http://127.0.0.1:3017');
  });

  it('an explicit baseUrl needs no CM_PORT', () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    expect(new ApiClient({ baseUrl: 'http://127.0.0.1:3018' }).serverUrl).toBe(
      'http://127.0.0.1:3018'
    );
  });

  it('negative control: unset, the .env port is dialled as before', () => {
    expect(new ApiClient().serverUrl).toBe('http://127.0.0.1:3996');
  });
});
