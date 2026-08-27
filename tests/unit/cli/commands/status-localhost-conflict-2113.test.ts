/**
 * `commandmate status` surfaces the startup localhost self-check (Issue #2113)
 *
 * Acceptance condition from the Issue: with another process on `::1:<port>` the warning
 * must reach BOTH the server log and `commandmate status`. The server side is covered by
 * tests/unit/lib/localhost-self-check-2113.test.ts and the integration test; this file
 * pins the `status` half — including the negative control (no record -> no warning) and
 * the staleness guard that keeps a previous server's record from being reported as this
 * server's.
 *
 * The staleness guard is `startedAt`, not the PID, and the test below pins that on
 * purpose. A live daemon run on 2026-08-27 showed the state file holding 58882
 * (`npm run start`) while the record held 58937 (`node dist/server/server.js`, the process
 * that actually binds the port): a PID comparison silently suppressed every warning.
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
  readPackageVersion: vi.fn(() => '0.27.1'),
}));
// The detector-freshness probe shells out to every installed agent CLI; irrelevant here.
vi.mock('../../../../src/lib/detection/version-probes', () => ({
  getDetectorFreshness: vi.fn(async () => []),
}));
// Only the reader is stubbed: the warning text itself stays real, so this test fails if
// the message ever stops naming the other process.
vi.mock('../../../../src/lib/server/localhost-self-check', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/lib/server/localhost-self-check')>();
  return { ...actual, readLocalhostConflict: vi.fn(() => null) };
});

import { statusCommand } from '../../../../src/cli/commands/status';
import { readLocalhostConflict } from '../../../../src/lib/server/localhost-self-check';

const PID = 12345;
const PORT = 3000;

/** A hybrid-format state file (#1632) for a running daemon on PORT */
const STARTED_AT = '2026-08-27T09:00:00.000Z';

const STATE_FILE = `${PID}\n${JSON.stringify({
  pid: PID,
  version: '0.27.1',
  port: PORT,
  bind: '127.0.0.1',
  protocol: 'http',
  auth: false,
  startedAt: STARTED_AT,
})}\n`;

const CONFLICT = {
  port: PORT,
  // The listening process, which is NOT the PID the state file records (see header).
  pid: PID + 55,
  bind: '127.0.0.1',
  boundUrl: 'http://127.0.0.1:3000',
  probedUrl: 'http://localhost:3000',
  detectedAt: '2026-08-27T09:15:00.000Z',
};

describe('statusCommand localhost conflict (Issue #2113)', () => {
  let output: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    output = [];
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(STATE_FILE);
    vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });
    vi.mocked(readLocalhostConflict).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the warning when the running server recorded a conflict', async () => {
    vi.mocked(readLocalhostConflict).mockReturnValue(CONFLICT);

    await statusCommand();

    const text = output.join('\n');
    expect(vi.mocked(readLocalhostConflict)).toHaveBeenCalledWith(PORT);
    expect(text).toContain('Another process is answering on http://localhost:3000');
    expect(text).toContain('NOT this CommandMate server');
    expect(text).toContain('http://127.0.0.1:3000');
    expect(text).toContain('lsof -nP -iTCP:3000 -sTCP:LISTEN');
    expect(text).toContain(CONFLICT.detectedAt);
  });

  it('stays silent in the normal case (negative control)', async () => {
    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('Status:  Running');
    expect(text).not.toContain('Another process is answering');
  });

  it('ignores a record written before the running daemon was launched', async () => {
    vi.mocked(readLocalhostConflict).mockReturnValue({
      ...CONFLICT,
      detectedAt: '2026-08-26T09:00:00.000Z',
    });

    await statusCommand();

    expect(output.join('\n')).not.toContain('Another process is answering');
  });

  it('does NOT use the PID as the staleness guard', async () => {
    // Regression guard for the live finding: `daemon.start()` spawns `npm run start`, so
    // the state file's PID is the wrapper's and can never equal the listener's. Reviving a
    // PID comparison here would make this pass silently in tests and warn nobody in
    // production, which is exactly what happened on 2026-08-27.
    vi.mocked(readLocalhostConflict).mockReturnValue({ ...CONFLICT, pid: PID + 55 });

    await statusCommand();

    expect(output.join('\n')).toContain('Another process is answering');
  });

  it('reports a record on a legacy state file that has no startedAt', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(String(PID));
    vi.mocked(readLocalhostConflict).mockReturnValue(CONFLICT);

    await statusCommand();

    expect(output.join('\n')).toContain('Another process is answering');
  });

  it('still reports the server when reading the record throws', async () => {
    vi.mocked(readLocalhostConflict).mockImplementation(() => {
      throw new Error('config dir unreadable');
    });

    await statusCommand();

    const text = output.join('\n');
    expect(text).toContain('Status:  Running');
    expect(text).not.toContain('Another process is answering');
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(0);
  });

  it('does not look for a record when the server is not running', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    await statusCommand();

    expect(vi.mocked(readLocalhostConflict)).not.toHaveBeenCalled();
  });

  it('reports it for a worktree server too (--all)', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['135.pid'] as never);
    vi.mocked(readLocalhostConflict).mockReturnValue(CONFLICT);

    await statusCommand({ all: true });

    const occurrences = output
      .join('\n')
      .split('Another process is answering').length - 1;
    // Main server + the Issue #135 worktree server, both reading the same mocked state.
    expect(occurrences).toBe(2);
  });
});
