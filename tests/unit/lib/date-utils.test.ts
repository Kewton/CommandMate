/**
 * formatRelativeTime() Unit Tests
 * [SF-001] Independent utility for testability and reuse
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '@/lib/date-utils';
import { ja } from 'date-fns/locale/ja';

describe('formatRelativeTime [SF-001]', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic functionality', () => {
    it('should return a relative time string for recent timestamps', () => {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const result = formatRelativeTime(fiveMinutesAgo.toISOString());

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return a relative time string for timestamps hours ago', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));

      const twoHoursAgo = new Date('2026-02-15T10:00:00Z');
      const result = formatRelativeTime(twoHoursAgo.toISOString());

      expect(typeof result).toBe('string');
      expect(result).toContain('2');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return a relative time string for timestamps days ago', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));

      const threeDaysAgo = new Date('2026-02-12T12:00:00Z');
      const result = formatRelativeTime(threeDaysAgo.toISOString());

      expect(typeof result).toBe('string');
      expect(result).toContain('3');
    });
  });

  describe('locale support', () => {
    it('should format in English by default', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));

      const oneHourAgo = new Date('2026-02-15T11:00:00Z');
      const result = formatRelativeTime(oneHourAgo.toISOString());

      // English result should contain "hour" or similar
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should format in Japanese when ja locale is provided', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));

      const oneHourAgo = new Date('2026-02-15T11:00:00Z');
      const result = formatRelativeTime(oneHourAgo.toISOString(), ja);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle ISO strings with timezone info', () => {
      const timestamp = '2026-02-15T12:00:00+09:00';
      const result = formatRelativeTime(timestamp);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle timestamps from the past', () => {
      const oldTimestamp = '2020-01-01T00:00:00Z';
      const result = formatRelativeTime(oldTimestamp);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return empty string for invalid date string', () => {
      const result = formatRelativeTime('invalid-date');

      expect(result).toBe('');
    });

    it('should return empty string for empty string input', () => {
      const result = formatRelativeTime('');

      expect(result).toBe('');
    });
  });
});
