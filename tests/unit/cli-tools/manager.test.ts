/**
 * Unit tests for CLIToolManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType, ICLITool } from '@/lib/cli-tools/types';

describe('CLIToolManager', () => {
  let manager: CLIToolManager;

  beforeEach(() => {
    manager = CLIToolManager.getInstance();
  });

  describe('Singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = CLIToolManager.getInstance();
      const instance2 = CLIToolManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getTool', () => {
    it('should return ClaudeTool for claude', () => {
      const tool = manager.getTool('claude');
      expect(tool.id).toBe('claude');
      expect(tool.name).toBe('Claude Code');
      expect(tool.command).toBe('claude');
    });

    it('should return CodexTool for codex', () => {
      const tool = manager.getTool('codex');
      expect(tool.id).toBe('codex');
      expect(tool.name).toBe('Codex CLI');
      expect(tool.command).toBe('codex');
    });

    it('should return GeminiTool for gemini', () => {
      const tool = manager.getTool('gemini');
      expect(tool.id).toBe('gemini');
      expect(tool.name).toBe('Gemini CLI');
      expect(tool.command).toBe('gemini');
    });

    it('should return VibeLocalTool for vibe-local', () => {
      const tool = manager.getTool('vibe-local');
      expect(tool.id).toBe('vibe-local');
      expect(tool.name).toBe('Vibe Local');
      expect(tool.command).toBe('vibe-local');
    });

    it('should return the same instance for the same tool type', () => {
      const tool1 = manager.getTool('claude');
      const tool2 = manager.getTool('claude');
      expect(tool1).toBe(tool2);
    });
  });

  describe('getAllTools', () => {
    it('should return all four tools', () => {
      const tools = manager.getAllTools();
      expect(tools).toHaveLength(4);

      const ids = tools.map(t => t.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
      expect(ids).toContain('gemini');
      expect(ids).toContain('vibe-local');
    });

    it('should return tools in consistent order', () => {
      const tools1 = manager.getAllTools();
      const tools2 = manager.getAllTools();

      expect(tools1[0].id).toBe(tools2[0].id);
      expect(tools1[1].id).toBe(tools2[1].id);
      expect(tools1[2].id).toBe(tools2[2].id);
      expect(tools1[3].id).toBe(tools2[3].id);
    });
  });

  describe('getToolInfo', () => {
    it('should return tool info with installation status', async () => {
      const info = await manager.getToolInfo('claude');

      expect(info.id).toBe('claude');
      expect(info.name).toBe('Claude Code');
      expect(info.command).toBe('claude');
      expect(typeof info.installed).toBe('boolean');
    });

    it('should return correct info for all tools', async () => {
      const claudeInfo = await manager.getToolInfo('claude');
      const codexInfo = await manager.getToolInfo('codex');
      const geminiInfo = await manager.getToolInfo('gemini');

      expect(claudeInfo.id).toBe('claude');
      expect(codexInfo.id).toBe('codex');
      expect(geminiInfo.id).toBe('gemini');
    });
  });

  describe('getAllToolsInfo', () => {
    it('should return info for all tools', async () => {
      const allInfo = await manager.getAllToolsInfo();

      expect(allInfo).toHaveLength(4);

      const ids = allInfo.map(info => info.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
      expect(ids).toContain('gemini');
      expect(ids).toContain('vibe-local');
    });

    it('should include installation status for each tool', async () => {
      const allInfo = await manager.getAllToolsInfo();

      allInfo.forEach(info => {
        expect(typeof info.installed).toBe('boolean');
        expect(typeof info.name).toBe('string');
        expect(typeof info.command).toBe('string');
      });
    });
  });

  describe('getInstalledTools', () => {
    it('should return only installed tools', async () => {
      const installed = await manager.getInstalledTools();

      // All returned tools should have installed = true
      for (const info of installed) {
        expect(info.installed).toBe(true);
      }
    });

    it('should return array of tool info', async () => {
      const installed = await manager.getInstalledTools();

      expect(Array.isArray(installed)).toBe(true);

      if (installed.length > 0) {
        const first = installed[0];
        expect(first).toHaveProperty('id');
        expect(first).toHaveProperty('name');
        expect(first).toHaveProperty('command');
        expect(first).toHaveProperty('installed');
      }
    });
  });
});
