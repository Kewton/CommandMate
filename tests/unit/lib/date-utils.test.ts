/**
 * formatRelativeTime() / formatMessageTimestamp() Unit Tests
 * [SF-001] Independent utility for testability and reuse
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { format } from 'date-fns';
import { formatRelativeTime, formatMessageTimestamp } from '@/lib/date-utils';
import { ja } from 'date-fns/locale/ja';
import { enUS } from 'date-fns/locale/en-US';

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

describe('formatMessageTimestamp [SF-001]', () => {
  // Use a fixed Date so locale formatting is deterministic.
  const fixedDate = new Date('2026-02-15T10:30:00Z');

  describe('basic formatting', () => {
    it('should format Date with ja locale using PPp format', () => {
      const result = formatMessageTimestamp(fixedDate, ja);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Must equal the canonical date-fns format used by MessageList/PromptMessage.
      expect(result).toBe(format(fixedDate, 'PPp', { locale: ja }));
    });

    it('should format Date with en-US locale using PPp format', () => {
      const result = formatMessageTimestamp(fixedDate, enUS);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toBe(format(fixedDate, 'PPp', { locale: enUS }));
    });

    it('should format Date without locale (date-fns default)', () => {
      const result = formatMessageTimestamp(fixedDate);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // No-locale call must equal date-fns no-locale format output.
      expect(result).toBe(format(fixedDate, 'PPp'));
    });

    it('should produce different output for different locales', () => {
      const jaResult = formatMessageTimestamp(fixedDate, ja);
      const enResult = formatMessageTimestamp(fixedDate, enUS);

      // Locale must actually affect the output (sanity check on locale wiring).
      expect(jaResult).not.toBe(enResult);
    });
  });

  describe('edge cases', () => {
    it('should return empty string for Invalid Date', () => {
      const invalid = new Date('invalid');

      expect(formatMessageTimestamp(invalid)).toBe('');
      expect(formatMessageTimestamp(invalid, ja)).toBe('');
    });

    it('should return empty string when non-Date is passed (as any)', () => {
      // Defensive fallback: runtime callers may pass strings/null/undefined.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(formatMessageTimestamp('2026-02-15T10:30:00Z' as any)).toBe('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(formatMessageTimestamp(null as any)).toBe('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(formatMessageTimestamp(undefined as any)).toBe('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(formatMessageTimestamp(1234567890 as any)).toBe('');
    });
  });

  describe('output consistency', () => {
    it('should produce same output as format(date, PPp, { locale })', () => {
      // Guarantees the helper does not deviate from MessageList/PromptMessage.
      const dates = [
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-06-15T13:45:30Z'),
        new Date('2026-12-31T23:59:59Z'),
      ];

      for (const d of dates) {
        expect(formatMessageTimestamp(d, ja)).toBe(format(d, 'PPp', { locale: ja }));
        expect(formatMessageTimestamp(d, enUS)).toBe(format(d, 'PPp', { locale: enUS }));
      }
    });
  });
});
