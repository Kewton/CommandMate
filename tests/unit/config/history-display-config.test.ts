/**
 * Tests for history-display-config (Issue #701)
 */

import { describe, it, expect } from 'vitest';
import {
  HISTORY_DISPLAY_LIMIT_OPTIONS,
  MAX_MESSAGES_LIMIT,
  DEFAULT_MESSAGES_LIMIT,
  HISTORY_DISPLAY_LIMIT_STORAGE_KEY,
  isHistoryDisplayLimit,
} from '@/config/history-display-config';

describe('history-display-config (Issue #701)', () => {
  describe('HISTORY_DISPLAY_LIMIT_OPTIONS', () => {
    it('should expose [50, 100, 150, 200, 250] in ascending order', () => {
      expect([...HISTORY_DISPLAY_LIMIT_OPTIONS]).toEqual([50, 100, 150, 200, 250]);
    });

    it('should not be empty', () => {
      expect(HISTORY_DISPLAY_LIMIT_OPTIONS.length).toBeGreaterThan(0);
    });

    it('should contain only positive integers', () => {
      for (const opt of HISTORY_DISPLAY_LIMIT_OPTIONS) {
        expect(Number.isInteger(opt)).toBe(true);
        expect(opt).toBeGreaterThan(0);
      }
    });
  });

  describe('MAX_MESSAGES_LIMIT', () => {
    it('should be the maximum of HISTORY_DISPLAY_LIMIT_OPTIONS', () => {
      expect(MAX_MESSAGES_LIMIT).toBe(Math.max(...HISTORY_DISPLAY_LIMIT_OPTIONS));
    });

    it('should equal 250', () => {
      expect(MAX_MESSAGES_LIMIT).toBe(250);
    });
  });

  describe('DEFAULT_MESSAGES_LIMIT', () => {
    it('should be 50 (historical default)', () => {
      expect(DEFAULT_MESSAGES_LIMIT).toBe(50);
    });

    it('should be one of HISTORY_DISPLAY_LIMIT_OPTIONS', () => {
      expect(HISTORY_DISPLAY_LIMIT_OPTIONS).toContain(DEFAULT_MESSAGES_LIMIT);
    });
  });

  describe('HISTORY_DISPLAY_LIMIT_STORAGE_KEY', () => {
    it('should use the commandmate: namespace', () => {
      expect(HISTORY_DISPLAY_LIMIT_STORAGE_KEY).toBe('commandmate:historyDisplayLimit');
    });
  });

  describe('isHistoryDisplayLimit', () => {
    it('should return true for valid options', () => {
      for (const opt of HISTORY_DISPLAY_LIMIT_OPTIONS) {
        expect(isHistoryDisplayLimit(opt)).toBe(true);
      }
    });

    it('should return false for non-option values', () => {
      expect(isHistoryDisplayLimit(0)).toBe(false);
      expect(isHistoryDisplayLimit(49)).toBe(false);
      expect(isHistoryDisplayLimit(75)).toBe(false);
      expect(isHistoryDisplayLimit(251)).toBe(false);
      expect(isHistoryDisplayLimit(-50)).toBe(false);
      expect(isHistoryDisplayLimit(NaN)).toBe(false);
    });
  });
});
