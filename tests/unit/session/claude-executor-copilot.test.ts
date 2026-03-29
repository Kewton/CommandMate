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
  it('should build args with --allow-all-tools when permission is not specified (fallback)', () => {
    const args = buildCliArgs('hello', 'copilot');
    expect(args).toEqual(['copilot', '-p', 'hello', '--allow-all-tools']);
  });

  it('should build args with --allow-all-tools when permission is allow-all-tools', () => {
    const args = buildCliArgs('hello', 'copilot', 'allow-all-tools');
    expect(args).toEqual(['copilot', '-p', 'hello', '--allow-all-tools']);
  });

  it('should build args with --yolo when permission is yolo', () => {
    const args = buildCliArgs('hello', 'copilot', 'yolo');
    expect(args).toEqual(['copilot', '-p', 'hello', '--yolo']);
  });

  it('should fallback to --allow-all-tools for invalid permission (SEC4-001)', () => {
    const args = buildCliArgs('hello', 'copilot', 'invalid-perm');
    expect(args).toEqual(['copilot', '-p', 'hello', '--allow-all-tools']);
  });

  it('should fallback to --allow-all-tools for empty string permission', () => {
    const args = buildCliArgs('hello', 'copilot', '');
    expect(args).toEqual(['copilot', '-p', 'hello', '--allow-all-tools']);
  });
});
