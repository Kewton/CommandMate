/**
 * A graceful shutdown writes down which Auto-Yes grants it released, and the
 * next start shows them as off with `stopReason: 'server-restart'` — without
 * restoring a single grant (Issue #3730).
 *
 * Real state, real pollers (timers faked so nothing polls a pane) and a real
 * record file under a `mkdtemp` directory removed after every test. The
 * "restart" is the module-level state being cleared between the record and the
 * restore, which is everything a new process starts without.
 *
 * Positive controls: before #3730 there was no record and no `server-restart`
 * reason, so every assertion that reads one fails on the old implementation.
 * Negative controls: never-armed, manually disabled and expired grants, and a
 * missing / broken / unreadable record, all read exactly as before — off, with
 * no reason.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_YES_SHUTDOWN_RECORD_PATH_ENV,
  AUTO_YES_SHUTDOWN_RECORD_SUFFIX,
  recordAutoYesShutdown,
  resolveAutoYesShutdownRecordPath,
  restoreAutoYesShutdownRecord,
} from '@/lib/auto-yes-shutdown-record';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  collectReleasedAutoYesGrants,
  disableAutoYes,
  getAutoYesState,
  getRestartReleasedAutoYesByWorktree,
  getEnabledAutoYesByWorktree,
  isAutoYesShutdownStarted,
  resetAutoYesShutdownForTesting,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import {
  clearAllPollerStates,
  getActivePollerCount,
  isPollerActive,
  startAutoYesPolling,
} from '@/lib/auto-yes-poller';
import { releaseAutoYes } from '@/lib/auto-yes-lifecycle';

const T0 = 1_800_000_000_000;
const ONE_HOUR = 3_600_000 as const;
const THREE_HOURS = 10_800_000 as const;
const WT = 'wt-3730-a';
const OTHER = 'wt-3730-b';

let dir: string;
let recordPath: string;

/** Everything a fresh process starts without. */
function simulateNewProcess(): void {
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
}

/** The shutdown `server.ts` runs: record, then release every poller. */
function gracefulShutdown(now: number = Date.now()): ReturnType<typeof recordAutoYesShutdown> {
  const result = recordAutoYesShutdown({ path: recordPath, now });
  releaseAutoYes('server-shutdown', { scope: 'all' });
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-shutdown-3730-'));
  recordPath = path.join(dir, `cm.db${AUTO_YES_SHUTDOWN_RECORD_SUFFIX}`);
  simulateNewProcess();
});

afterEach(() => {
  simulateNewProcess();
  vi.useRealTimers();
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // already gone
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what a shutdown records (Issue #3730)', () => {
  it('records enabled grants with time left — primary, alias, and one whose poller never started', () => {
    setAutoYesEnabled(WT, 'claude', true, THREE_HOURS);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR, undefined, 'claude-2');
    expect(startAutoYesPolling(WT, 'claude', 'claude-2').started).toBe(true);
    // Armed, no poller (send --auto-yes arms before the session starts).
    setAutoYesEnabled(OTHER, 'codex', true, ONE_HOUR);
    expect(isPollerActive(buildCompositeKey(OTHER, 'codex'))).toBe(false);

    const result = gracefulShutdown();

    expect(result).toEqual({ recorded: 3 });
    const written = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.grants).toEqual(
      expect.arrayContaining([
        { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', enabledAt: T0, expiresAt: T0 + THREE_HOURS },
        { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2', enabledAt: T0, expiresAt: T0 + ONE_HOUR },
        { worktreeId: OTHER, cliToolId: 'codex', instanceId: 'codex', enabledAt: T0, expiresAt: T0 + ONE_HOUR },
      ]),
    );
    expect(written.grants).toHaveLength(3);
  });

  it('negative control: never-armed, manually disabled and expired grants are not recorded', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    setAutoYesEnabled(WT, 'claude', false); // manual OFF
    setAutoYesEnabled(WT, 'codex', true, ONE_HOUR);
    vi.setSystemTime(T0 + ONE_HOUR); // codex's grant runs out exactly now
    setAutoYesEnabled(OTHER, 'claude', true, ONE_HOUR);
    disableAutoYes(OTHER, 'claude', 'stop_pattern_matched');

    expect(collectReleasedAutoYesGrants(Date.now())).toEqual([]);
    expect(gracefulShutdown()).toEqual({ recorded: 0 });
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('writes the record 0600, by rename, leaving no temp file beside it', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    gracefulShutdown();

    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([path.basename(recordPath)]);
  });

  it('removes a leftover record when there is nothing to record', () => {
    fs.writeFileSync(recordPath, '{"stale":true}');
    gracefulShutdown();
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('a record that cannot be written costs the record, not the shutdown', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    startAutoYesPolling(WT, 'claude');
    fs.chmodSync(dir, 0o500);

    const result = gracefulShutdown();

    expect(result.recorded).toBe(0);
    expect(result.error).toBeDefined();
    // The pollers still stopped: recording never throws into the shutdown.
    expect(getActivePollerCount()).toBe(0);
    expect(isAutoYesShutdownStarted()).toBe(true);
  });

  it('the generic stop-all and test reset write nothing (only the server records)', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    startAutoYesPolling(WT, 'claude');
    releaseAutoYes('server-shutdown', { scope: 'all' });
    clearAllPollerStates();

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(isAutoYesShutdownStarted()).toBe(false);
  });
});

describe('what the next start shows (Issue #3730)', () => {
  it('seeds a disabled state with stopReason server-restart and starts no poller', () => {
    setAutoYesEnabled(WT, 'claude', true, THREE_HOURS);
    startAutoYesPolling(WT, 'claude');
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR, undefined, 'claude-2');
    gracefulShutdown();

    simulateNewProcess();
    vi.setSystemTime(T0 + 60_000);
    const result = restoreAutoYesShutdownRecord({ path: recordPath });

    expect(result).toEqual({ seeded: 2, skipped: 0 });
    const primary = getAutoYesState(WT, 'claude');
    expect(primary).toMatchObject({ enabled: false, stopReason: 'server-restart', expiresAt: T0 + THREE_HOURS });
    expect(getAutoYesState(WT, 'claude', 'claude-2')?.stopReason).toBe('server-restart');
    // The grant is NOT restored: nothing polls, nothing is armed.
    expect(getActivePollerCount()).toBe(0);
    expect(getEnabledAutoYesByWorktree().size).toBe(0);
    expect(startAutoYesPolling(WT, 'claude')).toEqual({ started: false, reason: 'auto-yes not enabled' });
    // The record is consumed.
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(getRestartReleasedAutoYesByWorktree().get(WT)).toEqual({
      claude: 'server-restart',
      'claude-2': 'server-restart',
    });
  });

  it('negative control: an instance that was off before the stop gets no restart reason', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    setAutoYesEnabled(WT, 'codex', true, ONE_HOUR);
    setAutoYesEnabled(WT, 'codex', false);
    gracefulShutdown();

    simulateNewProcess();
    restoreAutoYesShutdownRecord({ path: recordPath });

    expect(getAutoYesState(WT, 'claude')?.stopReason).toBe('server-restart');
    expect(getAutoYesState(WT, 'codex')).toBeNull();
    expect(getAutoYesState(OTHER, 'claude')).toBeNull();
  });

  it('skips a grant whose deadline passed while the server was down', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    setAutoYesEnabled(WT, 'codex', true, THREE_HOURS);
    gracefulShutdown();

    simulateNewProcess();
    vi.setSystemTime(T0 + 2 * ONE_HOUR);
    expect(restoreAutoYesShutdownRecord({ path: recordPath })).toEqual({ seeded: 1, skipped: 1 });
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    expect(getAutoYesState(WT, 'codex')?.stopReason).toBe('server-restart');
  });

  it('never overwrites a state that already exists (whatever wrote it is newer)', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    gracefulShutdown();

    simulateNewProcess();
    setAutoYesEnabled(WT, 'claude', true, THREE_HOURS);
    expect(restoreAutoYesShutdownRecord({ path: recordPath })).toEqual({ seeded: 0, skipped: 1 });
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });

  describe('how long the notice lives', () => {
    beforeEach(() => {
      setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
      gracefulShutdown();
      simulateNewProcess();
      restoreAutoYesShutdownRecord({ path: recordPath });
    });

    it('until the original deadline, then reads as no state (not "expired")', () => {
      vi.setSystemTime(T0 + ONE_HOUR - 1);
      expect(getAutoYesState(WT, 'claude')?.stopReason).toBe('server-restart');
      vi.setSystemTime(T0 + ONE_HOUR);
      expect(getAutoYesState(WT, 'claude')).toBeNull();
      expect(getRestartReleasedAutoYesByWorktree().size).toBe(0);
    });

    it('re-enabling replaces it', () => {
      setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
      const state = getAutoYesState(WT, 'claude');
      expect(state?.enabled).toBe(true);
      expect(state?.stopReason).toBeUndefined();
    });

    it('turning it off by hand clears the reason', () => {
      setAutoYesEnabled(WT, 'claude', false);
      expect(getAutoYesState(WT, 'claude')).toMatchObject({ enabled: false, stopReason: undefined });
    });

    it('a second restart inside the window keeps it', () => {
      vi.setSystemTime(T0 + 10 * 60_000);
      expect(gracefulShutdown()).toEqual({ recorded: 1 });
      simulateNewProcess();
      restoreAutoYesShutdownRecord({ path: recordPath });

      expect(getAutoYesState(WT, 'claude')).toMatchObject({
        enabled: false,
        stopReason: 'server-restart',
        expiresAt: T0 + ONE_HOUR,
      });
      expect(getActivePollerCount()).toBe(0);
    });

    it('a second restart after a manual OFF does not bring it back', () => {
      setAutoYesEnabled(WT, 'claude', false);
      expect(gracefulShutdown()).toEqual({ recorded: 0 });
      simulateNewProcess();
      restoreAutoYesShutdownRecord({ path: recordPath });
      expect(getAutoYesState(WT, 'claude')).toBeNull();
    });
  });
});

describe('a record that is missing, broken or unreadable (Issue #3730)', () => {
  it('no record: nothing seeded, no error', () => {
    expect(restoreAutoYesShutdownRecord({ path: recordPath })).toEqual({ seeded: 0, skipped: 0 });
  });

  it.each([
    ['not JSON', '{"version":1,"grants":['],
    ['another version', JSON.stringify({ version: 2, grants: [] })],
    ['no grants array', JSON.stringify({ version: 1 })],
    [
      'an entry with a bad worktree id',
      JSON.stringify({
        version: 1,
        writtenAt: T0,
        grants: [{ worktreeId: '../etc', cliToolId: 'claude', instanceId: 'claude', enabledAt: T0, expiresAt: T0 + ONE_HOUR }],
      }),
    ],
    [
      'an entry with an unknown CLI tool',
      JSON.stringify({
        version: 1,
        writtenAt: T0,
        grants: [{ worktreeId: WT, cliToolId: 'nope', instanceId: 'nope', enabledAt: T0, expiresAt: T0 + ONE_HOUR }],
      }),
    ],
  ])('%s: everything stays off with no reason, and the record is consumed', (_label, content) => {
    fs.writeFileSync(recordPath, content);
    const result = restoreAutoYesShutdownRecord({ path: recordPath });

    expect(result.seeded).toBe(0);
    expect(result.error).toBe('invalid record');
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('an unreadable record (a directory at the path) is reported and ignored', () => {
    fs.mkdirSync(recordPath);
    const result = restoreAutoYesShutdownRecord({ path: recordPath });
    expect(result.seeded).toBe(0);
    expect(result.error).toBeDefined();
    expect(getAutoYesState(WT, 'claude')).toBeNull();
  });

  it('a record that cannot be removed still seeds, and reading it again seeds nothing new', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    gracefulShutdown();
    simulateNewProcess();
    fs.chmodSync(dir, 0o500);

    const first = restoreAutoYesShutdownRecord({ path: recordPath });
    expect(first.seeded).toBe(1);
    expect(first.error).toBeDefined();
    expect(fs.existsSync(recordPath)).toBe(true);

    setAutoYesEnabled(WT, 'claude', false); // the user acts after the start
    const second = restoreAutoYesShutdownRecord({ path: recordPath });
    expect(second.seeded).toBe(0);
    expect(getAutoYesState(WT, 'claude')?.stopReason).toBeUndefined();
  });
});

describe('one record per database (Issue #3730)', () => {
  it('cm.db and cm-3.db in one directory keep separate records', () => {
    const issuePath = path.join(dir, `cm-3.db${AUTO_YES_SHUTDOWN_RECORD_SUFFIX}`);
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    recordAutoYesShutdown({ path: recordPath });
    simulateNewProcess();
    setAutoYesEnabled(OTHER, 'codex', true, ONE_HOUR);
    recordAutoYesShutdown({ path: issuePath });

    simulateNewProcess();
    restoreAutoYesShutdownRecord({ path: issuePath });
    expect(getAutoYesState(OTHER, 'codex')?.stopReason).toBe('server-restart');
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    // The Issue server's start consumed only its own record.
    expect(fs.existsSync(recordPath)).toBe(true);
  });

  it('resolves next to CM_DB_PATH unless the override names a path', () => {
    vi.stubEnv(AUTO_YES_SHUTDOWN_RECORD_PATH_ENV, '');
    vi.stubEnv('CM_DB_PATH', path.join(os.homedir(), '.commandmate', 'data', 'cm-7.db'));
    try {
      expect(resolveAutoYesShutdownRecordPath()).toBe(
        path.join(os.homedir(), '.commandmate', 'data', `cm-7.db${AUTO_YES_SHUTDOWN_RECORD_SUFFIX}`),
      );
      vi.stubEnv(AUTO_YES_SHUTDOWN_RECORD_PATH_ENV, recordPath);
      expect(resolveAutoYesShutdownRecordPath()).toBe(recordPath);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('tests/setup.ts points the default at a temp file, never at a real database', () => {
    const resolved = resolveAutoYesShutdownRecordPath();
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(os.tmpdir())).toBe(true);
  });
});
