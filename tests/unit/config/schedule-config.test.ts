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
  CLAUDE_PERMISSIONS,
  CODEX_SANDBOXES,
  COPILOT_PERMISSIONS,
  ANTIGRAVITY_PERMISSIONS,
  GEMINI_PERMISSIONS,
  VIBE_LOCAL_PERMISSIONS,
  OPENCODE_PERMISSIONS,
  NO_PERMISSION_FLAGS,
  DEFAULT_PERMISSIONS,
  getPermissionOptionsForTool,
} from '../../../src/config/schedule-config';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

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

  describe('COPILOT_PERMISSIONS', () => {
    it('should contain allow-all-tools and yolo', () => {
      expect(COPILOT_PERMISSIONS).toContain('allow-all-tools');
      expect(COPILOT_PERMISSIONS).toContain('yolo');
    });

    it('should have exactly 2 entries', () => {
      expect(COPILOT_PERMISSIONS).toHaveLength(2);
    });

    it('should be a readonly array', () => {
      // TypeScript enforces this at compile time; at runtime, we check it is an array
      expect(Array.isArray(COPILOT_PERMISSIONS)).toBe(true);
    });
  });

  describe('DEFAULT_PERMISSIONS', () => {
    it('should have copilot default as allow-all-tools', () => {
      expect(DEFAULT_PERMISSIONS['copilot']).toBe('allow-all-tools');
    });

    it('should have antigravity default as --dangerously-skip-permissions (Issue #989)', () => {
      expect(DEFAULT_PERMISSIONS['antigravity']).toBe('--dangerously-skip-permissions');
    });
  });

  describe('ANTIGRAVITY_PERMISSIONS (Issue #989)', () => {
    it('should contain exactly --dangerously-skip-permissions', () => {
      expect(ANTIGRAVITY_PERMISSIONS).toEqual(['--dangerously-skip-permissions']);
    });
  });

  describe('getPermissionOptionsForTool() antigravity (Issue #989)', () => {
    it('should return ANTIGRAVITY_PERMISSIONS for antigravity', () => {
      expect(getPermissionOptionsForTool('antigravity')).toBe(ANTIGRAVITY_PERMISSIONS);
    });
  });
});
/**
 * Issue #1914: `getPermissionOptionsForTool()` used to end in
 * `default: return GEMINI_PERMISSIONS`, so `opencode` — and any tool added to
 * `CLI_TOOL_IDS` afterwards — got the right *value* (`[]`) through a case that
 * named the wrong tool. The same fallback shape in `cmate-parser.ts` /
 * `cmate-validator.ts` resolved to CLAUDE_PERMISSIONS and was a real bug there.
 *
 * These assertions use `toBe` (object identity), which is what makes them
 * non-vacuous: every empty list here is `[]`, so `toEqual` would pass no matter
 * which branch answered.
 */
describe('getPermissionOptionsForTool() resolves through the tool\'s own case (Issue #1914)', () => {
  it.each([
    ['claude', CLAUDE_PERMISSIONS],
    ['codex', CODEX_SANDBOXES],
    ['copilot', COPILOT_PERMISSIONS],
    ['antigravity', ANTIGRAVITY_PERMISSIONS],
    ['gemini', GEMINI_PERMISSIONS],
    ['vibe-local', VIBE_LOCAL_PERMISSIONS],
    ['opencode', OPENCODE_PERMISSIONS],
  ] as const)('%s', (cliToolId, expected) => {
    expect(getPermissionOptionsForTool(cliToolId)).toBe(expected);
  });

  it('every CLI_TOOL_IDS member has its own case (none falls through to default)', () => {
    // Guards the guard: an empty or truncated CLI_TOOL_IDS would make this vacuous.
    expect(CLI_TOOL_IDS.length).toBeGreaterThanOrEqual(7);
    for (const cliToolId of CLI_TOOL_IDS) {
      expect(
        getPermissionOptionsForTool(cliToolId),
        `${cliToolId} fell through to the default branch`
      ).not.toBe(NO_PERMISSION_FLAGS);
    }
  });

  it('an unknown tool gets NO_PERMISSION_FLAGS, not gemini\'s list', () => {
    expect(getPermissionOptionsForTool('not-a-real-tool')).toBe(NO_PERMISSION_FLAGS);
    expect(getPermissionOptionsForTool('not-a-real-tool')).not.toBe(GEMINI_PERMISSIONS);
  });

  it('opencode is not gemini', () => {
    expect(OPENCODE_PERMISSIONS).not.toBe(GEMINI_PERMISSIONS);
    expect(getPermissionOptionsForTool('opencode')).toEqual([]);
  });

  it('DEFAULT_PERMISSIONS has an entry for every CLI tool', () => {
    for (const cliToolId of CLI_TOOL_IDS) {
      expect(DEFAULT_PERMISSIONS[cliToolId], `${cliToolId} has no default`).toBeDefined();
    }
    expect(DEFAULT_PERMISSIONS.opencode).toBe('');
  });

  it('every default is inside its own tool\'s allowed list (or empty)', () => {
    for (const cliToolId of CLI_TOOL_IDS) {
      const fallback = DEFAULT_PERMISSIONS[cliToolId];
      const options = getPermissionOptionsForTool(cliToolId);
      if (fallback === '') {
        expect(options, `${cliToolId} has a default of "" but offers options`).toEqual([]);
      } else {
        expect(options, `${cliToolId}'s default is not one of its options`).toContain(fallback);
      }
    }
  });
});
