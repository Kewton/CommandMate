/**
 * Issue #4116: `--help`, the embedded guide and the user guides alone say how to use
 * roles: the commands, the exit codes, the shape of `--json`, and how editing, a
 * default and the running session differ.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createRolesCommand } from '@/cli/commands/roles';
import { createInstancesCommand } from '@/cli/commands/instances';
import { createSendCommand } from '@/cli/commands/send';
import { AGENT_OPERATIONS_GUIDE } from '@/cli/docs/agent-operations';
import { AGENT_ROLE_CLI_TOOLS } from '@/types/agent-roles';

function helpOf(command: Command): string {
  let text = '';
  command.configureOutput({ writeOut: (chunk) => void (text += chunk), writeErr: (chunk) => void (text += chunk) });
  command.outputHelp();
  return text;
}

const SUBCOMMANDS = ['list', 'show', 'add', 'edit', 'rm', 'default', 'defaults'];

describe('roles --help', () => {
  const help = helpOf(createRolesCommand());

  it('lists every subcommand, and the entry point attaches the command', () => {
    for (const name of SUBCOMMANDS) expect(help).toContain(name);
    const entry = fs.readFileSync(path.resolve(__dirname, '../../../../src/cli/index.ts'), 'utf8');
    expect(entry).toContain('program.addCommand(createRolesCommand())');
  });

  it('says how editing, a default and a running session differ', () => {
    expect(help).toContain('roles edit');
    expect(help).toContain('roles default');
    expect(help).toContain('set-role');
    expect(help).toContain('fixed when the process starts');
  });

  it('says what --repo accepts, in which order, and how to find a repository', () => {
    expect(help).toContain('--repo is an ID, then a path, then a name');
    expect(help).toContain('commandmate roles defaults');
    for (const code of ['unknown_repository', 'repository_not_registered', 'ambiguous_repository']) {
      expect(help).toContain(code);
    }
  });

  it('states the exit codes, the shape of --json, and the tools', () => {
    expect(help).toMatch(/^ {2}2 {3}bad arguments/m);
    expect(help).toMatch(/^ {2}31 {2}a conflict/m);
    for (const shape of ['bodyFingerprint', 'references', 'impact', 'effective.source', 'success: false']) {
      expect(help).toContain(shape);
    }
    for (const tool of AGENT_ROLE_CLI_TOOLS) expect(help).toContain(tool);
  });

  it('each subcommand has its own help', () => {
    const roles = createRolesCommand();
    const named = (name: string) => roles.commands.find((command) => command.name() === name) as Command;
    expect(helpOf(named('edit'))).toContain('--if-version');
    expect(helpOf(named('default'))).toContain('--inherit');
    expect(helpOf(named('defaults'))).toContain('--tool');
    expect(helpOf(named('add'))).toContain('--stdin');
    expect(helpOf(named('rm'))).toContain('--force');
  });
});

describe('send and instances --help', () => {
  it('send: the condition, what repeating --register does, and the exit codes', () => {
    const help = helpOf(createSendCommand());
    for (const flag of ['--role', '--no-role', '--expect-role-generation', '--expect-role-fingerprint', '--expect-no-role']) {
      expect(help).toContain(flag);
    }
    expect(help).toContain('a condition, not a switch');
    expect(help).toContain('Repeating that command creates nothing');
    expect(help).toContain('exit 32');
    expect(help).toContain('31');
  });

  it('instances: set-role, its pending answer and its shapes', () => {
    const help = helpOf(createInstancesCommand());
    for (const text of ['set-role', '--none', '--inherit', '--no-role', 'applyPending', 'effectiveNext', 'launched', 'exit 31']) {
      expect(help).toContain(text);
    }
  });
});

describe('the documents', () => {
  const REPO = path.resolve(__dirname, '../../../..');
  const docs = [
    ['embedded guide', AGENT_OPERATIONS_GUIDE],
    ['ja guide', fs.readFileSync(path.join(REPO, 'docs/user-guide/cli-operations-guide.md'), 'utf8')],
    ['en guide', fs.readFileSync(path.join(REPO, 'docs/en/user-guide/cli-operations-guide.md'), 'utf8')],
  ] as const;

  it.each(docs)('%s: every form, every code, and the three kinds of error of --repo', (_name, text) => {
    for (const form of [
      'roles list',
      'roles show <role>',
      'roles add <name> (--file <path> | --stdin)',
      'roles edit <role>',
      'roles rm <role> [--force]',
      'roles default <tool> --repo <repository> (--role <role> | --none | --inherit)',
      'roles defaults [--repo <repository>] [--tool <tool>]',
      'set-role',
      'repository_not_registered',
      'roster_changed',
      'version_conflict',
      'applyPending',
      '--expect-role-generation',
      '--repo .',
    ]) {
      expect(text).toContain(form);
    }
    expect(text).toMatch(/\b31\b/);
    expect(text).toMatch(/\b32\b/);
  });
});
