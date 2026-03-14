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

    // shared-name should be the command version (override)
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

describe('loadCodexPrompts', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when prompts directory does not exist', async () => {
    const nonExistentDir = path.resolve(__dirname, '../fixtures/nonexistent-codex-prompts');
    const { loadCodexPrompts } = await import('@/lib/slash-commands');
    const prompts = await loadCodexPrompts(nonExistentDir);
    expect(prompts).toEqual([]);
  });

  it('should load .md files from .codex/prompts/ with source codex-skill and cliTools codex', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-prompts');
    const promptsDir = path.join(testDir, '.codex', 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptsDir, 'my-prompt.md'),
        '---\ndescription: A custom Codex prompt\n---\nPrompt body'
      );

      const { loadCodexPrompts } = await import('@/lib/slash-commands');
      const prompts = await loadCodexPrompts(testDir);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('my-prompt');
      expect(prompts[0].invocation).toBe('codex-prompt');
      expect(prompts[0].description).toBe('A custom Codex prompt');
      expect(prompts[0].category).toBe('skill');
      expect(prompts[0].source).toBe('codex-skill');
      expect(prompts[0].cliTools).toEqual(['codex']);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should use os.homedir() when basePath is not provided', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-prompts-home');
    const promptsDir = path.join(testDir, '.codex', 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptsDir, 'home-prompt.md'),
        '---\ndescription: Home prompt\n---\nBody'
      );

      vi.doMock('os', async () => {
        const actual = await vi.importActual<typeof import('os')>('os');
        return { ...actual, homedir: () => testDir };
      });

      const { loadCodexPrompts } = await import('@/lib/slash-commands');
      const prompts = await loadCodexPrompts();

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('home-prompt');
      expect(prompts[0].source).toBe('codex-skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip non-.md files', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-prompts-filter');
    const promptsDir = path.join(testDir, '.codex', 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'valid.md'), '---\ndescription: Valid\n---\n');
      fs.writeFileSync(path.join(promptsDir, 'invalid.txt'), 'Not a prompt');

      const { loadCodexPrompts } = await import('@/lib/slash-commands');
      const prompts = await loadCodexPrompts(testDir);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('valid');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip oversized prompt files', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-prompts-big');
    const promptsDir = path.join(testDir, '.codex', 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptsDir, 'big.md'),
        '---\ndescription: Big\n---\n' + 'x'.repeat(70000)
      );

      mockLogger.warn.mockClear();
      const { loadCodexPrompts } = await import('@/lib/slash-commands');
      const prompts = await loadCodexPrompts(testDir);

      expect(prompts).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should sort prompts alphabetically by name', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-codex-prompts-sort');
    const promptsDir = path.join(testDir, '.codex', 'prompts');
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      for (const name of ['zebra', 'alpha', 'middle']) {
        fs.writeFileSync(
          path.join(promptsDir, `${name}.md`),
          `---\ndescription: ${name}\n---\n`
        );
      }

      const { loadCodexPrompts } = await import('@/lib/slash-commands');
      const prompts = await loadCodexPrompts(testDir);

      expect(prompts.map(p => p.name)).toEqual(['alpha', 'middle', 'zebra']);
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
