/**
 * Unit tests for BaseCLITool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
}));

// テスト用の具象クラス
class TestCLITool extends BaseCLITool {
  readonly id: CLIToolType = 'claude';
  readonly name = 'Test CLI Tool';
  readonly command = 'test-cli';

  async isRunning(worktreeId: string): Promise<boolean> {
    return false;
  }

  async startSession(worktreeId: string, worktreePath: string): Promise<void> {
    // テスト用のスタブ実装
  }

  async sendMessage(worktreeId: string, message: string): Promise<void> {
    // テスト用のスタブ実装
  }

  async killSession(worktreeId: string): Promise<void> {
    // テスト用のスタブ実装
  }
}

describe('BaseCLITool', () => {
  let tool: TestCLITool;

  beforeEach(() => {
    tool = new TestCLITool();
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-claude-feature-foo');
    });

    // T2.3: Session name validation now rejects slashes for security
    it('should throw error for worktree id with slashes (T2.3 - MF4-001)', () => {
      expect(() => tool.getSessionName('feature/bar')).toThrow(/Invalid session name format/);
    });

    it('should use tool id in session name', () => {
      const sessionName = tool.getSessionName('test');
      expect(sessionName).toContain('mcbd-claude-');
    });

    // T2.3: Additional validation tests
    it('should throw error for worktree id with command injection characters (T2.3)', () => {
      expect(() => tool.getSessionName('test;rm -rf')).toThrow(/Invalid session name format/);
      expect(() => tool.getSessionName('test$(whoami)')).toThrow(/Invalid session name format/);
      expect(() => tool.getSessionName('test`id`')).toThrow(/Invalid session name format/);
    });

    it('should allow valid worktree ids with alphanumeric, underscore, and hyphen', () => {
      expect(() => tool.getSessionName('feature-123')).not.toThrow();
      expect(() => tool.getSessionName('test_feature')).not.toThrow();
      expect(() => tool.getSessionName('main')).not.toThrow();
    });

    // Issue #868: instance-aware session naming
    it('should return the base session name for the primary instance (instanceId === id)', () => {
      // Primary instance must be byte-identical to the pre-#868 name.
      expect(tool.getSessionName('feature-foo', 'claude')).toBe('mcbd-claude-feature-foo');
    });

    it('should return the base session name when instanceId is omitted', () => {
      expect(tool.getSessionName('feature-foo')).toBe('mcbd-claude-feature-foo');
    });

    it('should append a derived suffix for additional instances', () => {
      expect(tool.getSessionName('feature-foo', 'claude-2')).toBe('mcbd-claude-feature-foo-2');
      expect(tool.getSessionName('feature-foo', 'claude-review')).toBe('mcbd-claude-feature-foo-review');
    });

    it('should reject an instance suffix containing unsafe characters', () => {
      // A suffix with a slash must be caught by session-name validation.
      expect(() => tool.getSessionName('feature-foo', 'claude-a/b')).toThrow(/Invalid session name format/);
    });
  });

  describe('isInstalled', () => {
    it('should check if command exists', async () => {
      const installed = await tool.isInstalled();
      expect(typeof installed).toBe('boolean');
    });
  });

  describe('interface implementation', () => {
    it('should have required readonly properties', () => {
      expect(tool.id).toBe('claude');
      expect(tool.name).toBe('Test CLI Tool');
      expect(tool.command).toBe('test-cli');
    });

    it('should have required methods', () => {
      expect(typeof tool.isInstalled).toBe('function');
      expect(typeof tool.isRunning).toBe('function');
      expect(typeof tool.startSession).toBe('function');
      expect(typeof tool.sendMessage).toBe('function');
      expect(typeof tool.killSession).toBe('function');
      expect(typeof tool.getSessionName).toBe('function');
      expect(typeof tool.interrupt).toBe('function');
    });
  });

  describe('interrupt', () => {
    it('should have interrupt method defined', () => {
      expect(typeof tool.interrupt).toBe('function');
    });

    it('should be async and return a Promise', async () => {
      const result = tool.interrupt('test-worktree');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
