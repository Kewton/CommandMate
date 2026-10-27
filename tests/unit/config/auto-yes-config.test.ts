/**
 * Tests for auto-yes-config.ts
 *
 * Issue #225: Duration selection feature - configuration constants,
 * type guard, and formatTimeRemaining utility.
 * Issue #3913: 1〜24 whole hours (AUTO_YES_DURATIONS) with 1h/3h/8h presets;
 *   DURATION_LABELS retired for an ICU display name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AUTO_YES_DURATIONS,
  PRESET_AUTO_YES_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  isAllowedDuration,
  formatTimeRemaining,
  validateStopPattern,
  MAX_STOP_PATTERN_LENGTH,
  THINKING_POLLING_INTERVAL_MS,
  REDUCED_CAPTURE_LINES,
  FULL_CAPTURE_LINES,
  AUTO_STOP_ERROR_THRESHOLD,
  AUTO_YES_COUNTDOWN_INTERVAL_MS,
  type AutoYesDuration,
  type AutoYesStopReason,
} from '@/config/auto-yes-config';

describe('auto-yes-config', () => {
  describe('AUTO_YES_COUNTDOWN_INTERVAL_MS (Issue #760)', () => {
    it('should be 1000 (1 second), preserving the original literal', () => {
      expect(AUTO_YES_COUNTDOWN_INTERVAL_MS).toBe(1000);
    });

    it('should be a positive number', () => {
      expect(typeof AUTO_YES_COUNTDOWN_INTERVAL_MS).toBe('number');
      expect(AUTO_YES_COUNTDOWN_INTERVAL_MS).toBeGreaterThan(0);
    });
  });

  describe('AUTO_YES_DURATIONS (Issue #3913)', () => {
    it('should contain exactly 24 duration values, 1 to 24 whole hours', () => {
      expect(AUTO_YES_DURATIONS).toHaveLength(24);
      expect([...AUTO_YES_DURATIONS]).toEqual(Array.from({ length: 24 }, (_, i) => (i + 1) * 3600000));
    });

    it('should contain 1 hour (3600000ms)', () => {
      expect(AUTO_YES_DURATIONS).toContain(3600000);
    });

    it('should contain 3 hours (10800000ms)', () => {
      expect(AUTO_YES_DURATIONS).toContain(10800000);
    });

    it('should contain 8 hours (28800000ms)', () => {
      expect(AUTO_YES_DURATIONS).toContain(28800000);
    });

    it('should contain 24 hours (86400000ms) as the upper bound', () => {
      expect(AUTO_YES_DURATIONS.at(-1)).toBe(86400000);
    });

    it('should be sorted in ascending order', () => {
      for (let i = 1; i < AUTO_YES_DURATIONS.length; i++) {
        expect(AUTO_YES_DURATIONS[i]).toBeGreaterThan(AUTO_YES_DURATIONS[i - 1]);
      }
    });

    it('should be typed as a readonly tuple (as const)', () => {
      // Type-level check: the array should be assignable to readonly number[]
      // but individual elements should be literal types
      const values: readonly number[] = AUTO_YES_DURATIONS;
      expect(values.length).toBe(24);
    });
  });

  describe('PRESET_AUTO_YES_DURATIONS (Issue #3913)', () => {
    it('should keep 1h / 3h / 8h as the presets, each an allowed duration', () => {
      expect([...PRESET_AUTO_YES_DURATIONS]).toEqual([3600000, 10800000, 28800000]);
      for (const preset of PRESET_AUTO_YES_DURATIONS) {
        expect(isAllowedDuration(preset)).toBe(true);
      }
    });
  });

  describe('DEFAULT_AUTO_YES_DURATION', () => {
    it('should be 1 hour (3600000ms)', () => {
      expect(DEFAULT_AUTO_YES_DURATION).toBe(3600000);
    });

    it('should be a member of AUTO_YES_DURATIONS', () => {
      expect(AUTO_YES_DURATIONS).toContain(DEFAULT_AUTO_YES_DURATION);
    });
  });

  describe('isAllowedDuration', () => {
    it('should return true for all allowed duration values', () => {
      for (let hours = 1; hours <= 24; hours++) {
        expect(isAllowedDuration(hours * 3600000)).toBe(true);
      }
    });

    it('should return false for non-allowed numbers', () => {
      expect(isAllowedDuration(0)).toBe(false);
      expect(isAllowedDuration(1000)).toBe(false);
      expect(isAllowedDuration(25 * 3600000)).toBe(false);  // 25 hours - over the limit
      expect(isAllowedDuration(1.5 * 3600000)).toBe(false); // 1.5 hours - not a whole hour
      expect(isAllowedDuration(3600001)).toBe(false);       // 1 ms off
      expect(isAllowedDuration(86399999)).toBe(false);      // 1 ms short of 24h
      expect(isAllowedDuration(-3600000)).toBe(false);      // negative
    });

    it('should return false for non-number types', () => {
      expect(isAllowedDuration('3600000')).toBe(false);
      expect(isAllowedDuration('86400000')).toBe(false);
      expect(isAllowedDuration(null)).toBe(false);
      expect(isAllowedDuration(false)).toBe(false);
      expect(isAllowedDuration([3600000])).toBe(false);
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

    it('should format 5 hours and 24 hours at the start of the grant (Issue #3913)', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);
      expect(formatTimeRemaining(now + 5 * 3600000)).toBe('5:00:00');
      expect(formatTimeRemaining(now + 24 * 3600000)).toBe('24:00:00');
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

  // ==========================================================================
  // Issue #314: validateStopPattern tests
  // ==========================================================================
  describe('MAX_STOP_PATTERN_LENGTH', () => {
    it('should be 500', () => {
      expect(MAX_STOP_PATTERN_LENGTH).toBe(500);
    });
  });

  describe('validateStopPattern', () => {
    it('should accept valid regex patterns', () => {
      expect(validateStopPattern('rm -rf')).toEqual({ valid: true });
      expect(validateStopPattern('DROP TABLE')).toEqual({ valid: true });
      expect(validateStopPattern('error|warning|fatal')).toEqual({ valid: true });
      expect(validateStopPattern('^test$')).toEqual({ valid: true });
      expect(validateStopPattern('\\d+')).toEqual({ valid: true });
    });

    it('should accept empty string as valid (empty pattern means no stop condition)', () => {
      expect(validateStopPattern('')).toEqual({ valid: true });
    });

    it('should reject patterns exceeding MAX_STOP_PATTERN_LENGTH', () => {
      const longPattern = 'a'.repeat(MAX_STOP_PATTERN_LENGTH + 1);
      const result = validateStopPattern(longPattern);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`Pattern must be ${MAX_STOP_PATTERN_LENGTH} characters or less`);
    });

    it('should accept patterns at exactly MAX_STOP_PATTERN_LENGTH', () => {
      const exactPattern = 'a'.repeat(MAX_STOP_PATTERN_LENGTH);
      expect(validateStopPattern(exactPattern)).toEqual({ valid: true });
    });

    it('should reject invalid regex syntax', () => {
      // Note: safe-regex2 may also detect some invalid patterns as unsafe.
      // The important thing is that the pattern is rejected.
      const result = validateStopPattern('[invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject ReDoS patterns (catastrophic backtracking)', () => {
      // Classic ReDoS pattern: (a+)+ with exponential backtracking
      const result = validateStopPattern('(a+)+$');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Pattern may cause performance issues (catastrophic backtracking detected)');
    });

    it('should reject nested quantifier ReDoS pattern', () => {
      // Another classic ReDoS: (a+)+ without anchor
      const result = validateStopPattern('(a+)+b');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Pattern may cause performance issues (catastrophic backtracking detected)');
    });

    it('should use fixed error messages only (XSS prevention)', () => {
      // Verify that error messages do not contain user input
      const maliciousPattern = '<script>alert("xss")</script>[invalid';
      const result = validateStopPattern(maliciousPattern);
      expect(result.valid).toBe(false);
      // Error should be a fixed string, not containing the malicious input
      expect(result.error).not.toContain('<script>');
      expect(result.error).not.toContain('alert');
    });
  });

  // ==========================================================================
  // Issue #499: Performance improvement constants
  // ==========================================================================

  describe('Issue #499: Performance constants', () => {
    it('THINKING_POLLING_INTERVAL_MS should be 5000', () => {
      expect(THINKING_POLLING_INTERVAL_MS).toBe(5000);
    });

    it('REDUCED_CAPTURE_LINES should cover the fixed TUI pane', () => {
      expect(REDUCED_CAPTURE_LINES).toBe(1000);
    });

    it('FULL_CAPTURE_LINES should be 5000', () => {
      expect(FULL_CAPTURE_LINES).toBe(5000);
    });

    it('AUTO_STOP_ERROR_THRESHOLD should be 20', () => {
      expect(AUTO_STOP_ERROR_THRESHOLD).toBe(20);
    });

    it('AutoYesStopReason should include consecutive_errors', () => {
      // Type-level check: this compiles only if consecutive_errors is valid
      const reason: AutoYesStopReason = 'consecutive_errors';
      expect(reason).toBe('consecutive_errors');
    });

    it('AutoYesStopReason should include all expected values', () => {
      const reasons: AutoYesStopReason[] = ['expired', 'stop_pattern_matched', 'consecutive_errors'];
      expect(reasons).toHaveLength(3);
      expect(reasons).toContain('expired');
      expect(reasons).toContain('stop_pattern_matched');
      expect(reasons).toContain('consecutive_errors');
    });
  });
});
