/**
 * Tests for command-merger module (Issue #56)
 * TDD: Red phase - write tests first
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { mergeCommandGroups, groupByCategory, filterCommandGroups, filterCommandsByCliTool, keyOf, CATEGORY_ORDER } from '@/lib/command-merger';
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

  it('should keep same-name Claude and Codex skills both when scopes are disjoint (Issue #1380)', () => {
    // Regression: .claude/skills/worktree-new (Claude, cliTools undefined) and
    // .agents/skills/worktree-new (Codex, cliTools: ['codex']) share a name.
    // Keyed on name alone the later (Codex) entry silently overrode the Claude
    // one, so Claude Code showed nothing after the CLI-tool filter. They must
    // coexist because their CLI tool scopes are disjoint.
    const claudeSkillGroups: SlashCommandGroup[] = [
      {
        category: 'skill',
        label: 'Skills',
        commands: [
          {
            name: 'worktree-new',
            description: 'Claude worktree-new skill',
            category: 'skill',
            source: 'skill',
            filePath: '.claude/skills/worktree-new/SKILL.md',
          },
        ],
      },
    ];
    const codexSkillGroups: SlashCommandGroup[] = [
      {
        category: 'skill',
        label: 'Skills',
        commands: [
          {
            name: 'worktree-new',
            description: 'Codex worktree-new skill',
            category: 'skill',
            source: 'codex-skill',
            cliTools: ['codex'],
            filePath: '.agents/skills/worktree-new/SKILL.md',
          },
        ],
      },
    ];

    // Claude first, Codex second (matches getSlashCommandGroups ordering)
    const result = mergeCommandGroups(claudeSkillGroups, codexSkillGroups);
    const worktreeNew = result.flatMap((g) => g.commands).filter((c) => c.name === 'worktree-new');

    // Both versions survive the merge
    expect(worktreeNew).toHaveLength(2);

    const claudeEntry = worktreeNew.find((c) => c.cliTools === undefined);
    const codexEntry = worktreeNew.find((c) => c.cliTools?.includes('codex'));
    expect(claudeEntry?.description).toBe('Claude worktree-new skill');
    expect(codexEntry?.description).toBe('Codex worktree-new skill');

    // And each is visible for its own CLI tool after filtering (Issue #1380)
    const claudeNames = filterCommandsByCliTool(result, 'claude').flatMap((g) =>
      g.commands.map((c) => c.name),
    );
    const codexNames = filterCommandsByCliTool(result, 'codex').flatMap((g) =>
      g.commands.map((c) => c.name),
    );
    expect(claudeNames).toContain('worktree-new');
    expect(codexNames).toContain('worktree-new');
  });

  it('should still let a worktree command override a standard command within the same CLI tool scope (SF-1)', () => {
    // SF-1 must not regress: same name + same (Codex) scope => worktree wins.
    const standardCodexGroups: SlashCommandGroup[] = [
      {
        category: 'standard-session',
        label: 'Standard (Session)',
        commands: [
          {
            name: 'compact',
            description: 'Standard compact',
            category: 'standard-session',
            source: 'standard',
            cliTools: ['codex'],
            filePath: '',
          },
        ],
      },
    ];
    const worktreeCodexGroups: SlashCommandGroup[] = [
      {
        category: 'skill',
        label: 'Skills',
        commands: [
          {
            name: 'compact',
            description: 'Worktree compact',
            category: 'skill',
            source: 'worktree',
            cliTools: ['codex'],
            filePath: '.claude/commands/compact.md',
          },
        ],
      },
    ];

    const result = mergeCommandGroups(standardCodexGroups, worktreeCodexGroups);
    const compacts = result.flatMap((g) => g.commands).filter((c) => c.name === 'compact');

    expect(compacts).toHaveLength(1);
    expect(compacts[0].description).toBe('Worktree compact');
    expect(compacts[0].source).toBe('worktree');
  });
});

describe('keyOf', () => {
  it('collapses undefined/empty cliTools to the claude sentinel', () => {
    const undefinedTools: SlashCommand = {
      name: 'x',
      description: '',
      category: 'skill',
      filePath: '',
    };
    const emptyTools: SlashCommand = { ...undefinedTools, cliTools: [] };

    expect(keyOf(undefinedTools)).toBe('x::claude');
    expect(keyOf(emptyTools)).toBe('x::claude');
  });

  it('distinguishes disjoint CLI tool scopes for the same name', () => {
    const claude: SlashCommand = { name: 'x', description: '', category: 'skill', filePath: '' };
    const codex: SlashCommand = { ...claude, cliTools: ['codex'] };

    expect(keyOf(claude)).not.toBe(keyOf(codex));
  });

  it('normalizes cliTools order so equivalent sets share a key', () => {
    const a: SlashCommand = {
      name: 'x',
      description: '',
      category: 'skill',
      filePath: '',
      cliTools: ['codex', 'gemini'],
    };
    const b: SlashCommand = { ...a, cliTools: ['gemini', 'codex'] };

    expect(keyOf(a)).toBe(keyOf(b));
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

describe('CATEGORY_ORDER', () => {
  it('should include skill between workflow and standard-session', () => {
    const workflowIndex = CATEGORY_ORDER.indexOf('workflow');
    const skillIndex = CATEGORY_ORDER.indexOf('skill');
    const standardSessionIndex = CATEGORY_ORDER.indexOf('standard-session');

    expect(skillIndex).toBeGreaterThan(-1);
    expect(skillIndex).toBe(workflowIndex + 1);
    expect(skillIndex).toBe(standardSessionIndex - 1);
  });

  it('should contain skill category', () => {
    expect(CATEGORY_ORDER).toContain('skill');
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

describe('filterCommandsByCliTool', () => {
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
          cliTools: ['claude', 'codex', 'opencode'],
        },
      ],
    },
    {
      category: 'standard-config',
      label: 'Standard (Config)',
      commands: [
        {
          name: 'model',
          description: 'Switch AI model',
          category: 'standard-config',
          isStandard: true,
          source: 'standard',
          filePath: '',
          cliTools: ['claude', 'codex'],
        },
        {
          name: 'help',
          description: 'Show all available commands',
          category: 'standard-util',
          isStandard: true,
          source: 'standard',
          filePath: '',
          cliTools: ['claude', 'opencode'],
        },
      ],
    },
  ];

  it('should keep backward-compatible commands visible for Claude', () => {
    const result = filterCommandsByCliTool(testGroups, 'claude');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(names).toContain('model');
    expect(names).toContain('help');
  });

  it('should show explicitly shared commands for Codex', () => {
    const result = filterCommandsByCliTool(testGroups, 'codex');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).toContain('compact');
    expect(names).toContain('model');
  });

  it('should not leak Claude-only or other-tool commands into Codex', () => {
    const result = filterCommandsByCliTool(testGroups, 'codex');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).not.toContain('clear');
    expect(names).not.toContain('help');
    expect(result).toHaveLength(2);
    expect(result[1].commands).toHaveLength(1);
  });

  // Issue #1504: .agents/skills entries carry cliTools ['codex', 'antigravity'].
  const agentsSkillGroups: SlashCommandGroup[] = [
    {
      category: 'skill',
      label: 'Skills',
      commands: [
        {
          name: 'my-agents-skill',
          description: 'A skill from .agents/skills',
          category: 'skill',
          source: 'codex-skill',
          filePath: '',
          cliTools: ['codex', 'antigravity'],
        },
      ],
    },
  ];

  it('should surface .agents/skills entries in antigravity sessions (Issue #1504)', () => {
    const result = filterCommandsByCliTool(agentsSkillGroups, 'antigravity');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).toContain('my-agents-skill');
  });

  it('should still surface .agents/skills entries in codex sessions (Issue #1504)', () => {
    const result = filterCommandsByCliTool(agentsSkillGroups, 'codex');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).toContain('my-agents-skill');
  });

  it('should not surface .agents/skills entries in claude sessions (Issue #1458 premise)', () => {
    const result = filterCommandsByCliTool(agentsSkillGroups, 'claude');
    const names = result.flatMap((group) => group.commands.map((cmd) => cmd.name));

    expect(names).not.toContain('my-agents-skill');
  });
});
