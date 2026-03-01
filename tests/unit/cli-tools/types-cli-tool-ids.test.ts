/**
 * Unit tests for CLI_TOOL_IDS constant and CLIToolType derivation
 * Issue #4: T2.1 - CLI_TOOL_IDS constant
 */

import { describe, it, expect } from 'vitest';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

describe('CLI_TOOL_IDS constant (T2.1)', () => {
  it('should export CLI_TOOL_IDS as const array', () => {
    expect(Array.isArray(CLI_TOOL_IDS)).toBe(true);
  });

  it('should include claude, codex, gemini, vibe-local, and opencode', () => {
    expect(CLI_TOOL_IDS).toContain('claude');
    expect(CLI_TOOL_IDS).toContain('codex');
    expect(CLI_TOOL_IDS).toContain('gemini');
    expect(CLI_TOOL_IDS).toContain('vibe-local');
    expect(CLI_TOOL_IDS).toContain('opencode');
  });

  it('should have exactly 5 items', () => {
    expect(CLI_TOOL_IDS).toHaveLength(5);
  });

  it('should be readonly (const assertion)', () => {
    // Type check: CLI_TOOL_IDS should be readonly
    const ids: readonly string[] = CLI_TOOL_IDS;
    expect(ids).toBe(CLI_TOOL_IDS);
  });

  it('should allow CLIToolType to be derived from CLI_TOOL_IDS', () => {
    // Type check: CLIToolType should be union of CLI_TOOL_IDS values
    const validTypes: CLIToolType[] = ['claude', 'codex', 'gemini', 'vibe-local', 'opencode'];

    // Each value from CLI_TOOL_IDS should be assignable to CLIToolType
    for (const id of CLI_TOOL_IDS) {
      const toolType: CLIToolType = id;
      expect(validTypes).toContain(toolType);
    }
  });

  it('should maintain sync between CLI_TOOL_IDS and CLIToolType', () => {
    // This test ensures CLI_TOOL_IDS and CLIToolType stay in sync
    const cliToolIdsSet = new Set(CLI_TOOL_IDS);
    const expectedTypes = new Set<CLIToolType>(['claude', 'codex', 'gemini', 'vibe-local', 'opencode']);

    expect(cliToolIdsSet.size).toBe(expectedTypes.size);
    for (const id of CLI_TOOL_IDS) {
      expect(expectedTypes.has(id)).toBe(true);
    }
  });
});
