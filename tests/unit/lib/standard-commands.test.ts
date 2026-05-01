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
  it('should have 45 standard commands (12 Claude-only + 9 shared + 17 Codex-only + 7 OpenCode-only)', () => {
    expect(STANDARD_COMMANDS.length).toBe(45);
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
    const claudeOnlyCommands = [
      'rewind',
      'config',
      'context',
      'cost',
      'pr-comments',
      'doctor',
      'export',
      'todos',
    ];
    claudeOnlyCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toBeUndefined();
    });
  });

  it('should have commands shared between Claude and Codex', () => {
    const sharedCommands = [
      'clear',
      'compact',
      'resume',
      'model',
      'permissions',
      'status',
      'review',
    ];
    sharedCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(expect.arrayContaining(['claude', 'codex']));
    });
  });

  it('should have commands shared between Claude and OpenCode', () => {
    const sharedCommands = ['compact', 'help'];
    sharedCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(expect.arrayContaining(['claude', 'opencode']));
    });
  });

  it('should have Codex commands with cliTools including "codex"', () => {
    const codexOnlyCommands = [
      'undo',
      'logout',
      'quit',
      'approvals',
      'diff',
      'mention',
      'mcp',
      'init',
      'feedback',
      // Issue #689: new Codex commands
      'plan',
      'goal',
      'agent',
      'subagents',
      'fork',
      'memories',
      'skills',
      'hooks',
    ];
    codexOnlyCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['codex']);
    });
    // /new is shared between Codex and OpenCode
    const newCmd = STANDARD_COMMANDS.find((c) => c.name === 'new');
    expect(newCmd).toBeDefined();
    expect(newCmd?.cliTools).toEqual(expect.arrayContaining(['codex', 'opencode']));
  });

  it('should have OpenCode-only commands with cliTools: ["opencode"]', () => {
    const opencodeOnlyCommands = [
      'sessions',
      'connect',
      'exit',
      'models',
      'agents',
      'themes',
      'editor',
    ];
    opencodeOnlyCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['opencode']);
    });
  });

  it('should have 10 commands available for OpenCode', () => {
    const opencodeCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('opencode')
    );
    expect(opencodeCommands.length).toBe(10);
  });

  it('should have 25 commands available for Codex', () => {
    const codexCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('codex')
    );
    expect(codexCommands.length).toBe(25);
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

  // Issue #689: New Claude commands with explicit cliTools: ['claude'] (DR1-001)
  it('should have new Claude-only commands (effort/fast/focus/lazy) with explicit cliTools: ["claude"]', () => {
    const newClaudeCommands = ['effort', 'fast', 'focus', 'lazy'];
    newClaudeCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['claude']);
    });
  });

  it('should have new Claude commands in correct categories (DR1-003)', () => {
    const configCommands = ['effort', 'fast', 'lazy'];
    configCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
    });
    const focusCmd = STANDARD_COMMANDS.find((c) => c.name === 'focus');
    expect(focusCmd).toBeDefined();
    expect(focusCmd?.category).toBe('standard-session');
  });

  // Issue #689: New Codex commands (DR1-004)
  it('should have new Codex commands in correct categories', () => {
    const sessionCommands = ['plan', 'goal', 'agent', 'subagents', 'fork'];
    sessionCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-session');
      expect(cmd?.cliTools).toEqual(['codex']);
    });
    const configCommands = ['memories', 'skills', 'hooks'];
    configCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
      expect(cmd?.cliTools).toEqual(['codex']);
    });
  });

  // Issue #689: Claude display total = 20 (DR2-001)
  it('should have 20 commands available for Claude', () => {
    const claudeCommands = STANDARD_COMMANDS.filter(
      (cmd) => !cmd.cliTools || cmd.cliTools.includes('claude')
    );
    expect(claudeCommands.length).toBe(20);
  });

  // Issue #689: agent (Codex) vs agents (OpenCode) differentiation (DR1-002)
  it('agent (Codex) and agents (OpenCode) should have distinct descriptions', () => {
    const agent = STANDARD_COMMANDS.find((c) => c.name === 'agent');
    const agents = STANDARD_COMMANDS.find((c) => c.name === 'agents');
    expect(agent).toBeDefined();
    expect(agents).toBeDefined();
    expect(agent?.description).not.toBe(agents?.description);
  });

  // Issue #689: Security - allowlist validation (DR4-002)
  it('should have all command names matching allowed pattern /^[a-z][a-z0-9-]*$/', () => {
    const allowedPattern = /^[a-z][a-z0-9-]*$/;
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.name).toMatch(allowedPattern);
    });
  });

  it('should have all commands with source=standard and filePath=""', () => {
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.source).toBe('standard');
      expect(cmd.filePath).toBe('');
    });
  });

  // Issue #689: XSS regression - description safety (DR4-003)
  it('should have all descriptions without HTML tags or dangerous patterns', () => {
    const dangerousPatterns = [/<[^>]+>/, /javascript:/i, /onerror=/i, /onclick=/i];
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.description).toBeTruthy();
      dangerousPatterns.forEach((pattern) => {
        expect(cmd.description).not.toMatch(pattern);
      });
    });
  });

  // Issue #689: new Claude-only 4 commands should not have undefined cliTools (DR1-001)
  it('should not have new commands with undefined cliTools (DR1-001: no new undefined)', () => {
    const newCommandNames = ['effort', 'fast', 'focus', 'lazy', 'plan', 'goal', 'agent', 'subagents', 'fork', 'memories', 'skills', 'hooks'];
    newCommandNames.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toBeDefined();
    });
  });
});

describe('FREQUENTLY_USED', () => {
  it('should be an object with cli tool keys', () => {
    expect(FREQUENTLY_USED).toBeDefined();
    expect(FREQUENTLY_USED.claude).toBeDefined();
    expect(FREQUENTLY_USED.codex).toBeDefined();
    expect(FREQUENTLY_USED.opencode).toBeDefined();
  });

  it('should contain 5 frequently used commands per tool', () => {
    expect(FREQUENTLY_USED.claude.length).toBe(5);
    expect(FREQUENTLY_USED.codex.length).toBe(5);
    expect(FREQUENTLY_USED.opencode.length).toBe(5);
  });

  it('should only contain names that exist in STANDARD_COMMANDS', () => {
    const standardNames = STANDARD_COMMANDS.map((c) => c.name);
    Object.values(FREQUENTLY_USED).forEach((names) => {
      names.forEach((name: string) => {
        expect(standardNames).toContain(name);
      });
    });
  });

  it('Claude frequently used should include clear and compact', () => {
    expect(FREQUENTLY_USED.claude).toContain('clear');
    expect(FREQUENTLY_USED.claude).toContain('compact');
  });

  it('Codex frequently used should include new, undo and plan (not mcp)', () => {
    expect(FREQUENTLY_USED.codex).toContain('new');
    expect(FREQUENTLY_USED.codex).toContain('undo');
    expect(FREQUENTLY_USED.codex).toContain('plan');
    expect(FREQUENTLY_USED.codex).not.toContain('mcp');
  });

  it('OpenCode frequently used should include models, new, compact, help, exit', () => {
    expect(FREQUENTLY_USED.opencode).toContain('models');
    expect(FREQUENTLY_USED.opencode).toContain('new');
    expect(FREQUENTLY_USED.opencode).toContain('compact');
    expect(FREQUENTLY_USED.opencode).toContain('help');
    expect(FREQUENTLY_USED.opencode).toContain('exit');
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

  it('should return OpenCode commands when cliToolId is opencode', () => {
    const commands = getFrequentlyUsedCommands('opencode');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'models')).toBe(true);
    expect(commands.some((c) => c.name === 'new')).toBe(true);
    expect(commands.some((c) => c.name === 'compact')).toBe(true);
    expect(commands.some((c) => c.name === 'help')).toBe(true);
    expect(commands.some((c) => c.name === 'exit')).toBe(true);
    // All returned commands should be available for OpenCode
    commands.forEach((cmd) => {
      expect(cmd.cliTools).toContain('opencode');
    });
  });

  it('should not return Claude-only commands for OpenCode', () => {
    const commands = getFrequentlyUsedCommands('opencode');
    // 'clear' is Claude-only (no cliTools), should not be in OpenCode list
    expect(commands.some((c) => c.name === 'clear')).toBe(false);
  });
});
