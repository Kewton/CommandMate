/**
 * Tests for slash-commands module
 * TDD: Red phase - write tests first
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import type {
  SlashCommand,
  SlashCommandCategory,
  SlashCommandGroup,
} from '@/types/slash-commands';

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

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
    it('should accept valid category values including skill', () => {
      const categories: SlashCommandCategory[] = [
        'planning',
        'development',
        'review',
        'documentation',
        'workflow',
        'skill',
      ];

      expect(categories).toHaveLength(6);
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

  it('should parse valid cliTools from command frontmatter', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-command-cli-tools');
    const commandsDir = path.join(testDir, '.claude', 'commands');
    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(
        path.join(commandsDir, 'shared-command.md'),
        [
          '---',
          'description: Shared command',
          'cliTools:',
          '  - gemini',
          '  - codex',
          '  - invalid-tool',
          '---',
          'Body',
        ].join('\n')
      );

      const { loadSlashCommands } = await import('@/lib/slash-commands');
      const commands = await loadSlashCommands(testDir);
      const shared = commands.find((cmd) => cmd.name === 'shared-command');

      expect(shared).toBeDefined();
      expect(shared?.cliTools).toEqual(['gemini', 'codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
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

    // Each command should have a valid category (commands loaded from MCBD root should not be 'skill')
    const validCategories = ['planning', 'development', 'review', 'documentation', 'workflow'];
    commands.forEach((cmd) => {
      expect(validCategories).toContain(cmd.category);
    });
  });
});

describe('getSlashCommandGroups', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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
      skill: 'Skills',
    };

    groups.forEach((group) => {
      if (labelMap[group.category]) {
        expect(group.label).toBe(labelMap[group.category]);
      }
    });
  });

  it('should integrate skills into command groups', async () => {
    // Create a temporary test directory structure
    const testDir = path.resolve(__dirname, '../fixtures/test-skills-integration');
    const commandsDir = path.join(testDir, '.claude', 'commands');
    const skillsDir = path.join(testDir, '.claude', 'skills', 'my-skill');

    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(
        path.join(commandsDir, 'test-cmd.md'),
        '---\ndescription: Test command\n---\nContent'
      );
      fs.writeFileSync(
        path.join(skillsDir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: My test skill\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const allCommands = groups.flatMap((g) => g.commands);
      const skillCommand = allCommands.find((c) => c.name === 'my-skill');
      expect(skillCommand).toBeDefined();
      expect(skillCommand?.source).toBe('skill');
      expect(skillCommand?.category).toBe('skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should prioritize commands over skills with same name', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-dedup');
    const commandsDir = path.join(testDir, '.claude', 'commands');
    const skillsDir = path.join(testDir, '.claude', 'skills', 'duplicate-name');

    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.mkdirSync(skillsDir, { recursive: true });
      // Command file named "duplicate-name.md"
      fs.writeFileSync(
        path.join(commandsDir, 'duplicate-name.md'),
        '---\ndescription: Command version\n---\nContent'
      );
      // Skill with same name
      fs.writeFileSync(
        path.join(skillsDir, 'SKILL.md'),
        '---\nname: duplicate-name\ndescription: Skill version\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const allCommands = groups.flatMap((g) => g.commands);
      const duplicates = allCommands.filter((c) => c.name === 'duplicate-name');
      // Should only have one entry
      expect(duplicates).toHaveLength(1);
      // Command should win over skill
      expect(duplicates[0].description).toBe('Command version');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('getCachedCommands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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

describe('loadSkills', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load skills from .claude/skills/*/SKILL.md', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-load-skills');
    const skillDir = path.join(testDir, '.claude', 'skills', 'my-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: A skill\n---\nBody'
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-skill');
      expect(skills[0].description).toBe('A skill');
      expect(skills[0].category).toBe('skill');
      expect(skills[0].source).toBe('skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should parse valid cliTools from skill frontmatter', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-skill-cli-tools');
    const skillDir = path.join(testDir, '.claude', 'skills', 'shared-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: shared-skill',
          'description: Shared skill',
          'cliTools:',
          '  - gemini',
          '  - copilot',
          '  - invalid-tool',
          '---',
          'Body',
        ].join('\n')
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].cliTools).toEqual(['gemini', 'copilot']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when skills directory does not exist', async () => {
    const nonExistentDir = path.resolve(__dirname, '../fixtures/nonexistent-dir');
    const { loadSkills } = await import('@/lib/slash-commands');
    const skills = await loadSkills(nonExistentDir);

    expect(skills).toEqual([]);
  });

  it('should skip invalid SKILL.md files gracefully', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-invalid-skills');
    const skillDir = path.join(testDir, '.claude', 'skills', 'broken-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      // No SKILL.md file in this directory
      fs.writeFileSync(path.join(skillDir, 'README.md'), 'Not a skill file');

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toEqual([]);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should reject entries containing ".."', async () => {
    // This test verifies the path traversal guard
    const testDir = path.resolve(__dirname, '../fixtures/test-dotdot');
    const skillsDir = path.join(testDir, '.claude', 'skills');
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      // Create a directory with ".." in the name (this should be rejected)
      const badDir = path.join(skillsDir, '..evil');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(
        path.join(badDir, 'SKILL.md'),
        '---\nname: evil\ndescription: Malicious\n---\n'
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      // The "..evil" directory should be rejected
      const evilSkill = skills.find((s) => s.name === 'evil');
      expect(evilSkill).toBeUndefined();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should enforce MAX_SKILLS_COUNT limit', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-max-skills');
    const skillsDir = path.join(testDir, '.claude', 'skills');
    try {
      // Create 102 skill directories (over the 100 limit)
      for (let i = 0; i < 102; i++) {
        const dir = path.join(skillsDir, `skill-${String(i).padStart(3, '0')}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: skill-${i}\ndescription: Skill ${i}\n---\n`
        );
      }

      mockLogger.warn.mockClear();

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills.length).toBeLessThanOrEqual(100);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip oversized SKILL.md files', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-oversized');
    const skillDir = path.join(testDir, '.claude', 'skills', 'big-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      // Create a file larger than 64KB
      const bigContent = '---\nname: big\ndescription: Big\n---\n' + 'x'.repeat(70000);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), bigContent);

      mockLogger.warn.mockClear();

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should truncate long name and description', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-truncate');
    const skillDir = path.join(testDir, '.claude', 'skills', 'long-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      const longName = 'a'.repeat(200);
      const longDesc = 'b'.repeat(600);
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${longName}\ndescription: ${longDesc}\n---\n`
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toHaveLength(1);
      // Name should be truncated to MAX_SKILL_NAME_LENGTH (100)
      expect(skills[0].name.length).toBeLessThanOrEqual(100);
      // Description should be truncated to MAX_SKILL_DESCRIPTION_LENGTH (500)
      expect(skills[0].description.length).toBeLessThanOrEqual(500);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should fallback to directory name when no name in frontmatter', async () => {
    // Create a test directory with the .claude/skills structure
    const testDir = path.resolve(__dirname, '../fixtures/test-no-frontmatter');
    const skillDir = path.join(testDir, '.claude', 'skills', 'no-frontmatter');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        'This file has no frontmatter.\nThe name should fallback to the directory name.'
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      const noFrontmatter = skills.find((s) => s.name === 'no-frontmatter');
      expect(noFrontmatter).toBeDefined();
      expect(noFrontmatter?.name).toBe('no-frontmatter');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should sort skills alphabetically by name', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-sort-skills');
    const skillsDir = path.join(testDir, '.claude', 'skills');
    try {
      for (const name of ['zebra', 'alpha', 'middle']) {
        const dir = path.join(skillsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Skill ${name}\n---\n`
        );
      }

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills.map((s) => s.name)).toEqual(['alpha', 'middle', 'zebra']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('extractFrontmatterFields', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should extract name and description from valid frontmatter', async () => {
    const { extractFrontmatterFields } = await import('@/lib/slash-commands');
    const result = extractFrontmatterFields('---\nname: my-skill\ndescription: A skill\n---\nBody');
    expect(result.name).toBe('my-skill');
    expect(result.description).toBe('A skill');
  });

  it('should extract fields from frontmatter with YAML-unfriendly characters', async () => {
    const { extractFrontmatterFields } = await import('@/lib/slash-commands');
    const content =
      '---\nname: release\ndescription: Create a new release\nargument-hint: [version-type] (major|minor|patch) or [version] (e.g., 1.2.3)\n---\nBody';
    const result = extractFrontmatterFields(content);
    expect(result.name).toBe('release');
    expect(result.description).toBe('Create a new release');
  });

  it('should return empty strings when no frontmatter is present', async () => {
    const { extractFrontmatterFields } = await import('@/lib/slash-commands');
    const result = extractFrontmatterFields('No frontmatter here');
    expect(result.name).toBe('');
    expect(result.description).toBe('');
  });

  it('should return empty strings when fields are missing from frontmatter', async () => {
    const { extractFrontmatterFields } = await import('@/lib/slash-commands');
    const result = extractFrontmatterFields('---\nallowed-tools: Bash\n---\nBody');
    expect(result.name).toBe('');
    expect(result.description).toBe('');
  });
});

describe('loadSkills with YAML-unfriendly frontmatter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load skills even when frontmatter contains YAML-unfriendly characters', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-yaml-fallback');
    const skillDir = path.join(testDir, '.claude', 'skills', 'release');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: release\ndescription: Create a new release\nargument-hint: [version-type] (major|minor|patch) or [version] (e.g., 1.2.3)\n---\nBody'
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('release');
      expect(skills[0].description).toBe('Create a new release');
      expect(skills[0].category).toBe('skill');
      expect(skills[0].source).toBe('skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should fallback to directory name when regex extraction finds no name', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-yaml-fallback-noname');
    const skillDir = path.join(testDir, '.claude', 'skills', 'my-tool');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      // Frontmatter with no name field but with YAML-unfriendly content
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nargument-hint: [a] (e.g., 1.2.3)\n---\nBody'
      );

      const { loadSkills } = await import('@/lib/slash-commands');
      const skills = await loadSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-tool');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('safeParseFrontmatter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should parse normal YAML frontmatter', async () => {
    const { safeParseFrontmatter } = await import('@/lib/slash-commands');
    const result = safeParseFrontmatter('---\nname: test\ndescription: desc\n---\nBody');

    expect(result.data.name).toBe('test');
    expect(result.data.description).toBe('desc');
  });

  it('should disable JavaScript engine (---js frontmatter)', async () => {
    const { safeParseFrontmatter } = await import('@/lib/slash-commands');

    // gray-matter with JS engine disabled should throw when attempting JS parsing
    expect(() => {
      safeParseFrontmatter('---js\n{ name: "evil" }\n---\nBody');
    }).toThrow('JavaScript engine is disabled for security');
  });

  it('should disable JavaScript engine (---javascript frontmatter)', async () => {
    const { safeParseFrontmatter } = await import('@/lib/slash-commands');

    expect(() => {
      safeParseFrontmatter('---javascript\nmodule.exports = { name: "evil" }\n---\nBody');
    }).toThrow('JavaScript engine is disabled for security');
  });
});

describe('deduplicateByName', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should register skills first, then override with commands', async () => {
    const { deduplicateByName } = await import('@/lib/slash-commands');

    const skills: SlashCommand[] = [
      {
        name: 'shared-name',
        description: 'Skill version',
        category: 'skill',
        source: 'skill',
        filePath: '.claude/skills/shared-name/SKILL.md',
      },
      {
        name: 'skill-only',
        description: 'Only in skills',
        category: 'skill',
        source: 'skill',
        filePath: '.claude/skills/skill-only/SKILL.md',
      },
    ];

    const commands: SlashCommand[] = [
      {
        name: 'shared-name',
        description: 'Command version',
        category: 'workflow',
        source: 'worktree',
        filePath: '.claude/commands/shared-name.md',
      },
      {
        name: 'cmd-only',
        description: 'Only in commands',
        category: 'development',
        source: 'worktree',
        filePath: '.claude/commands/cmd-only.md',
      },
    ];

    const result = deduplicateByName(skills, commands);

    // Should have 3 unique entries
    expect(result).toHaveLength(3);

    // shared-name should be the command version (override): same name + same
    // (undefined) cliTools, so the command wins.
    const shared = result.find((c) => c.name === 'shared-name');
    expect(shared?.description).toBe('Command version');
    expect(shared?.source).toBe('worktree');

    // skill-only should remain
    const skillOnly = result.find((c) => c.name === 'skill-only');
    expect(skillOnly).toBeDefined();
    expect(skillOnly?.source).toBe('skill');

    // cmd-only should remain
    const cmdOnly = result.find((c) => c.name === 'cmd-only');
    expect(cmdOnly).toBeDefined();
  });

  it('should keep same-name entries with disjoint cliTools (Issue #800)', async () => {
    const { deduplicateByName } = await import('@/lib/slash-commands');

    // Codex skill from .codex/skills/ (cliTools: ['codex'])
    const skills: SlashCommand[] = [
      {
        name: 'orchestrate',
        description: 'Codex orchestrate skill',
        category: 'skill',
        source: 'codex-skill',
        cliTools: ['codex'],
        filePath: '.codex/skills/orchestrate/SKILL.md',
      },
    ];

    // Claude command from .claude/commands/ (cliTools: undefined => Claude-only)
    const commands: SlashCommand[] = [
      {
        name: 'orchestrate',
        description: 'Claude orchestrate command',
        category: 'workflow',
        source: 'worktree',
        filePath: '.claude/commands/orchestrate.md',
      },
    ];

    const result = deduplicateByName(skills, commands);

    // Both entries coexist because their cliTools are disjoint
    expect(result).toHaveLength(2);

    const codexEntry = result.find((c) => c.source === 'codex-skill');
    expect(codexEntry?.description).toBe('Codex orchestrate skill');
    expect(codexEntry?.cliTools).toEqual(['codex']);

    const claudeEntry = result.find((c) => c.cliTools === undefined);
    expect(claudeEntry?.description).toBe('Claude orchestrate command');
    expect(claudeEntry?.source).toBe('worktree');
  });

  it('should override only when name AND cliTools are identical (Issue #800)', async () => {
    const { deduplicateByName } = await import('@/lib/slash-commands');

    const skills: SlashCommand[] = [
      {
        name: 'release',
        description: 'Codex release skill (old)',
        category: 'skill',
        source: 'codex-skill',
        cliTools: ['codex'],
        filePath: '.codex/skills/release/SKILL.md',
      },
    ];

    const commands: SlashCommand[] = [
      {
        name: 'release',
        description: 'Codex release command (new)',
        category: 'workflow',
        source: 'worktree',
        cliTools: ['codex'],
        filePath: '.claude/commands/release.md',
      },
    ];

    const result = deduplicateByName(skills, commands);

    // Same name + same cliTools => later (command) wins, single entry
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Codex release command (new)');
    expect(result[0].source).toBe('worktree');
  });

  it('should treat cliTools order as irrelevant when deduplicating (Issue #800)', async () => {
    const { deduplicateByName } = await import('@/lib/slash-commands');

    const skills: SlashCommand[] = [
      {
        name: 'shared',
        description: 'Skill version',
        category: 'skill',
        source: 'skill',
        cliTools: ['codex', 'gemini'],
        filePath: '.claude/skills/shared/SKILL.md',
      },
    ];

    const commands: SlashCommand[] = [
      {
        name: 'shared',
        description: 'Command version',
        category: 'workflow',
        source: 'worktree',
        cliTools: ['gemini', 'codex'],
        filePath: '.claude/commands/shared.md',
      },
    ];

    const result = deduplicateByName(skills, commands);

    // Same name + same cliTools set (different order) => command overrides
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Command version');
  });
});

describe('loadCodexSkills', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when skills directory does not exist', async () => {
    const nonExistentDir = path.resolve(__dirname, '../fixtures/nonexistent-codex-dir');
    const { loadCodexSkills } = await import('@/lib/slash-commands');
    const skills = await loadCodexSkills(nonExistentDir);

    expect(skills).toEqual([]);
  });

  it('should load Codex skills with source codex-skill and cliTools codex', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-skills');
    const skillDir = path.join(testDir, '.codex', 'skills', 'my-codex-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: my-codex-skill\ndescription: A Codex skill\n---\nBody'
      );

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-codex-skill');
      expect(skills[0].description).toBe('A Codex skill');
      expect(skills[0].category).toBe('skill');
      expect(skills[0].source).toBe('codex-skill');
      expect(skills[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should use os.homedir() when basePath is not provided', async () => {
    // We test by mocking os.homedir to a temp dir with .codex/skills
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-homedir');
    const skillDir = path.join(testDir, '.codex', 'skills', 'home-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: home-skill\ndescription: Home skill\n---\nBody'
      );

      // Mock os.homedir to return our test directory
      vi.doMock('os', async () => {
        const actual = await vi.importActual<typeof import('os')>('os');
        return { ...actual, homedir: () => testDir };
      });

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('home-skill');
      expect(skills[0].source).toBe('codex-skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip directories containing ".." (path traversal defense)', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-dotdot');
    const skillsDir = path.join(testDir, '.codex', 'skills');
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      const badDir = path.join(skillsDir, '..evil');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(
        path.join(badDir, 'SKILL.md'),
        '---\nname: evil\ndescription: Malicious\n---\n'
      );

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      const evilSkill = skills.find((s) => s.name === 'evil');
      expect(evilSkill).toBeUndefined();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip oversized SKILL.md files', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-oversized');
    const skillDir = path.join(testDir, '.codex', 'skills', 'big-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      const bigContent = '---\nname: big\ndescription: Big\n---\n' + 'x'.repeat(70000);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), bigContent);

      mockLogger.warn.mockClear();

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should enforce MAX_SKILLS_COUNT limit', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-max-skills');
    const skillsDir = path.join(testDir, '.codex', 'skills');
    try {
      for (let i = 0; i < 102; i++) {
        const dir = path.join(skillsDir, `skill-${String(i).padStart(3, '0')}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: skill-${i}\ndescription: Skill ${i}\n---\n`
        );
      }

      mockLogger.warn.mockClear();

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills.length).toBeLessThanOrEqual(100);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should sort skills alphabetically by name', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-sort');
    const skillsDir = path.join(testDir, '.codex', 'skills');
    try {
      for (const name of ['zebra', 'alpha', 'middle']) {
        const dir = path.join(skillsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Skill ${name}\n---\n`
        );
      }

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills.map((s) => s.name)).toEqual(['alpha', 'middle', 'zebra']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('loadCodexSkills .system subdirectory', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load skills from .system/ subdirectory', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-system');
    const systemSkillDir = path.join(testDir, '.codex', 'skills', '.system', 'built-in-skill');
    try {
      fs.mkdirSync(systemSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(systemSkillDir, 'SKILL.md'),
        '---\nname: built-in-skill\ndescription: A built-in Codex skill\n---\nBody'
      );

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('built-in-skill');
      expect(skills[0].source).toBe('codex-skill');
      expect(skills[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load both .system/ and top-level skills', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-mixed');
    const systemSkillDir = path.join(testDir, '.codex', 'skills', '.system', 'sys-skill');
    const topSkillDir = path.join(testDir, '.codex', 'skills', 'user-skill');
    try {
      fs.mkdirSync(systemSkillDir, { recursive: true });
      fs.mkdirSync(topSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(systemSkillDir, 'SKILL.md'),
        '---\nname: sys-skill\ndescription: System skill\n---\n'
      );
      fs.writeFileSync(
        path.join(topSkillDir, 'SKILL.md'),
        '---\nname: user-skill\ndescription: User skill\n---\n'
      );

      const { loadCodexSkills } = await import('@/lib/slash-commands');
      const skills = await loadCodexSkills(testDir);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toEqual(['sys-skill', 'user-skill']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('loadAgentsSkills', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when skills directory does not exist', async () => {
    const nonExistentDir = path.resolve(__dirname, '../fixtures/nonexistent-agents-dir');
    const { loadAgentsSkills } = await import('@/lib/slash-commands');
    const skills = await loadAgentsSkills(nonExistentDir);

    expect(skills).toEqual([]);
  });

  it('should load .agents/skills with source codex-skill and cliTools codex', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-agents-skills');
    const skillDir = path.join(testDir, '.agents', 'skills', 'my-agents-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: my-agents-skill\ndescription: An agents skill\n---\nBody'
      );

      const { loadAgentsSkills } = await import('@/lib/slash-commands');
      const skills = await loadAgentsSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-agents-skill');
      expect(skills[0].description).toBe('An agents skill');
      expect(skills[0].category).toBe('skill');
      expect(skills[0].source).toBe('codex-skill');
      expect(skills[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should use os.homedir() when basePath is not provided', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-agents-homedir');
    const skillDir = path.join(testDir, '.agents', 'skills', 'home-agents-skill');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: home-agents-skill\ndescription: Home agents skill\n---\nBody'
      );

      vi.doMock('os', async () => {
        const actual = await vi.importActual<typeof import('os')>('os');
        return { ...actual, homedir: () => testDir };
      });

      const { loadAgentsSkills } = await import('@/lib/slash-commands');
      const skills = await loadAgentsSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('home-agents-skill');
      expect(skills[0].source).toBe('codex-skill');
      expect(skills[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load built-in skills from .system/ subdirectory', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-agents-system');
    const systemSkillDir = path.join(testDir, '.agents', 'skills', '.system', 'built-in-agents-skill');
    try {
      fs.mkdirSync(systemSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(systemSkillDir, 'SKILL.md'),
        '---\nname: built-in-agents-skill\ndescription: Built-in\n---\nBody'
      );

      const { loadAgentsSkills } = await import('@/lib/slash-commands');
      const skills = await loadAgentsSkills(testDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('built-in-agents-skill');
      expect(skills[0].source).toBe('codex-skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('getSlashCommandGroups with Codex skills', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should include local .agents/skills when basePath is provided', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-agents-groups');
    const agentsSkillDir = path.join(testDir, '.agents', 'skills', 'agents-only-skill');
    try {
      fs.mkdirSync(agentsSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsSkillDir, 'SKILL.md'),
        '---\nname: agents-only-skill\ndescription: Agents skill\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const allCommands = groups.flatMap((g) => g.commands);
      const agentsSkill = allCommands.find((c) => c.name === 'agents-only-skill');
      expect(agentsSkill).toBeDefined();
      expect(agentsSkill?.source).toBe('codex-skill');
      expect(agentsSkill?.cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should deduplicate a skill present in both .agents/skills and .codex/skills', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-agents-codex-dedup');
    const agentsSkillDir = path.join(testDir, '.agents', 'skills', 'shared-skill');
    const codexSkillDir = path.join(testDir, '.codex', 'skills', 'shared-skill');
    try {
      fs.mkdirSync(agentsSkillDir, { recursive: true });
      fs.mkdirSync(codexSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: From agents\n---\nContent'
      );
      fs.writeFileSync(
        path.join(codexSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: From codex\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const shared = groups.flatMap((g) => g.commands).filter((c) => c.name === 'shared-skill');
      expect(shared).toHaveLength(1);
      expect(shared[0].source).toBe('codex-skill');
      expect(shared[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should include local Codex skills when basePath is provided', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-groups');
    const commandsDir = path.join(testDir, '.claude', 'commands');
    const claudeSkillDir = path.join(testDir, '.claude', 'skills', 'claude-skill');
    const codexSkillDir = path.join(testDir, '.codex', 'skills', 'codex-skill');

    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.mkdirSync(claudeSkillDir, { recursive: true });
      fs.mkdirSync(codexSkillDir, { recursive: true });

      fs.writeFileSync(
        path.join(commandsDir, 'test-cmd.md'),
        '---\ndescription: Test command\n---\nContent'
      );
      fs.writeFileSync(
        path.join(claudeSkillDir, 'SKILL.md'),
        '---\nname: claude-skill\ndescription: Claude skill\n---\nContent'
      );
      fs.writeFileSync(
        path.join(codexSkillDir, 'SKILL.md'),
        '---\nname: codex-skill\ndescription: Codex skill\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const allCommands = groups.flatMap((g) => g.commands);
      const codexSkill = allCommands.find((c) => c.name === 'codex-skill');
      expect(codexSkill).toBeDefined();
      expect(codexSkill?.source).toBe('codex-skill');
      expect(codexSkill?.cliTools).toEqual(['codex']);

      const claudeSkill = allCommands.find((c) => c.name === 'claude-skill');
      expect(claudeSkill).toBeDefined();
      expect(claudeSkill?.source).toBe('skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('clearCache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should clear both commandsCache and skillsCache', async () => {
    const { loadSlashCommands, loadSkills, getCachedCommands, clearCache } = await import(
      '@/lib/slash-commands'
    );

    // Load commands and skills to populate caches
    await loadSlashCommands();

    // Verify commands cache is populated
    expect(getCachedCommands()).not.toBeNull();

    // Clear both caches
    clearCache();

    // Verify commands cache is cleared
    expect(getCachedCommands()).toBeNull();
  });
});

describe('getCopilotBuiltinCommands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return an array of Copilot builtin commands', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });

  it('should include /model command with correct properties', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    const modelCmd = commands.find(c => c.name === 'model');
    expect(modelCmd).toBeDefined();
    expect(modelCmd!.category).toBe('standard-config');
    expect(modelCmd!.cliTools).toEqual(['copilot']);
    expect(modelCmd!.source).toBe('builtin');
    expect(modelCmd!.filePath).toBe('');
  });

  it('should set cliTools to ["copilot"] for all commands', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    for (const cmd of commands) {
      expect(cmd.cliTools).toEqual(['copilot']);
    }
  });

  it('should set source to "builtin" for all commands', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    for (const cmd of commands) {
      expect(cmd.source).toBe('builtin');
    }
  });

  it('should include all major Copilot CLI interactive commands', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    const names = commands.map(c => c.name);
    // Models and subagents
    expect(names).toContain('model');
    expect(names).toContain('delegate');
    expect(names).toContain('fleet');
    expect(names).toContain('tasks');
    // Agent environment
    expect(names).toContain('agent');
    expect(names).toContain('mcp');
    // Code
    expect(names).toContain('diff');
    expect(names).toContain('pr');
    expect(names).toContain('review');
    // Session
    expect(names).toContain('compact');
    expect(names).toContain('clear');
    expect(names).toContain('resume');
    // Help
    expect(names).toContain('help');
    expect(names).toContain('version');
    // Other
    expect(names).toContain('plan');
    expect(names).toContain('research');
    expect(names).toContain('exit');
  });

  it('should have more than 40 commands covering all Copilot CLI categories', async () => {
    const { getCopilotBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getCopilotBuiltinCommands();
    expect(commands.length).toBeGreaterThanOrEqual(40);
  });
});

describe('getGeminiBuiltinCommands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return curated Gemini builtin commands', async () => {
    const { getGeminiBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getGeminiBuiltinCommands();

    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });

  it('should include /model with Gemini-specific metadata', async () => {
    const { getGeminiBuiltinCommands } = await import('@/lib/slash-commands');
    const commands = getGeminiBuiltinCommands();
    const modelCmd = commands.find((c) => c.name === 'model');

    expect(modelCmd).toBeDefined();
    expect(modelCmd?.category).toBe('standard-config');
    expect(modelCmd?.cliTools).toEqual(['gemini']);
    expect(modelCmd?.source).toBe('builtin');
  });

  it('should expose the main Gemini interactive commands we rely on in the UI', async () => {
    const { getGeminiBuiltinCommands } = await import('@/lib/slash-commands');
    const names = getGeminiBuiltinCommands().map((c) => c.name);

    expect(names).toContain('model');
    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(names).toContain('rewind');
    expect(names).toContain('theme');
    expect(names).toContain('help');
    expect(names).toContain('quit');
    expect(names).toContain('commands reload');
    expect(names).toContain('memory reload');
    expect(names).toContain('skills reload');
    expect(names).toContain('mcp reload');
  });
});

describe('Issue #586: Copilot builtins must not override Claude standard commands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('getSlashCommandGroups should NOT include Copilot builtin commands in output', async () => {
    // When getSlashCommandGroups is called (with or without basePath),
    // the returned groups should NOT contain any commands with cliTools: ['copilot']
    // and source: 'builtin'. Copilot builtins should be injected only in the API route.
    const testDir = path.resolve(__dirname, '../fixtures/test-586-no-copilot');
    const commandsDir = path.join(testDir, '.claude', 'commands');
    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(
        path.join(commandsDir, 'test-cmd.md'),
        '---\ndescription: Test command\n---\nContent'
      );

      const { getSlashCommandGroups } = await import('@/lib/slash-commands');
      const groups = await getSlashCommandGroups(testDir);

      const allCommands = groups.flatMap((g) => g.commands);
      const copilotBuiltins = allCommands.filter(
        (c) => c.source === 'builtin' && c.cliTools?.includes('copilot')
      );
      expect(copilotBuiltins).toHaveLength(0);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('getSlashCommandGroups without basePath should NOT include Copilot builtins', async () => {
    const { getSlashCommandGroups, clearCache } = await import('@/lib/slash-commands');
    clearCache();
    const groups = await getSlashCommandGroups();

    const allCommands = groups.flatMap((g) => g.commands);
    const copilotBuiltins = allCommands.filter(
      (c) => c.source === 'builtin' && c.cliTools?.includes('copilot')
    );
    expect(copilotBuiltins).toHaveLength(0);
  });

  it('deduplicateByName keeps Claude commands and Copilot builtins separate when names collide (Issue #800)', async () => {
    // Verify that Claude standard command names (clear, model, compact, etc.)
    // are not overwritten by Copilot builtins in deduplicateByName. With the
    // CLI-aware dedup (Issue #800), the Claude (cliTools=undefined) and Copilot
    // (cliTools=['copilot']) versions target disjoint CLI tools, so both survive.
    const { deduplicateByName } = await import('@/lib/slash-commands');

    const claudeCommands: SlashCommand[] = [
      { name: 'clear', description: 'Clear conversation', category: 'standard-session', filePath: '' },
      { name: 'model', description: 'Switch model', category: 'standard-config', filePath: '' },
    ];

    const copilotBuiltins: SlashCommand[] = [
      { name: 'clear', description: 'Copilot clear', category: 'standard-session', cliTools: ['copilot'], filePath: '', source: 'builtin' },
      { name: 'model', description: 'Copilot model', category: 'standard-config', cliTools: ['copilot'], filePath: '', source: 'builtin' },
    ];

    const result = deduplicateByName(copilotBuiltins, claudeCommands);

    // Both the Claude and Copilot versions of each name coexist (disjoint cliTools)
    expect(result.filter((c) => c.name === 'clear')).toHaveLength(2);
    expect(result.filter((c) => c.name === 'model')).toHaveLength(2);

    // The Claude command keeps its undefined cliTools and is not masked
    const claudeClear = result.find((c) => c.name === 'clear' && c.cliTools === undefined);
    expect(claudeClear?.description).toBe('Clear conversation');

    // The Copilot builtin keeps its cliTools scope
    const copilotClear = result.find((c) => c.name === 'clear' && c.cliTools?.includes('copilot'));
    expect(copilotClear?.description).toBe('Copilot clear');
  });
});
