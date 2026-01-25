/**
 * Unit tests for BaseCLITool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';

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

    it('should handle worktree id with slashes', () => {
      const sessionName = tool.getSessionName('feature/bar');
      expect(sessionName).toBe('mcbd-claude-feature/bar');
    });

    it('should use tool id in session name', () => {
      const sessionName = tool.getSessionName('test');
      expect(sessionName).toContain('mcbd-claude-');
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

    it('should be async and return a Promise', () => {
      const result = tool.interrupt('test-worktree');
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
