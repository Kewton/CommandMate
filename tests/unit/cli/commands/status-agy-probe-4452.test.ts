/**
 * Issue #4452: `commandmate status` starts `agy` 0 times without the usage
 * declaration, and still reads the other tools' versions (I2).
 *
 * `status` awaits the detector freshness probe (`getDetectorFreshness`). The probe
 * module is REAL here and runs against the fake agy / claude / codex of
 * tests/helpers/fake-agy-path.ts (private PATH and HOME — the real agy is never
 * run). Only the daemon's pid / .env reads are stubbed so `status` reaches the
 * running-server branch that prints the report; every other fs call is real.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PID_FILE = '/mock-4452/.commandmate/.commandmate.pid';
const ENV_FILE = '/mock-4452/.commandmate/.env';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = (p: import('fs').PathLike): boolean =>
    p === PID_FILE || p === ENV_FILE || actual.existsSync(p);
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (p === PID_FILE) return '12345';
    if (p === ENV_FILE) return 'CM_PORT=3000\n';
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, existsSync, readFileSync, default: { ...actual, existsSync, readFileSync } };
});
vi.mock('dotenv', () => ({ config: vi.fn(() => ({ parsed: { CM_PORT: '3000' } })) }));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getPidFilePath: vi.fn(() => PID_FILE),
  getEnvPath: vi.fn(() => ENV_FILE),
  getPidsDir: vi.fn(() => '/mock-4452/.commandmate/pids'),
}));
vi.mock('../../../../src/cli/utils/package-info', () => ({
  readPackageVersion: vi.fn(() => '0.0.0'),
}));

import { installFakeAgyPath, type FakeAgyPath } from '../../../helpers/fake-agy-path';
import { keepOffTheRealServer } from '../../../helpers/mock-api';
import { statusCommand } from '../../../../src/cli/commands/status';
import { clearDetectorVersionProbeCache } from '../../../../src/lib/detection/version-probes';
import { resetAntigravityUseForTest } from '../../../../src/lib/tool-policy/version-probe-gate';

// No request from this file reaches 127.0.0.1:3000, not even by failing.
keepOffTheRealServer();

let fake: FakeAgyPath;

beforeEach(() => {
  fake = installFakeAgyPath();
  clearDetectorVersionProbeCache();
  resetAntigravityUseForTest();
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearDetectorVersionProbeCache();
  resetAntigravityUseForTest();
  fake.restore();
});

describe('[#4452] commandmate status → detector freshness', () => {
  it('4452: without the declaration, status starts agy 0 times', async () => {
    await statusCommand();

    expect(fake.callsOf('agy')).toEqual([]);
    // I2: the running-server branch did probe the other tools.
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
  });

  it('4452 (I3): with the declaration, status reads agy once', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'enterprise';
    await statusCommand();

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
  });
});
