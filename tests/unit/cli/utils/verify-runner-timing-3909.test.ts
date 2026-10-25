/**
 * The CLI's reading of the `[timing]` marker (Issue #3909).
 *
 * `src/cli/**` cannot import the server (tsconfig.cli.json), so the prefix and
 * the pattern are mirrored. This pins the mirror to the runner's prefix and to
 * the server's own reader (verification-db.ts parseGateTiming, which turns the
 * same line into `timing` for `verify history --json`), so the GATE line and the
 * history listing can never read a different number off one gate.
 */

import { describe, expect, it } from 'vitest';
import { TIMING_LOG_PREFIX as RUNNER_TIMING_LOG_PREFIX } from '@/lib/verification/gate-runner';
import { parseGateTiming } from '@/lib/db/verification-db';
import {
  formatGateTiming,
  parseTimingMarker,
  TIMING_LOG_PREFIX,
} from '../../../../src/cli/utils/verify-runner';

describe('parseTimingMarker (Issue #3909)', () => {
  it('mirrors the runner prefix', () => {
    expect(TIMING_LOG_PREFIX).toBe(RUNNER_TIMING_LOG_PREFIX);
  });

  it.each([
    ['[mutex] name=cpu.heavy waited=120.0s lock=/l\nok\n[timing] queue=30.0s mutex=120.0s run=600.0s'],
    ['[timing] queue=0.0s mutex=0.0s run=1.5s\n'],
    ['ok\n[timing] queue=2.4s mutex=0.0s run=0.3s'],
  ])('reads %j the way the history listing does', (logTail) => {
    expect(parseTimingMarker(logTail)).toEqual(parseGateTiming(logTail));
    expect(parseTimingMarker(logTail)).not.toBeNull();
  });

  it.each([
    [null],
    [''],
    ['[mutex] name=e2e waited=42.3s lock=/l\nall specs passed'],
    // A gate's own output that prints the marker earlier is not the runner's line.
    ['[timing] queue=9.0s mutex=9.0s run=9.0s\nsuite output after it'],
  ])('reads no timing from %j (negative control)', (logTail) => {
    expect(parseTimingMarker(logTail)).toBeNull();
    expect(parseGateTiming(logTail)).toBeNull();
  });

  it('formats one decimal second, with the separator the caller asks for', () => {
    const timing = { queueSec: 30, mutexSec: 120.25, runSec: 0 };
    expect(formatGateTiming(timing)).toBe('queue=30.0s, mutex=120.3s, run=0.0s');
    expect(formatGateTiming(timing, ' ')).toBe('queue=30.0s mutex=120.3s run=0.0s');
  });
});
