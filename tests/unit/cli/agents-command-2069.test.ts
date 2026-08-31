/**
 * The CLI half of Issue #2069: `commandmate agents`, and the Codex CLI row in
 * the preflight dependency list.
 *
 * The dependency row is the smaller half and the one with an explicit
 * acceptance criterion — 「`commandmate init` の出力に Codex CLI の版が出る」 —
 * so it is asserted structurally here (the row exists, with the right command
 * and `required: false`) rather than by scraping `init` output.
 */

import { describe, it, expect } from 'vitest';
import { DEPENDENCIES, getOptionalDependencies, getRequiredDependencies } from '@/cli/config/cli-dependencies';
import { PreflightChecker } from '@/cli/utils/preflight';
import { buildProgram } from '@/cli/program';
import { createAgentsCommand } from '@/cli/commands/agents';
import { UPDATABLE_AGENT_TOOLS } from '@/lib/updates/agent-updater';

describe('[#2069] Codex CLI in the preflight dependency list', () => {
  const codex = DEPENDENCIES.find((dep) => dep.name === 'Codex CLI');

  it('is present — this is what puts a codex version in `commandmate init`', () => {
    expect(codex).toBeDefined();
  });

  it('is probed as `codex --version`', () => {
    expect(codex?.command).toBe('codex');
    expect(codex?.versionArg).toBe('--version');
  });

  it('is OPTIONAL — CommandMate drives codex, it does not require it', () => {
    expect(codex?.required).toBe(false);
    expect(getOptionalDependencies().map((dep) => dep.name)).toContain('Codex CLI');
    expect(getRequiredDependencies().map((dep) => dep.name)).not.toContain('Codex CLI');
  });

  it('does not change which dependencies are required', () => {
    expect(getRequiredDependencies().map((dep) => dep.name)).toEqual([
      'Node.js',
      'npm',
      'tmux',
      'git',
    ]);
  });

  it('has an install hint, so "Not found" tells the reader what to do', () => {
    expect(PreflightChecker.getInstallHint('Codex CLI')).toContain('@openai/codex');
    // Its two siblings arrived in #1907 with no hint at all; they have one now.
    expect(PreflightChecker.getInstallHint('GitHub Copilot CLI')).not.toBe(
      'Please install GitHub Copilot CLI'
    );
    expect(PreflightChecker.getInstallHint('OpenCode CLI')).not.toBe(
      'Please install OpenCode CLI'
    );
  });

  it('leaves every agent CLI in the list optional', () => {
    for (const name of ['Claude CLI', 'Codex CLI', 'OpenCode CLI', 'GitHub Copilot CLI']) {
      expect(DEPENDENCIES.find((dep) => dep.name === name)?.required).toBe(false);
    }
  });
});

describe('[#2069] `commandmate agents`', () => {
  it('is registered on the program', () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names).toContain('agents');
  });

  it('takes an action and a tool, and no other operands', () => {
    const command = createAgentsCommand();
    expect(command.name()).toBe('agents');
    // `[action] [tool]` — both optional so a bare `agents` lists versions.
    expect(command.registeredArguments.map((arg) => arg.name())).toEqual(['action', 'tool']);
  });

  it('exposes --json, --yes and --check', () => {
    const flags = createAgentsCommand().options.map((option) => option.long);
    expect(flags).toEqual(expect.arrayContaining(['--json', '--yes', '--check']));
  });

  it('names the updatable tools in its own help, from the shared allow-list', () => {
    const help = createAgentsCommand().helpInformation();
    for (const tool of UPDATABLE_AGENT_TOOLS) {
      expect(help).toContain(tool);
    }
  });
});
