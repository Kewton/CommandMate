/**
 * Unit tests for getCliToolDisplayName, isCliToolType, getCliToolDisplayNameSafe
 * Issue #368: Display name utility functions
 */

import { describe, it, expect } from 'vitest';
import {
  getCliToolDisplayName,
  getCliToolDisplayNameSafe,
  isCliToolType,
  CLI_TOOL_DISPLAY_NAMES,
  CLI_TOOL_IDS,
  type CLIToolType,
} from '@/lib/cli-tools/types';

describe('CLI_TOOL_DISPLAY_NAMES', () => {
  it('should have an entry for every CLI_TOOL_IDS member', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(CLI_TOOL_DISPLAY_NAMES).toHaveProperty(id);
      expect(typeof CLI_TOOL_DISPLAY_NAMES[id]).toBe('string');
    }
  });

  it('should have correct display names', () => {
    expect(CLI_TOOL_DISPLAY_NAMES.claude).toBe('Claude');
    expect(CLI_TOOL_DISPLAY_NAMES.codex).toBe('Codex');
    expect(CLI_TOOL_DISPLAY_NAMES.gemini).toBe('Gemini');
    expect(CLI_TOOL_DISPLAY_NAMES['vibe-local']).toBe('Vibe Local');
  });
});

describe('getCliToolDisplayName()', () => {
  it('should return correct display name for claude', () => {
    expect(getCliToolDisplayName('claude')).toBe('Claude');
  });

  it('should return correct display name for codex', () => {
    expect(getCliToolDisplayName('codex')).toBe('Codex');
  });

  it('should return correct display name for gemini', () => {
    expect(getCliToolDisplayName('gemini')).toBe('Gemini');
  });

  it('should return correct display name for vibe-local (hyphenated ID)', () => {
    expect(getCliToolDisplayName('vibe-local')).toBe('Vibe Local');
  });

  it('should return a non-empty string for all CLI tool IDs', () => {
    for (const id of CLI_TOOL_IDS) {
      const displayName = getCliToolDisplayName(id);
      expect(displayName).toBeTruthy();
      expect(displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('isCliToolType()', () => {
  it('should return true for all valid CLI tool IDs', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(isCliToolType(id)).toBe(true);
    }
  });

  it('should return false for an unknown string', () => {
    expect(isCliToolType('unknown-tool')).toBe(false);
  });

  it('should return false for an empty string', () => {
    expect(isCliToolType('')).toBe(false);
  });

  it('should return false for a string with extra whitespace', () => {
    expect(isCliToolType(' claude ')).toBe(false);
  });

  it('should return true for vibe-local (hyphenated ID)', () => {
    expect(isCliToolType('vibe-local')).toBe(true);
  });
});

describe('getCliToolDisplayNameSafe()', () => {
  it('should return display name for valid CLI tool ID', () => {
    expect(getCliToolDisplayNameSafe('claude')).toBe('Claude');
    expect(getCliToolDisplayNameSafe('codex')).toBe('Codex');
    expect(getCliToolDisplayNameSafe('gemini')).toBe('Gemini');
    expect(getCliToolDisplayNameSafe('vibe-local')).toBe('Vibe Local');
  });

  it('should return default fallback for undefined', () => {
    expect(getCliToolDisplayNameSafe(undefined)).toBe('Assistant');
  });

  it('should return default fallback for empty string', () => {
    expect(getCliToolDisplayNameSafe('')).toBe('Assistant');
  });

  it('should return default fallback for unknown tool ID', () => {
    expect(getCliToolDisplayNameSafe('unknown-tool')).toBe('Assistant');
  });

  it('should return custom fallback when provided', () => {
    expect(getCliToolDisplayNameSafe(undefined, '')).toBe('');
    expect(getCliToolDisplayNameSafe('', 'N/A')).toBe('N/A');
    expect(getCliToolDisplayNameSafe('unknown', 'Custom')).toBe('Custom');
  });
});
