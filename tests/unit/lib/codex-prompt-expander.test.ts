/**
 * Tests for codex-prompt-expander (Issue #790)
 *
 * Codex CLI cannot read worktree-local .codex/prompts/* files, so selecting such
 * a prompt expands its body (with argument substitution) and sends it as a plain
 * message instead of a `/prompts:NAME` slash command.
 */

import { describe, it, expect } from 'vitest';
import {
  substituteCodexPromptArgs,
  expandCodexPromptMessage,
} from '@/lib/codex-prompt-expander';
import type { SlashCommandGroup } from '@/types/slash-commands';

describe('substituteCodexPromptArgs', () => {
  it('replaces $ARGUMENTS with the full trimmed args string', () => {
    const result = substituteCodexPromptArgs('Analyze $ARGUMENTS please', '874 875');
    expect(result).toBe('Analyze 874 875 please');
  });

  it('substitutes $1 $2 positional args; missing positions become empty string', () => {
    const result = substituteCodexPromptArgs('First=$1 Second=$2 Third=$3', '874 875');
    expect(result).toBe('First=874 Second=875 Third=');
  });

  it('does not treat $10 as $1 followed by 0', () => {
    // $10 is not a supported placeholder ($1..$9 only) and must be left intact.
    const result = substituteCodexPromptArgs('value=$10', '874 875');
    expect(result).toBe('value=$10');
  });

  it('appends args after a blank line when no placeholder is present', () => {
    const result = substituteCodexPromptArgs('Plain body', '874 875');
    expect(result).toBe('Plain body\n\n874 875');
  });

  it('leaves body unchanged when there is no placeholder and no args', () => {
    const result = substituteCodexPromptArgs('Plain body', '');
    expect(result).toBe('Plain body');
  });

  it('returns only the args when the body is empty (no leading newlines)', () => {
    const result = substituteCodexPromptArgs('', '874 875');
    expect(result).toBe('874 875');
  });
});

describe('expandCodexPromptMessage', () => {
  const groups: SlashCommandGroup[] = [
    {
      category: 'skill',
      label: 'Skills',
      commands: [
        {
          name: 'orchestrate-worker',
          invocation: 'codex-prompt',
          description: 'Orchestrate a worker',
          category: 'skill',
          source: 'codex-skill',
          cliTools: ['codex'],
          filePath: '.codex/prompts/orchestrate-worker.md',
          body: 'Run worker for $ARGUMENTS now',
        },
        {
          name: 'plain-slash',
          invocation: 'slash',
          description: 'Plain slash command',
          category: 'development',
          filePath: '.claude/commands/plain-slash.md',
        },
      ],
    },
  ];

  it('matches a codex-prompt command and expands its body with args', () => {
    const result = expandCodexPromptMessage('/orchestrate-worker 874 875', groups);
    expect(result).toBe('Run worker for 874 875 now');
  });

  it('returns null when the message has no leading slash', () => {
    expect(expandCodexPromptMessage('orchestrate-worker 874 875', groups)).toBeNull();
  });

  it('returns null when the name matches a non-codex-prompt command (send verbatim)', () => {
    expect(expandCodexPromptMessage('/plain-slash arg', groups)).toBeNull();
  });

  it('returns null when no command matches the name', () => {
    expect(expandCodexPromptMessage('/unknown-command 1 2', groups)).toBeNull();
  });
});
