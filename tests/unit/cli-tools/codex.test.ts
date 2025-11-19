/**
 * Unit tests for CodexTool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodexTool } from '@/lib/cli-tools/codex';
import type { CLIToolType } from '@/lib/cli-tools/types';

describe('CodexTool', () => {
  let tool: CodexTool;

  beforeEach(() => {
    tool = new CodexTool();
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('codex');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Codex CLI');
    });

    it('should have correct command', () => {
      expect(tool.command).toBe('codex');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('codex');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-codex-feature-foo');
    });

    it('should handle worktree id with slashes', () => {
      const sessionName = tool.getSessionName('feature/issue/123');
      expect(sessionName).toBe('mcbd-codex-feature/issue/123');
    });
  });

  describe('isInstalled', () => {
    it('should check if Codex is installed', async () => {
      const installed = await tool.isInstalled();
      expect(typeof installed).toBe('boolean');
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      const running = await tool.isRunning('test-worktree');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
      const running = await tool.isRunning('non-existent-worktree-xyz');
      expect(running).toBe(false);
    });
  });

  describe('Interface implementation', () => {
    it('should implement all required methods', () => {
      expect(typeof tool.isInstalled).toBe('function');
      expect(typeof tool.isRunning).toBe('function');
      expect(typeof tool.startSession).toBe('function');
      expect(typeof tool.sendMessage).toBe('function');
      expect(typeof tool.killSession).toBe('function');
      expect(typeof tool.getSessionName).toBe('function');
    });

    it('should have readonly properties', () => {
      expect(tool.id).toBe('codex');
      expect(tool.name).toBe('Codex CLI');
      expect(tool.command).toBe('codex');
    });
  });
});
