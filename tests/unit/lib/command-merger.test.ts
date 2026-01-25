/**
 * Tests for command-merger module (Issue #56)
 * TDD: Red phase - write tests first
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { mergeCommandGroups, groupByCategory, filterCommandGroups } from '@/lib/command-merger';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';

describe('mergeCommandGroups', () => {
  const standardGroups: SlashCommandGroup[] = [
    {
      category: 'standard-session',
      label: 'Standard (Session)',
      commands: [
        {
          name: 'clear',
          description: 'Clear conversation history',
          category: 'standard-session',
          isStandard: true,
          source: 'standard',
          filePath: '',
        },
        {
          name: 'compact',
          description: 'Compact context',
          category: 'standard-session',
          isStandard: true,
          source: 'standard',
          filePath: '',
        },
      ],
    },
  ];

  const worktreeGroups: SlashCommandGroup[] = [
    {
      category: 'planning',
      label: 'Planning',
      commands: [
        {
          name: 'work-plan',
          description: 'Create work plan',
          category: 'planning',
          source: 'worktree',
          filePath: '.claude/commands/work-plan.md',
        },
      ],
    },
  ];

  it('should merge standard and worktree command groups', () => {
    const result = mergeCommandGroups(standardGroups, worktreeGroups);
    expect(Array.isArray(result)).toBe(true);

    const allCommands = result.flatMap((g) => g.commands);
    const names = allCommands.map((c) => c.name);

    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(names).toContain('work-plan');
  });

  it('should prioritize worktree commands over standard commands', () => {
    const overlappingWorktreeGroups: SlashCommandGroup[] = [
      {
        category: 'planning',
        label: 'Planning',
        commands: [
          {
            name: 'clear', // Same name as standard command
            description: 'Custom clear command',
            category: 'planning',
            source: 'worktree',
            filePath: '.claude/commands/clear.md',
          },
        ],
      },
    ];

    const result = mergeCommandGroups(standardGroups, overlappingWorktreeGroups);
    const allCommands = result.flatMap((g) => g.commands);
    const clearCommand = allCommands.find((c) => c.name === 'clear');

    expect(clearCommand).toBeDefined();
    expect(clearCommand?.source).toBe('worktree');
    expect(clearCommand?.description).toBe('Custom clear command');
  });

  it('should mark source correctly', () => {
    const result = mergeCommandGroups(standardGroups, worktreeGroups);
    const allCommands = result.flatMap((g) => g.commands);

    const standardCmd = allCommands.find((c) => c.name === 'clear');
    const worktreeCmd = allCommands.find((c) => c.name === 'work-plan');

    expect(standardCmd?.source).toBe('standard');
    expect(worktreeCmd?.source).toBe('worktree');
  });

  it('should handle empty standard groups', () => {
    const result = mergeCommandGroups([], worktreeGroups);
    const allCommands = result.flatMap((g) => g.commands);

    expect(allCommands.length).toBe(1);
    expect(allCommands[0].name).toBe('work-plan');
  });

  it('should handle empty worktree groups', () => {
    const result = mergeCommandGroups(standardGroups, []);
    const allCommands = result.flatMap((g) => g.commands);

    expect(allCommands.length).toBe(2);
    expect(allCommands.map((c) => c.name)).toContain('clear');
    expect(allCommands.map((c) => c.name)).toContain('compact');
  });

  it('should handle both empty groups', () => {
    const result = mergeCommandGroups([], []);
    expect(result).toEqual([]);
  });
});

describe('groupByCategory', () => {
  it('should group commands by category', () => {
    const commands: SlashCommand[] = [
      {
        name: 'clear',
        description: 'Clear',
        category: 'standard-session',
        isStandard: true,
        source: 'standard',
        filePath: '',
      },
      {
        name: 'compact',
        description: 'Compact',
        category: 'standard-session',
        isStandard: true,
        source: 'standard',
        filePath: '',
      },
      {
        name: 'work-plan',
        description: 'Work plan',
        category: 'planning',
        source: 'worktree',
        filePath: '.claude/commands/work-plan.md',
      },
    ];

    const groups = groupByCategory(commands);

    expect(groups.length).toBe(2);

    const sessionGroup = groups.find((g) => g.category === 'standard-session');
    const planningGroup = groups.find((g) => g.category === 'planning');

    expect(sessionGroup?.commands.length).toBe(2);
    expect(planningGroup?.commands.length).toBe(1);
  });

  it('should assign proper labels', () => {
    const commands: SlashCommand[] = [
      {
        name: 'clear',
        description: 'Clear',
        category: 'standard-session',
        isStandard: true,
        source: 'standard',
        filePath: '',
      },
    ];

    const groups = groupByCategory(commands);
    expect(groups[0].label).toBeDefined();
    expect(groups[0].label.length).toBeGreaterThan(0);
  });

  it('should handle empty commands array', () => {
    const groups = groupByCategory([]);
    expect(groups).toEqual([]);
  });
});

describe('filterCommandGroups', () => {
  const testGroups: SlashCommandGroup[] = [
    {
      category: 'standard-session',
      label: 'Standard (Session)',
      commands: [
        {
          name: 'clear',
          description: 'Clear conversation history',
          category: 'standard-session',
          isStandard: true,
          source: 'standard',
          filePath: '',
        },
        {
          name: 'compact',
          description: 'Compact context to reduce token usage',
          category: 'standard-session',
          isStandard: true,
          source: 'standard',
          filePath: '',
        },
      ],
    },
    {
      category: 'planning',
      label: 'Planning',
      commands: [
        {
          name: 'work-plan',
          description: 'Create work plan for Issue',
          category: 'planning',
          source: 'worktree',
          filePath: '.claude/commands/work-plan.md',
        },
      ],
    },
  ];

  it('should return all groups when query is empty', () => {
    const result = filterCommandGroups(testGroups, '');
    expect(result).toEqual(testGroups);
  });

  it('should return all groups when query is whitespace only', () => {
    const result = filterCommandGroups(testGroups, '   ');
    expect(result).toEqual(testGroups);
  });

  it('should filter commands by name', () => {
    const result = filterCommandGroups(testGroups, 'clear');
    expect(result.length).toBe(1);
    expect(result[0].commands.length).toBe(1);
    expect(result[0].commands[0].name).toBe('clear');
  });

  it('should filter commands by description', () => {
    const result = filterCommandGroups(testGroups, 'token');
    expect(result.length).toBe(1);
    expect(result[0].commands.length).toBe(1);
    expect(result[0].commands[0].name).toBe('compact');
  });

  it('should be case-insensitive', () => {
    const resultLower = filterCommandGroups(testGroups, 'clear');
    const resultUpper = filterCommandGroups(testGroups, 'CLEAR');
    const resultMixed = filterCommandGroups(testGroups, 'ClEaR');

    expect(resultLower).toEqual(resultUpper);
    expect(resultLower).toEqual(resultMixed);
  });

  it('should remove groups with no matching commands', () => {
    const result = filterCommandGroups(testGroups, 'work-plan');
    expect(result.length).toBe(1);
    expect(result[0].category).toBe('planning');
  });

  it('should return empty array when no commands match', () => {
    const result = filterCommandGroups(testGroups, 'nonexistent');
    expect(result).toEqual([]);
  });

  it('should match partial strings', () => {
    const result = filterCommandGroups(testGroups, 'conv');
    expect(result.length).toBe(1);
    expect(result[0].commands.length).toBe(1);
    expect(result[0].commands[0].name).toBe('clear');
  });
});
