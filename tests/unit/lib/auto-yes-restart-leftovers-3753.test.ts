/**
 * Leftovers of the restart notice (Issue #3753): the shutdown record and the
 * start-up ID move, and a disabled state's reason against its old deadline.
 *
 * Real state and a real record file under a `mkdtemp` directory removed after
 * every test. Positive controls fail on the pre-#3753 implementation.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_YES_SHUTDOWN_RECORD_SUFFIX,
  recordAutoYesShutdown,
  restoreAutoYesShutdownRecord,
} from '@/lib/auto-yes-shutdown-record';
import {
  clearAllAutoYesStates,
  disableAutoYes,
  getAutoYesState,
  migrateAutoYesStateWorktreeIds,
  resetAutoYesShutdownForTesting,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000 as const;
const OLD_ID = 'wt-3753-old';
const NEW_ID = 'wt-3753-new';

let dir: string;
let recordPath: string;

function simulateNewProcess(): void {
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-3753-'));
  recordPath = path.join(dir, `cm.db${AUTO_YES_SHUTDOWN_RECORD_SUFFIX}`);
  simulateNewProcess();
});

afterEach(() => {
  simulateNewProcess();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a restart notice re-stopped while the start-up ID move was awaiting (Issue #3753-1)', () => {
  /** Run 1 releases a grant under OLD_ID; run 2 restores it and is shut down mid-move. */
  function secondRun(off: boolean): void {
    setAutoYesEnabled(OLD_ID, 'claude', true, HOUR);
    recordAutoYesShutdown({ path: recordPath });
    simulateNewProcess();
    restoreAutoYesShutdownRecord({ path: recordPath });
    expect(getAutoYesState(OLD_ID, 'claude')?.stopReason).toBe('server-restart');

    // B is armed and OFF under the new ID while the ID move is still awaiting.
    if (off) {
      setAutoYesEnabled(NEW_ID, 'claude', true, HOUR);
    }
    recordAutoYesShutdown({ path: recordPath });
    if (off) setAutoYesEnabled(NEW_ID, 'claude', false);
    migrateAutoYesStateWorktreeIds([{ oldId: OLD_ID, newId: NEW_ID }]);
  }

  it('positive: the next start shows no server-restart for the instance that was turned OFF', () => {
    secondRun(true);
    simulateNewProcess();
    restoreAutoYesShutdownRecord({ path: recordPath });
    expect(getAutoYesState(NEW_ID, 'claude')).toBeNull();
    expect(getAutoYesState(OLD_ID, 'claude')).toBeNull();
  });

  it('negative control: with no OFF the notice moves and the next start shows it under the new ID', () => {
    secondRun(false);
    simulateNewProcess();
    restoreAutoYesShutdownRecord({ path: recordPath });
    expect(getAutoYesState(NEW_ID, 'claude')).toMatchObject({ enabled: false, stopReason: 'server-restart' });
  });
});

describe('a disabled state keeps its reason past the old deadline (Issue #3753-2)', () => {
  it('positive: a manual OFF does not read expired after the deadline', () => {
    setAutoYesEnabled(OLD_ID, 'claude', true, HOUR);
    setAutoYesEnabled(OLD_ID, 'claude', false);
    vi.setSystemTime(T0 + HOUR + 1);
    expect(getAutoYesState(OLD_ID, 'claude')).toMatchObject({ enabled: false, stopReason: undefined });
  });

  it('positive: an OFF on a key that never had a state does not read expired', () => {
    setAutoYesEnabled(OLD_ID, 'claude', false);
    expect(getAutoYesState(OLD_ID, 'claude')).toMatchObject({ enabled: false, stopReason: undefined });
  });

  it('positive: a stop-pattern stop keeps its reason past the deadline', () => {
    setAutoYesEnabled(OLD_ID, 'claude', true, HOUR);
    disableAutoYes(OLD_ID, 'claude', 'stop_pattern_matched');
    vi.setSystemTime(T0 + HOUR + 1);
    expect(getAutoYesState(OLD_ID, 'claude')?.stopReason).toBe('stop_pattern_matched');
  });

  it('negative control: a live grant that runs out still reads expired', () => {
    setAutoYesEnabled(OLD_ID, 'claude', true, HOUR);
    vi.setSystemTime(T0 + HOUR + 1);
    expect(getAutoYesState(OLD_ID, 'claude')).toMatchObject({ enabled: false, stopReason: 'expired' });
  });
});
