/**
 * Unit tests for CLI Tool types and interfaces
 */

import { describe, it, expect } from 'vitest';
import type { CLIToolType, ICLITool, CLIToolInfo, IImageCapableCLITool } from '@/lib/cli-tools/types';
import { isImageCapableCLITool } from '@/lib/cli-tools/types';

describe('CLITool Types', () => {
  it('should have valid CLI tool types', () => {
    const types: CLIToolType[] = ['claude', 'codex', 'gemini'];
    expect(types).toHaveLength(3);
    expect(types).toContain('claude');
    expect(types).toContain('codex');
    expect(types).toContain('gemini');
  });

  it('should validate CLI tool type', () => {
    const validTypes: CLIToolType[] = ['claude', 'codex', 'gemini'];

    expect(validTypes.includes('claude')).toBe(true);
    expect(validTypes.includes('codex')).toBe(true);
    expect(validTypes.includes('gemini')).toBe(true);
  });

  it('should define ICLITool interface with required properties', () => {
    // インターフェースの存在確認（型チェックのみ）
    const mockTool: ICLITool = {
      id: 'claude',
      name: 'Test Tool',
      command: 'test',
      isInstalled: async () => true,
      isRunning: async () => false,
      startSession: async () => {},
      sendMessage: async () => {},
      killSession: async () => {},
      getSessionName: () => 'test-session',
      interrupt: async () => {},
    };

    expect(mockTool.id).toBe('claude');
    expect(mockTool.name).toBe('Test Tool');
    expect(mockTool.command).toBe('test');
  });

  it('should identify image-capable tools with isImageCapableCLITool', () => {
    const imageCapableTool: IImageCapableCLITool = {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      isInstalled: async () => true,
      isRunning: async () => false,
      startSession: async () => {},
      sendMessage: async () => {},
      killSession: async () => {},
      getSessionName: () => 'test-session',
      interrupt: async () => {},
      supportsImage: () => true,
      sendMessageWithImage: async () => {},
    };

    expect(isImageCapableCLITool(imageCapableTool)).toBe(true);
  });

  it('should return false for non-image-capable tools with isImageCapableCLITool', () => {
    const regularTool: ICLITool = {
      id: 'codex',
      name: 'Codex CLI',
      command: 'codex',
      isInstalled: async () => true,
      isRunning: async () => false,
      startSession: async () => {},
      sendMessage: async () => {},
      killSession: async () => {},
      getSessionName: () => 'test-session',
      interrupt: async () => {},
    };

    expect(isImageCapableCLITool(regularTool)).toBe(false);
  });

  it('should return false when supportsImage returns false', () => {
    const toolWithFalseSupport: ICLITool & { supportsImage: () => boolean } = {
      id: 'codex',
      name: 'Codex CLI',
      command: 'codex',
      isInstalled: async () => true,
      isRunning: async () => false,
      startSession: async () => {},
      sendMessage: async () => {},
      killSession: async () => {},
      getSessionName: () => 'test-session',
      interrupt: async () => {},
      supportsImage: () => false as unknown as true,
    };

    expect(isImageCapableCLITool(toolWithFalseSupport as ICLITool)).toBe(false);
  });

  it('should define CLIToolInfo interface', () => {
    const toolInfo: CLIToolInfo = {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      installed: true,
    };

    expect(toolInfo.id).toBe('claude');
    expect(toolInfo.installed).toBe(true);
  });
});
