import { describe, it, expect } from 'vitest';
import { getSlashCommandTrigger, resolveCommandDescription } from '@/lib/slash-command-format';
import type { SlashCommand } from '@/types/slash-commands';

/**
 * Minimal SlashCommand factory for trigger tests.
 */
function cmd(overrides: Partial<SlashCommand>): SlashCommand {
  return {
    name: 'example',
    description: 'An example command',
    category: 'skill',
    source: 'skill',
    filePath: '',
    ...overrides,
  };
}

describe('getSlashCommandTrigger', () => {
  it('returns /NAME for non codex-skill commands regardless of CLI tool', () => {
    const command = cmd({ name: 'work-plan', source: 'worktree' });
    expect(getSlashCommandTrigger(command)).toBe('/work-plan');
    expect(getSlashCommandTrigger(command, 'claude')).toBe('/work-plan');
    expect(getSlashCommandTrigger(command, 'antigravity')).toBe('/work-plan');
  });

  it('returns $NAME for codex-skill commands in codex sessions (non-regression, Issue #790)', () => {
    const command = cmd({ name: 'my-skill', source: 'codex-skill', cliTools: ['codex'] });
    expect(getSlashCommandTrigger(command, 'codex')).toBe('$my-skill');
  });

  it('returns $NAME for codex-skill commands when no CLI tool is provided (legacy default)', () => {
    const command = cmd({ name: 'my-skill', source: 'codex-skill', cliTools: ['codex'] });
    expect(getSlashCommandTrigger(command)).toBe('$my-skill');
  });

  it('returns /NAME for codex-skill commands in antigravity sessions (Issue #1504)', () => {
    // .agents/skills entries carry source codex-skill + cliTools ['codex','antigravity'];
    // agy triggers skills with /NAME, not codex's $NAME.
    const command = cmd({
      name: 'my-agents-skill',
      source: 'codex-skill',
      cliTools: ['codex', 'antigravity'],
    });
    expect(getSlashCommandTrigger(command, 'antigravity')).toBe('/my-agents-skill');
    // The same entry in a codex session still uses $NAME.
    expect(getSlashCommandTrigger(command, 'codex')).toBe('$my-agents-skill');
  });
});

describe('resolveCommandDescription', () => {
  const t = (key: string) => `t(${key})`;

  it('translates descriptionKey for built-in commands', () => {
    const command = cmd({ description: undefined, descriptionKey: 'commands.workPlan' });
    expect(resolveCommandDescription(command, t)).toBe('t(commands.workPlan)');
  });

  it('uses the literal description for user-authored commands', () => {
    const command = cmd({ description: 'Literal description' });
    expect(resolveCommandDescription(command, t)).toBe('Literal description');
  });

  it('falls back to an empty string when neither is set', () => {
    const command = cmd({ description: undefined });
    expect(resolveCommandDescription(command, t)).toBe('');
  });
});
