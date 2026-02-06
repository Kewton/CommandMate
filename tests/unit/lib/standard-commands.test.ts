/**
 * Tests for standard-commands module (Issue #56, Issue #4)
 * TDD: Red phase - write tests first
 *
 * Issue #4: Updated to test CLI tool-specific commands
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  STANDARD_COMMANDS,
  FREQUENTLY_USED,
  getStandardCommandGroups,
  getFrequentlyUsedCommands,
} from '@/lib/standard-commands';
import type { SlashCommandCategory } from '@/types/slash-commands';

describe('STANDARD_COMMANDS', () => {
  it('should have 26 standard commands (16 Claude + 10 Codex)', () => {
    expect(STANDARD_COMMANDS.length).toBe(26);
  });

  it('should have all required properties for each command', () => {
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.name).toBeDefined();
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description).toBeDefined();
      expect(cmd.category).toBeDefined();
      expect(cmd.isStandard).toBe(true);
      expect(cmd.source).toBe('standard');
    });
  });

  it('should have Claude commands without cliTools field (backward compatible)', () => {
    const claudeCommands = [
      'clear',
      'compact',
      'resume',
      'rewind',
      'config',
      'model',
      'permissions',
      'status',
      'context',
      'cost',
      'review',
      'pr-comments',
      'help',
      'doctor',
      'export',
      'todos',
    ];
    claudeCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toBeUndefined();
    });
  });

  it('should have Codex-only commands with cliTools: ["codex"]', () => {
    const codexCommands = [
      'new',
      'undo',
      'logout',
      'quit',
      'approvals',
      'diff',
      'mention',
      'mcp',
      'init',
      'feedback',
    ];
    codexCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['codex']);
    });
  });

  it('should include session management commands', () => {
    const sessionCommands = ['clear', 'compact', 'resume', 'rewind'];
    sessionCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-session');
    });
  });

  it('should include config commands', () => {
    const configCommands = ['config', 'model', 'permissions'];
    configCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
    });
  });

  it('should include monitor commands', () => {
    const monitorCommands = ['status', 'context', 'cost'];
    monitorCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-monitor');
    });
  });

  it('should include git commands', () => {
    const gitCommands = ['review', 'pr-comments'];
    gitCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-git');
    });
  });

  it('should include utility commands', () => {
    const utilCommands = ['help', 'doctor', 'export', 'todos'];
    utilCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-util');
    });
  });

  it('should not have duplicate command names', () => {
    const names = STANDARD_COMMANDS.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });
});

describe('FREQUENTLY_USED', () => {
  it('should be an object with cli tool keys', () => {
    expect(FREQUENTLY_USED).toBeDefined();
    expect(FREQUENTLY_USED.claude).toBeDefined();
    expect(FREQUENTLY_USED.codex).toBeDefined();
  });

  it('should contain 5 frequently used commands per tool', () => {
    expect(FREQUENTLY_USED.claude.length).toBe(5);
    expect(FREQUENTLY_USED.codex.length).toBe(5);
  });

  it('should only contain names that exist in STANDARD_COMMANDS', () => {
    const standardNames = STANDARD_COMMANDS.map((c) => c.name);
    FREQUENTLY_USED.claude.forEach((name: string) => {
      expect(standardNames).toContain(name);
    });
    FREQUENTLY_USED.codex.forEach((name: string) => {
      expect(standardNames).toContain(name);
    });
  });

  it('Claude frequently used should include clear and compact', () => {
    expect(FREQUENTLY_USED.claude).toContain('clear');
    expect(FREQUENTLY_USED.claude).toContain('compact');
  });

  it('Codex frequently used should include new and undo', () => {
    expect(FREQUENTLY_USED.codex).toContain('new');
    expect(FREQUENTLY_USED.codex).toContain('undo');
  });
});

describe('getStandardCommandGroups', () => {
  it('should return groups organized by category', () => {
    const groups = getStandardCommandGroups();
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('should have proper group structure', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      expect(group).toHaveProperty('category');
      expect(group).toHaveProperty('label');
      expect(group).toHaveProperty('commands');
      expect(Array.isArray(group.commands)).toBe(true);
      expect(group.commands.length).toBeGreaterThan(0);
    });
  });

  it('should include standard category groups', () => {
    const groups = getStandardCommandGroups();
    const categories = groups.map((g) => g.category);
    expect(categories).toContain('standard-session');
    expect(categories).toContain('standard-config');
    expect(categories).toContain('standard-monitor');
    expect(categories).toContain('standard-git');
    expect(categories).toContain('standard-util');
  });

  it('should have localized labels for each category', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      expect(group.label).toBeDefined();
      expect(group.label.length).toBeGreaterThan(0);
    });
  });

  it('should mark all commands as standard', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      group.commands.forEach((cmd) => {
        expect(cmd.isStandard).toBe(true);
        expect(cmd.source).toBe('standard');
      });
    });
  });
});

describe('getFrequentlyUsedCommands', () => {
  it('should return Claude frequently used commands by default', () => {
    const commands = getFrequentlyUsedCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((c) => c.name === 'clear')).toBe(true);
    expect(commands.some((c) => c.name === 'compact')).toBe(true);
  });

  it('should return Claude commands when cliToolId is claude', () => {
    const commands = getFrequentlyUsedCommands('claude');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'clear')).toBe(true);
    // All returned commands should be Claude commands (no cliTools or includes 'claude')
    commands.forEach((cmd) => {
      expect(!cmd.cliTools || cmd.cliTools.includes('claude')).toBe(true);
    });
  });

  it('should return Codex commands when cliToolId is codex', () => {
    const commands = getFrequentlyUsedCommands('codex');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'new')).toBe(true);
    expect(commands.some((c) => c.name === 'undo')).toBe(true);
    // All returned commands should be available for Codex
    commands.forEach((cmd) => {
      expect(cmd.cliTools).toContain('codex');
    });
  });

  it('should not return Claude-only commands for Codex', () => {
    const commands = getFrequentlyUsedCommands('codex');
    // 'clear' is Claude-only (no cliTools), should not be in Codex list
    expect(commands.some((c) => c.name === 'clear')).toBe(false);
  });
});
