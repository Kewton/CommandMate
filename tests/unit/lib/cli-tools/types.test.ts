/**
 * Tests for CLI tools type definitions and validation functions
 * Issue #374: isValidVibeLocalContextWindow() validation tests
 */

import { describe, it, expect } from 'vitest';
import {
  isValidVibeLocalContextWindow,
  VIBE_LOCAL_CONTEXT_WINDOW_MIN,
  VIBE_LOCAL_CONTEXT_WINDOW_MAX,
} from '../../../../src/lib/cli-tools/types';

describe('isValidVibeLocalContextWindow', () => {
  describe('constants', () => {
    it('should have VIBE_LOCAL_CONTEXT_WINDOW_MIN = 128', () => {
      expect(VIBE_LOCAL_CONTEXT_WINDOW_MIN).toBe(128);
    });

    it('should have VIBE_LOCAL_CONTEXT_WINDOW_MAX = 2097152', () => {
      expect(VIBE_LOCAL_CONTEXT_WINDOW_MAX).toBe(2097152);
    });
  });

  describe('valid values', () => {
    it('should accept minimum value (128)', () => {
      expect(isValidVibeLocalContextWindow(128)).toBe(true);
    });

    it('should accept typical value (8192)', () => {
      expect(isValidVibeLocalContextWindow(8192)).toBe(true);
    });

    it('should accept maximum value (2097152)', () => {
      expect(isValidVibeLocalContextWindow(2097152)).toBe(true);
    });

    it('should accept mid-range value (131072)', () => {
      expect(isValidVibeLocalContextWindow(131072)).toBe(true);
    });
  });

  describe('boundary values (rejection)', () => {
    it('should reject value just below minimum (127)', () => {
      expect(isValidVibeLocalContextWindow(127)).toBe(false);
    });

    it('should reject value just above maximum (2097153)', () => {
      expect(isValidVibeLocalContextWindow(2097153)).toBe(false);
    });

    it('should reject zero', () => {
      expect(isValidVibeLocalContextWindow(0)).toBe(false);
    });
  });

  describe('invalid types', () => {
    it('should reject NaN', () => {
      expect(isValidVibeLocalContextWindow(NaN)).toBe(false);
    });

    it('should reject Infinity', () => {
      expect(isValidVibeLocalContextWindow(Infinity)).toBe(false);
    });

    it('should reject negative Infinity', () => {
      expect(isValidVibeLocalContextWindow(-Infinity)).toBe(false);
    });

    it('should reject negative numbers', () => {
      expect(isValidVibeLocalContextWindow(-1)).toBe(false);
    });

    it('should reject decimal numbers', () => {
      expect(isValidVibeLocalContextWindow(128.5)).toBe(false);
    });

    it('should reject strings', () => {
      expect(isValidVibeLocalContextWindow('8192')).toBe(false);
    });

    it('should reject null', () => {
      expect(isValidVibeLocalContextWindow(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(isValidVibeLocalContextWindow(undefined)).toBe(false);
    });

    it('should reject boolean', () => {
      expect(isValidVibeLocalContextWindow(true)).toBe(false);
    });

    it('should reject objects', () => {
      expect(isValidVibeLocalContextWindow({ value: 128 })).toBe(false);
    });

    it('should reject arrays', () => {
      expect(isValidVibeLocalContextWindow([128])).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('should narrow type to number when returning true', () => {
      const value: unknown = 8192;
      if (isValidVibeLocalContextWindow(value)) {
        // TypeScript should narrow value to number here
        const result: number = value;
        expect(result).toBe(8192);
      }
    });
  });
});
