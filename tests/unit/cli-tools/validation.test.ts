/**
 * Unit tests for CLI tool session name validation
 * Issue #4: T2.2 - Session name validation (MF4-001 security critical)
 */

import { describe, it, expect } from 'vitest';
import {
  SESSION_NAME_PATTERN,
  validateSessionName,
} from '@/lib/cli-tools/validation';

describe('Session name validation (T2.2 - MF4-001)', () => {
  describe('SESSION_NAME_PATTERN', () => {
    it('should match valid session names', () => {
      expect(SESSION_NAME_PATTERN.test('mcbd-claude-test')).toBe(true);
      expect(SESSION_NAME_PATTERN.test('mcbd-codex-feature-123')).toBe(true);
      expect(SESSION_NAME_PATTERN.test('mcbd-gemini-main')).toBe(true);
      expect(SESSION_NAME_PATTERN.test('test_session')).toBe(true);
      expect(SESSION_NAME_PATTERN.test('test-session')).toBe(true);
      expect(SESSION_NAME_PATTERN.test('session123')).toBe(true);
    });

    it('should not match session names with special characters', () => {
      expect(SESSION_NAME_PATTERN.test('test;rm -rf')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test$(whoami)')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test`id`')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test|cat')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test&bg')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test>file')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test<file')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test"quote')).toBe(false);
      expect(SESSION_NAME_PATTERN.test("test'quote")).toBe(false);
      expect(SESSION_NAME_PATTERN.test('test space')).toBe(false);
    });

    it('should not match empty string', () => {
      expect(SESSION_NAME_PATTERN.test('')).toBe(false);
    });

    it('should not match session names with slashes', () => {
      expect(SESSION_NAME_PATTERN.test('mcbd-claude-feature/foo')).toBe(false);
      expect(SESSION_NAME_PATTERN.test('path/to/session')).toBe(false);
    });
  });

  describe('validateSessionName', () => {
    it('should not throw for valid session names', () => {
      expect(() => validateSessionName('mcbd-claude-test')).not.toThrow();
      expect(() => validateSessionName('mcbd-codex-feature-123')).not.toThrow();
      expect(() => validateSessionName('session_with_underscore')).not.toThrow();
    });

    it('should throw error for session names with command injection characters', () => {
      expect(() => validateSessionName('test;rm -rf')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('test$(whoami)')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('test`id`')).toThrow(/Invalid session name format/);
    });

    it('should throw error for session names with shell special characters', () => {
      expect(() => validateSessionName('test|cat')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('test&bg')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('test>file')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('test<file')).toThrow(/Invalid session name format/);
    });

    it('should throw error for session names with spaces', () => {
      expect(() => validateSessionName('test session')).toThrow(/Invalid session name format/);
    });

    it('should throw error for session names with slashes (path traversal)', () => {
      expect(() => validateSessionName('mcbd-claude-feature/foo')).toThrow(/Invalid session name format/);
      expect(() => validateSessionName('../../../etc/passwd')).toThrow(/Invalid session name format/);
    });

    it('should include the invalid session name in error message', () => {
      try {
        validateSessionName('test;rm -rf');
      } catch (e) {
        expect((e as Error).message).toContain('test;rm -rf');
      }
    });
  });
});
