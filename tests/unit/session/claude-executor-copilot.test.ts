/**
 * Unit tests for getCommandForTool and copilot support in claude-executor
 * Issue #545: [SEC4-008]
 */

import { describe, it, expect } from 'vitest';
import { getCommandForTool, buildCliArgs, ALLOWED_CLI_TOOLS } from '@/lib/session/claude-executor';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { resolveModelOption } from '@/lib/job-executor';

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

  // Issue #588: --model flag support
  it('should include --model flag when options.model is provided', () => {
    const args = buildCliArgs('hello', 'copilot', 'allow-all-tools', { model: 'gpt-4' });
    expect(args).toEqual(['copilot', '--model', 'gpt-4', '-p', 'hello', '--allow-all-tools']);
  });

  it('should not include --model when options.model is undefined', () => {
    const args = buildCliArgs('hello', 'copilot', 'allow-all-tools', {});
    expect(args).toEqual(['copilot', '-p', 'hello', '--allow-all-tools']);
  });

  it('should place --model before -p flag', () => {
    const args = buildCliArgs('test msg', 'copilot', 'yolo', { model: 'o3-pro' });
    const modelIdx = args.indexOf('--model');
    const pIdx = args.indexOf('-p');
    expect(modelIdx).toBeLessThan(pIdx);
    expect(args).toEqual(['copilot', '--model', 'o3-pro', '-p', 'test msg', '--yolo']);
  });
});

// Issue #588: resolveModelOption tests
describe('resolveModelOption (DR1-004)', () => {
  const baseWorktree = { path: '/tmp/wt', vibe_local_model: null };

  it('should return model for copilot entry with model', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'copilot', enabled: true, permission: '', model: 'gpt-4' };
    expect(resolveModelOption(entry, baseWorktree)).toEqual({ model: 'gpt-4' });
  });

  it('should return undefined for copilot entry without model', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'copilot', enabled: true, permission: '' };
    expect(resolveModelOption(entry, baseWorktree)).toBeUndefined();
  });

  it('should return vibe_local_model for vibe-local entry', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'vibe-local', enabled: true, permission: '' };
    const worktree = { path: '/tmp/wt', vibe_local_model: 'llama3' };
    expect(resolveModelOption(entry, worktree)).toEqual({ model: 'llama3' });
  });

  it('should return undefined for vibe-local without DB model', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'vibe-local', enabled: true, permission: '' };
    expect(resolveModelOption(entry, baseWorktree)).toBeUndefined();
  });

  it('should return undefined for claude entry', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'claude', enabled: true, permission: '' };
    expect(resolveModelOption(entry, baseWorktree)).toBeUndefined();
  });

  it('should return undefined for codex entry', () => {
    const entry = { name: 't', cronExpression: '* * * * *', message: 'msg', cliToolId: 'codex', enabled: true, permission: '' };
    expect(resolveModelOption(entry, baseWorktree)).toBeUndefined();
  });
});
