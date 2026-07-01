/**
 * Unit tests for Antigravity (agy) support in claude-executor.
 * Issue #990 (Phase C): non-interactive scheduled / report execution.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { getCommandForTool, buildCliArgs, ALLOWED_CLI_TOOLS } from '@/lib/session/claude-executor';

describe('getCommandForTool() antigravity', () => {
  it('should return "agy" for antigravity', () => {
    expect(getCommandForTool('antigravity')).toBe('agy');
  });

  it('should still return "gh" for copilot (regression)', () => {
    expect(getCommandForTool('copilot')).toBe('gh');
  });
});

describe('ALLOWED_CLI_TOOLS antigravity', () => {
  it('should include antigravity', () => {
    expect(ALLOWED_CLI_TOOLS.has('antigravity')).toBe(true);
  });
});

describe('buildCliArgs antigravity case', () => {
  it('builds `-p <message> --dangerously-skip-permissions`', () => {
    const args = buildCliArgs('hello world', 'antigravity');
    expect(args).toEqual(['-p', 'hello world', '--dangerously-skip-permissions']);
  });

  it('passes the message verbatim as the -p argument', () => {
    const args = buildCliArgs('multi\nline prompt', 'antigravity');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('multi\nline prompt');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('ignores permission/model options (Phase C uses default behavior)', () => {
    const args = buildCliArgs('hi', 'antigravity', 'acceptEdits', { model: 'Gemini 3.1 Pro' });
    expect(args).toEqual(['-p', 'hi', '--dangerously-skip-permissions']);
  });
});
