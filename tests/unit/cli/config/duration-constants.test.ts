/**
 * Duration Constants Tests
 * Issue #518: [DR1-09] Validate CLI duration constants
 * Issue #3913: `--duration` is `1h`〜`24h` (whole hours); the CLI re-exports the
 *   dependency-free definitions instead of keeping a `1h|3h|8h` copy.
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_YES_DURATIONS,
  AUTO_YES_DURATION_FLAG_PATTERN,
  DEFAULT_DURATION_FLAG,
  parseDurationToMs,
} from '../../../../src/cli/config/duration-constants';

describe('AUTO_YES_DURATIONS (CLI re-export)', () => {
  it('has exactly 24 entries, 1h to 24h', () => {
    expect(AUTO_YES_DURATIONS).toHaveLength(24);
    expect(AUTO_YES_DURATIONS[0]).toBe(3_600_000);
    expect(AUTO_YES_DURATIONS[23]).toBe(86_400_000);
  });
});

describe('DEFAULT_DURATION_FLAG', () => {
  it('is 1h and parses to the server default', () => {
    expect(DEFAULT_DURATION_FLAG).toBe('1h');
    expect(parseDurationToMs(DEFAULT_DURATION_FLAG)).toBe(3_600_000);
  });
});

describe('parseDurationToMs', () => {
  it('parses valid durations', () => {
    expect(parseDurationToMs('1h')).toBe(3_600_000);
    expect(parseDurationToMs('3h')).toBe(10_800_000);
    expect(parseDurationToMs('8h')).toBe(28_800_000);
  });

  it('parses every whole hour from 1h to 24h (Issue #3913)', () => {
    for (let hours = 1; hours <= 24; hours++) {
      expect(parseDurationToMs(`${hours}h`)).toBe(hours * 3_600_000);
    }
  });

  it('returns null for invalid durations', () => {
    expect(parseDurationToMs('1d')).toBeNull();
    expect(parseDurationToMs('')).toBeNull();
    expect(parseDurationToMs('abc')).toBeNull();
  });

  it.each(['0h', '25h', '1.5h', '90m', '01h', '+1h', '-1h', '1H', ' 1h', '1h ', '1hX', 'h', '100h', '24'])(
    'returns null for %j (Issue #3913)',
    (flag) => {
      expect(parseDurationToMs(flag)).toBeNull();
      expect(AUTO_YES_DURATION_FLAG_PATTERN.test(flag)).toBe(false);
    },
  );
});
