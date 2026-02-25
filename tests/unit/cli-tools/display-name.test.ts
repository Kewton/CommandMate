/**
 * Unit tests for getCliToolDisplayName
 * Issue #368: Display name utility function
 */

import { describe, it, expect } from 'vitest';
import {
  getCliToolDisplayName,
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
