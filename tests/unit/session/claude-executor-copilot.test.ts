/**
 * Unit tests for getCommandForTool and copilot support in claude-executor
 * Issue #545: [SEC4-008]
 */

import { describe, it, expect } from 'vitest';
import { getCommandForTool, buildCliArgs, ALLOWED_CLI_TOOLS } from '@/lib/session/claude-executor';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

describe('getCommandForTool() [SEC4-008]', () => {
  it('should return "gh" for copilot', () => {
    expect(getCommandForTool('copilot')).toBe('gh');
  });

  it('should return "claude" for claude', () => {
    expect(getCommandForTool('claude')).toBe('claude');
  });

  it('should return identity for unknown tool', () => {
    expect(getCommandForTool('codex')).toBe('codex');
    expect(getCommandForTool('gemini')).toBe('gemini');
    expect(getCommandForTool('opencode')).toBe('opencode');
    expect(getCommandForTool('vibe-local')).toBe('vibe-local');
  });
});

describe('ALLOWED_CLI_TOOLS derivation [DR2-002]', () => {
  it('should contain all CLI_TOOL_IDS', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(ALLOWED_CLI_TOOLS.has(id)).toBe(true);
    }
  });

  it('should have same size as CLI_TOOL_IDS', () => {
    expect(ALLOWED_CLI_TOOLS.size).toBe(CLI_TOOL_IDS.length);
  });

  it('should include copilot', () => {
    expect(ALLOWED_CLI_TOOLS.has('copilot')).toBe(true);
  });
});

describe('buildCliArgs copilot case', () => {
  it('should build correct args for copilot', () => {
    const args = buildCliArgs('hello', 'copilot');
    expect(args).toEqual(['copilot', '-p', 'hello']);
  });
});
