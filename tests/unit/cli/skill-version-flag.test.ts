/**
 * skill `--version` flag routing (regression)
 * Issue #1462: `commandmate skill info/plan/install <id> --version <v>` in SPACE
 * form was swallowed by the root program's `--version` flag (from `.version()`),
 * which printed the CLI version and exited 0 — the subcommand never ran (a silent
 * no-op). `enablePositionalOptions()` on the root makes commander parse root
 * options only before the command name and hand everything after it to the
 * subcommand that owns `--version <v>`.
 *
 * These tests drive the REAL `buildProgram()` (root + `.version()` wired in): the
 * pre-existing skill tests call `createSkillCommand()` directly and so bypass the
 * exact root ↔ subcommand interaction that caused this bug. The subcommand actions
 * are replaced with capturing stubs so nothing contacts a server — the only thing
 * under test is how commander routes the flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CommanderError } from 'commander';

vi.mock('../../../src/cli/commands/quickstart', () => ({ quickstartCommand: vi.fn() }));
vi.mock('../../../src/cli/utils/prompt', () => ({ isInteractive: vi.fn(() => true) }));

import { buildProgram } from '../../../src/cli/program';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../../package.json') as { version: string };

interface Captured {
  name?: string;
  options?: Record<string, unknown>;
}

interface RunResult {
  stdout: string;
  stderr: string;
  error?: CommanderError;
  captured: Captured;
}

/**
 * Parse argv through the real program, capturing which skill subcommand ran and
 * with what options — without invoking its network-backed action.
 */
function run(argv: string[]): RunResult {
  const program = buildProgram();
  let stdout = '';
  let stderr = '';

  program.exitOverride();
  program.configureOutput({
    writeOut: (str: string) => {
      stdout += str;
    },
    writeErr: (str: string) => {
      stderr += str;
    },
  });

  const captured: Captured = {};
  const skill = program.commands.find((cmd) => cmd.name() === 'skill');
  for (const sub of skill?.commands ?? []) {
    // Re-registering an action replaces commander's handler, so the real
    // (server-calling) action never runs; parsing is exercised in full.
    sub.action((...args: unknown[]) => {
      captured.name = sub.name();
      captured.options = args[args.length - 2] as Record<string, unknown>;
    });
  }

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return { stdout, stderr, error: err as CommanderError, captured };
  }
  return { stdout, stderr, captured };
}

describe('skill --version flag routing (#1462)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each([
    { command: 'info', argv: ['skill', 'info', 'cmate-repository-analysis'] },
    {
      command: 'plan',
      argv: ['skill', 'plan', 'cmate-repository-analysis', '--worktree', 'anvil-develop'],
    },
    {
      command: 'install',
      argv: [
        'skill',
        'install',
        'cmate-repository-analysis',
        '--worktree',
        'anvil-develop',
        '--yes',
      ],
    },
  ])('$command', ({ command, argv }) => {
    it('routes the SPACE form `--version 1.2.0` to the subcommand', () => {
      const { captured, stdout, error } = run([...argv, '--version', '1.2.0']);

      // The bug: the root version flag fired, printing the CLI version and exiting 0.
      expect(stdout).not.toContain(pkg.version);
      expect(error?.code).not.toBe('commander.version');

      expect(captured.name).toBe(command);
      expect(captured.options?.version).toBe('1.2.0');
    });

    it('routes the EQUALS form `--version=1.2.0` to the subcommand', () => {
      const { captured, stdout } = run([...argv, '--version=1.2.0']);

      expect(stdout).not.toContain(pkg.version);
      expect(captured.name).toBe(command);
      expect(captured.options?.version).toBe('1.2.0');
    });
  });

  it('still lets the bare root `--version` print the CLI version', () => {
    // The fix must not disturb `commandmate --version` (flag before any command).
    const { stdout, error } = run(['--version']);

    expect(stdout).toContain(pkg.version);
    expect(error?.exitCode).toBe(0);
  });
});
