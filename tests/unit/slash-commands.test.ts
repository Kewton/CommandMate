/**
 * Tests for slash-commands module
 * TDD: Red phase - write tests first
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SlashCommand,
  SlashCommandCategory,
  SlashCommandGroup,
} from '@/types/slash-commands';

describe('SlashCommand Types', () => {
  describe('SlashCommand interface', () => {
    it('should have required properties', () => {
      const command: SlashCommand = {
        name: 'work-plan',
        description: 'Issue単位の具体的な作業計画立案',
        category: 'planning',
        model: 'opus',
        filePath: '.claude/commands/work-plan.md',
      };

      expect(command.name).toBe('work-plan');
      expect(command.description).toBe('Issue単位の具体的な作業計画立案');
      expect(command.category).toBe('planning');
      expect(command.model).toBe('opus');
      expect(command.filePath).toBe('.claude/commands/work-plan.md');
    });

    it('should allow optional properties', () => {
      const command: SlashCommand = {
        name: 'test-cmd',
        description: 'Test command',
        category: 'development',
        filePath: '.claude/commands/test.md',
        // model is optional
      };

      expect(command.model).toBeUndefined();
    });
  });

  describe('SlashCommandCategory type', () => {
    it('should accept valid category values', () => {
      const categories: SlashCommandCategory[] = [
        'planning',
        'development',
        'review',
        'documentation',
        'workflow',
      ];

      expect(categories).toHaveLength(5);
    });
  });

  describe('SlashCommandGroup interface', () => {
    it('should group commands by category', () => {
      const group: SlashCommandGroup = {
        category: 'planning',
        label: 'Planning',
        commands: [
          {
            name: 'work-plan',
            description: 'Work plan command',
            category: 'planning',
            filePath: '.claude/commands/work-plan.md',
          },
        ],
      };

      expect(group.category).toBe('planning');
      expect(group.label).toBe('Planning');
      expect(group.commands).toHaveLength(1);
    });
  });
});

describe('loadSlashCommands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load commands from .claude/commands/*.md files', async () => {
    const { loadSlashCommands } = await import('@/lib/slash-commands');
    const commands = await loadSlashCommands();

    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });

  it('should parse frontmatter correctly', async () => {
    const { loadSlashCommands } = await import('@/lib/slash-commands');
    const commands = await loadSlashCommands();

    // Find work-plan command
    const workPlan = commands.find((cmd) => cmd.name === 'work-plan');
    expect(workPlan).toBeDefined();
    expect(workPlan?.description).toBe('Issue単位の具体的な作業計画立案');
    expect(workPlan?.model).toBe('sonnet');
  });

  it('should extract command name from filename', async () => {
    const { loadSlashCommands } = await import('@/lib/slash-commands');
    const commands = await loadSlashCommands();

    // All commands should have names without .md extension
    commands.forEach((cmd) => {
      expect(cmd.name).not.toContain('.md');
      expect(cmd.name).not.toContain('/');
    });
  });

  it('should categorize commands correctly', async () => {
    const { loadSlashCommands } = await import('@/lib/slash-commands');
    const commands = await loadSlashCommands();

    // Each command should have a valid category
    const validCategories = ['planning', 'development', 'review', 'documentation', 'workflow'];
    commands.forEach((cmd) => {
      expect(validCategories).toContain(cmd.category);
    });
  });
});

describe('getSlashCommandGroups', () => {
  it('should group commands by category', async () => {
    const { getSlashCommandGroups } = await import('@/lib/slash-commands');
    const groups = await getSlashCommandGroups();

    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);

    // Each group should have category, label and commands
    groups.forEach((group) => {
      expect(group).toHaveProperty('category');
      expect(group).toHaveProperty('label');
      expect(group).toHaveProperty('commands');
      expect(Array.isArray(group.commands)).toBe(true);
    });
  });

  it('should have localized labels for categories', async () => {
    const { getSlashCommandGroups } = await import('@/lib/slash-commands');
    const groups = await getSlashCommandGroups();

    const labelMap: Record<string, string> = {
      planning: 'Planning',
      development: 'Development',
      review: 'Review',
      documentation: 'Documentation',
      workflow: 'Workflow',
    };

    groups.forEach((group) => {
      expect(group.label).toBe(labelMap[group.category]);
    });
  });
});

describe('getCachedCommands', () => {
  it('should return cached commands if available', async () => {
    const { loadSlashCommands, getCachedCommands, clearCache } = await import(
      '@/lib/slash-commands'
    );

    // Clear any existing cache
    clearCache();

    // First call should load commands
    const commands1 = await loadSlashCommands();

    // getCachedCommands should return the cached version
    const cachedCommands = getCachedCommands();

    expect(cachedCommands).toEqual(commands1);
  });

  it('should return null if cache is empty', async () => {
    const { getCachedCommands, clearCache } = await import('@/lib/slash-commands');

    clearCache();
    const cachedCommands = getCachedCommands();

    expect(cachedCommands).toBeNull();
  });
});

describe('filterCommands', () => {
  it('should filter commands by search query', async () => {
    const { loadSlashCommands, filterCommands } = await import('@/lib/slash-commands');
    await loadSlashCommands();

    const filtered = filterCommands('work');
    expect(filtered.length).toBeGreaterThan(0);

    // All filtered commands should contain 'work' in name or description
    filtered.forEach((cmd) => {
      const matchesName = cmd.name.toLowerCase().includes('work');
      const matchesDescription = cmd.description.toLowerCase().includes('work');
      expect(matchesName || matchesDescription).toBe(true);
    });
  });

  it('should return all commands with empty query', async () => {
    const { loadSlashCommands, filterCommands } = await import('@/lib/slash-commands');
    const allCommands = await loadSlashCommands();

    const filtered = filterCommands('');
    expect(filtered).toEqual(allCommands);
  });

  it('should be case-insensitive', async () => {
    const { loadSlashCommands, filterCommands } = await import('@/lib/slash-commands');
    await loadSlashCommands();

    const filteredLower = filterCommands('work');
    const filteredUpper = filterCommands('WORK');
    const filteredMixed = filterCommands('WoRk');

    expect(filteredLower).toEqual(filteredUpper);
    expect(filteredLower).toEqual(filteredMixed);
  });
});
