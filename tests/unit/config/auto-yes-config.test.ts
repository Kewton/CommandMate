/**
 * Tests for auto-yes-config.ts
 *
 * Issue #225: Duration selection feature - configuration constants,
 * type guard, and formatTimeRemaining utility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ALLOWED_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  DURATION_LABELS,
  isAllowedDuration,
  formatTimeRemaining,
  type AutoYesDuration,
} from '@/config/auto-yes-config';

describe('auto-yes-config', () => {
  describe('ALLOWED_DURATIONS', () => {
    it('should contain exactly 3 duration values', () => {
      expect(ALLOWED_DURATIONS).toHaveLength(3);
    });

    it('should contain 1 hour (3600000ms)', () => {
      expect(ALLOWED_DURATIONS).toContain(3600000);
    });

    it('should contain 3 hours (10800000ms)', () => {
      expect(ALLOWED_DURATIONS).toContain(10800000);
    });

    it('should contain 8 hours (28800000ms)', () => {
      expect(ALLOWED_DURATIONS).toContain(28800000);
    });

    it('should be sorted in ascending order', () => {
      for (let i = 1; i < ALLOWED_DURATIONS.length; i++) {
        expect(ALLOWED_DURATIONS[i]).toBeGreaterThan(ALLOWED_DURATIONS[i - 1]);
      }
    });

    it('should be typed as a readonly tuple (as const)', () => {
      // "as const" enforces readonly at compile time in TypeScript.
      // At runtime, verify the values match expected literal numbers.
      const values: readonly number[] = ALLOWED_DURATIONS;
      expect(values).toEqual([3600000, 10800000, 28800000]);
    });
  });

  describe('DEFAULT_AUTO_YES_DURATION', () => {
    it('should be 1 hour (3600000ms)', () => {
      expect(DEFAULT_AUTO_YES_DURATION).toBe(3600000);
    });

    it('should be a member of ALLOWED_DURATIONS', () => {
      expect(ALLOWED_DURATIONS).toContain(DEFAULT_AUTO_YES_DURATION);
    });
  });

  describe('DURATION_LABELS', () => {
    it('should have a label for every allowed duration', () => {
      for (const duration of ALLOWED_DURATIONS) {
        expect(DURATION_LABELS[duration]).toBeDefined();
        expect(typeof DURATION_LABELS[duration]).toBe('string');
        expect(DURATION_LABELS[duration].length).toBeGreaterThan(0);
      }
    });

    it('should have correct i18n translation keys', () => {
      expect(DURATION_LABELS[3600000]).toBe('autoYes.durations.1h');
      expect(DURATION_LABELS[10800000]).toBe('autoYes.durations.3h');
      expect(DURATION_LABELS[28800000]).toBe('autoYes.durations.8h');
    });
  });

  describe('isAllowedDuration', () => {
    it('should return true for all allowed duration values', () => {
      expect(isAllowedDuration(3600000)).toBe(true);
      expect(isAllowedDuration(10800000)).toBe(true);
      expect(isAllowedDuration(28800000)).toBe(true);
    });

    it('should return false for non-allowed numbers', () => {
      expect(isAllowedDuration(0)).toBe(false);
      expect(isAllowedDuration(1000)).toBe(false);
      expect(isAllowedDuration(7200000)).toBe(false);   // 2 hours - not allowed
      expect(isAllowedDuration(86400000)).toBe(false);   // 24 hours - not allowed
      expect(isAllowedDuration(-3600000)).toBe(false);   // negative
    });

    it('should return false for non-number types', () => {
      expect(isAllowedDuration('3600000')).toBe(false);
      expect(isAllowedDuration(null)).toBe(false);
      expect(isAllowedDuration(undefined)).toBe(false);
      expect(isAllowedDuration(true)).toBe(false);
      expect(isAllowedDuration({})).toBe(false);
      expect(isAllowedDuration([])).toBe(false);
    });

    it('should return false for NaN and Infinity', () => {
      expect(isAllowedDuration(NaN)).toBe(false);
      expect(isAllowedDuration(Infinity)).toBe(false);
      expect(isAllowedDuration(-Infinity)).toBe(false);
    });

    it('should narrow type correctly (type guard contract)', () => {
      const value: unknown = 3600000;
      if (isAllowedDuration(value)) {
        // If this compiles, the type guard narrows correctly
        const duration: AutoYesDuration = value;
        expect(duration).toBe(3600000);
      } else {
        // Should not reach here
        expect.unreachable('isAllowedDuration should return true for 3600000');
      }
    });
  });

  describe('formatTimeRemaining', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "00:00" when expired (expiresAt in the past)', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now - 1000)).toBe('00:00');
    });

    it('should return "00:00" when expiresAt equals current time', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now)).toBe('00:00');
    });

    it('should format seconds correctly in MM:SS', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      // 30 seconds remaining
      expect(formatTimeRemaining(now + 30000)).toBe('00:30');
    });

    it('should format minutes and seconds in MM:SS', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      // 5 minutes 45 seconds remaining
      expect(formatTimeRemaining(now + 5 * 60000 + 45000)).toBe('05:45');
    });

    it('should format 59:59 correctly (just under 1 hour)', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      // 59 minutes 59 seconds
      expect(formatTimeRemaining(now + 59 * 60000 + 59000)).toBe('59:59');
    });

    it('should switch to H:MM:SS format at exactly 1 hour', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      // Exactly 1 hour
      expect(formatTimeRemaining(now + 3600000)).toBe('1:00:00');
    });

    it('should format 1 hour 30 minutes 15 seconds correctly', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now + 3600000 + 30 * 60000 + 15000)).toBe('1:30:15');
    });

    it('should format 3 hours correctly', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now + 10800000)).toBe('3:00:00');
    });

    it('should format 8 hours correctly', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now + 28800000)).toBe('8:00:00');
    });

    it('should pad minutes and seconds with leading zeros in H:MM:SS', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      // 2 hours 3 minutes 5 seconds
      expect(formatTimeRemaining(now + 2 * 3600000 + 3 * 60000 + 5000)).toBe('2:03:05');
    });

    it('should handle 1 second remaining', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now + 1000)).toBe('00:01');
    });

    it('should not produce negative values for far-past expiresAt', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(0)).toBe('00:00');
    });
  });
});
