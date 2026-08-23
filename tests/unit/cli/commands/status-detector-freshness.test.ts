/**
 * `commandmate status` reports detector staleness (Issue #1929, 方針書 §4 D2).
 *
 * `status` is the second exposure surface the design names — the first is
 * `capture --json`, and both are authenticated by construction (one is a local
 * operator command, the other needs a token). §4 D2 keeps this OFF
 * `GET /api/capabilities` because an installed-CLI version list is a software
 * inventory (DR4-008).
 *
 * The rule this file pins is a *display* rule, not a probe rule: `status` is a
 * one-off, so unlike the polling path it MAY await the probes — but it must stay
 * silent when there is nothing to act on, and it must never turn a probe failure
 * into a failed status command.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

vi.mock('fs');
vi.mock('dotenv');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getPidFilePath: vi.fn(() => '/mock/home/.commandmate/.commandmate.pid'),
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
  getPidsDir: vi.fn(() => '/mock/home/.commandmate/pids'),
}));
vi.mock('../../../../src/cli/utils/package-info', () => ({
  readPackageVersion: vi.fn(() => '0.26.1'),
}));

const getDetectorFreshness = vi.fn();
vi.mock('../../../../src/lib/detection/version-probes', () => ({
  getDetectorFreshness: () => getDetectorFreshness(),
}));

import { statusCommand } from '../../../../src/cli/commands/status';

/** A running daemon, so status reaches the branch that prints the report. */
function stubRunningServer(): void {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue('12345');
  vi.mocked(dotenv.config).mockReturnValue({ parsed: { CM_PORT: '3000' } });
  vi.spyOn(process, 'kill').mockImplementation(() => true);
}

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubRunningServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#1929] commandmate status → detector freshness', () => {
  it('names every tool whose installed build is newer than its rules', async () => {
    getDetectorFreshness.mockResolvedValue([
      { tool: 'antigravity', installed: '1.1.18', verifiedAgainst: '0.4.x', stale: true },
      { tool: 'claude', installed: '2.1.240', verifiedAgainst: '2.1.240', stale: false },
      { tool: 'gemini', installed: '0.55.1', verifiedAgainst: 'unmeasured', stale: false },
    ]);

    await statusCommand();

    const output = logged.join('\n');
    expect(output).toContain('Detector rules verified against an older CLI:');
    expect(output).toContain('antigravity: installed 1.1.18, rules read off 0.4.x');
    // Fresh and unmeasured tools are not skew, so they are not nagged about.
    expect(output).not.toContain('claude: installed');
    expect(output).not.toContain('gemini: installed');
  });

  it('prints nothing at all when every detector matches its CLI', async () => {
    getDetectorFreshness.mockResolvedValue([
      { tool: 'claude', installed: '2.1.240', verifiedAgainst: '2.1.240', stale: false },
    ]);

    await statusCommand();

    expect(logged.join('\n')).not.toContain('Detector');
  });

  it('prints nothing when no CLI is installed — a skipped probe is not a skew', async () => {
    getDetectorFreshness.mockResolvedValue([
      { tool: 'claude', installed: null, verifiedAgainst: '2.1.240', stale: false },
      { tool: 'copilot', installed: null, verifiedAgainst: '1.0.80', stale: false },
    ]);

    await statusCommand();

    expect(logged.join('\n')).not.toContain('Detector');
  });

  it('still reports server status when the probe throws', async () => {
    getDetectorFreshness.mockRejectedValue(new Error('probe exploded'));

    await statusCommand();

    const output = logged.join('\n');
    expect(output).toContain('Status:  Running');
    expect(output).not.toContain('Detector');
  });

  it('does not probe at all when the server is not running', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await statusCommand();

    expect(
      getDetectorFreshness,
      'a stopped server has no detector to be stale'
    ).not.toHaveBeenCalled();
  });
});
