/**
 * Duration Constants Tests
 * Issue #518: [DR1-09] Validate CLI duration constants
 */

import { describe, it, expect } from 'vitest';
import {
  DURATION_MAP,
  ALLOWED_DURATIONS,
  parseDurationToMs,
} from '../../../../src/cli/config/duration-constants';

describe('DURATION_MAP', () => {
  it('maps 1h to 3600000ms', () => {
    expect(DURATION_MAP['1h']).toBe(3_600_000);
  });

  it('maps 3h to 10800000ms', () => {
    expect(DURATION_MAP['3h']).toBe(10_800_000);
  });

  it('maps 8h to 28800000ms', () => {
    expect(DURATION_MAP['8h']).toBe(28_800_000);
  });

  it('has exactly 3 entries', () => {
    expect(Object.keys(DURATION_MAP)).toHaveLength(3);
  });
});

describe('ALLOWED_DURATIONS', () => {
  it('contains 1h, 3h, 8h', () => {
    expect(ALLOWED_DURATIONS).toEqual(['1h', '3h', '8h']);
  });
});

describe('parseDurationToMs', () => {
  it('parses valid durations', () => {
    expect(parseDurationToMs('1h')).toBe(3_600_000);
    expect(parseDurationToMs('3h')).toBe(10_800_000);
    expect(parseDurationToMs('8h')).toBe(28_800_000);
  });

  it('returns null for invalid durations', () => {
    expect(parseDurationToMs('2h')).toBeNull();
    expect(parseDurationToMs('1d')).toBeNull();
    expect(parseDurationToMs('')).toBeNull();
    expect(parseDurationToMs('abc')).toBeNull();
  });
});
