/**
 * Tests for schedule-config.ts
 * Issue #294: Centralized schedule configuration constants and validators
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_MESSAGE_LENGTH,
  MAX_SCHEDULE_CRON_LENGTH,
  UUID_V4_PATTERN,
  isValidUuidV4,
} from '../../../src/config/schedule-config';

describe('schedule-config', () => {
  describe('constants', () => {
    it('should have MAX_SCHEDULE_NAME_LENGTH = 100', () => {
      expect(MAX_SCHEDULE_NAME_LENGTH).toBe(100);
    });

    it('should have MAX_SCHEDULE_MESSAGE_LENGTH = 10000', () => {
      expect(MAX_SCHEDULE_MESSAGE_LENGTH).toBe(10000);
    });

    it('should have MAX_SCHEDULE_CRON_LENGTH = 100', () => {
      expect(MAX_SCHEDULE_CRON_LENGTH).toBe(100);
    });
  });

  describe('UUID_V4_PATTERN', () => {
    it('should match a valid UUID v4', () => {
      expect(UUID_V4_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should match UUID v4 with uppercase letters', () => {
      expect(UUID_V4_PATTERN.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('should not match a UUID v1', () => {
      // UUID v1 has version 1 in the third group
      expect(UUID_V4_PATTERN.test('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
    });

    it('should not match a random string', () => {
      expect(UUID_V4_PATTERN.test('not-a-uuid')).toBe(false);
    });

    it('should not match an empty string', () => {
      expect(UUID_V4_PATTERN.test('')).toBe(false);
    });

    it('should not match a UUID with invalid variant bits', () => {
      // Variant bits in the 4th group should be 8, 9, a, or b
      expect(UUID_V4_PATTERN.test('550e8400-e29b-41d4-0716-446655440000')).toBe(false);
    });
  });

  describe('isValidUuidV4', () => {
    it('should return true for a valid UUID v4', () => {
      expect(isValidUuidV4('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    });

    it('should return false for an invalid format', () => {
      expect(isValidUuidV4('invalid')).toBe(false);
    });

    it('should return false for an empty string', () => {
      expect(isValidUuidV4('')).toBe(false);
    });

    it('should return true for crypto.randomUUID() format', () => {
      // randomUUID() generates proper UUID v4
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(isValidUuidV4(uuid)).toBe(true);
    });

    it('should return false for UUID with extra characters', () => {
      expect(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
    });

    it('should return false for UUID with missing characters', () => {
      expect(isValidUuidV4('550e8400-e29b-41d4-a716')).toBe(false);
    });
  });
});
