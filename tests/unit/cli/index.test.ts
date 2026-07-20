/**
 * CLI Program Construction Tests
 * Issue #1195: Pin the current top-level CLI behaviour before a root action is wired up.
 *
 * These tests characterise today's behaviour so that adding a root action (which makes
 * commander report `error: too many arguments` instead of `error: unknown command`)
 * is detected as a regression rather than shipped silently.
 */

import { describe, it, expect } from 'vitest';
import type { CommanderError } from 'commander';
import { buildProgram } from '../../../src/cli/program';

interface RunResult {
  stdout: string;
  stderr: string;
  error?: CommanderError;
}

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

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return { stdout, stderr, error: err as CommanderError };
  }

  return { stdout, stderr };
}

describe('buildProgram', () => {
  it('should build a program named commandmate', () => {
    expect(buildProgram().name()).toBe('commandmate');
  });

  it('should return an independent program on each call', () => {
    expect(buildProgram()).not.toBe(buildProgram());
  });

  it('should not parse argv as a side effect of being imported', () => {
    // The entry point (src/cli/index.ts) owns the parse() side effect; buildProgram must stay pure
    // so it can be imported by tests without exiting the process.
    expect(() => buildProgram()).not.toThrow();
  });

  describe('--help', () => {
    it('should write help to stdout and exit 0', () => {
      const { stdout, stderr, error } = run(['--help']);

      expect(error?.exitCode).toBe(0);
      expect(error?.code).toBe('commander.helpDisplayed');
      expect(stdout).toContain('Usage: commandmate');
      expect(stderr).toBe('');
    });

    it('should list the AI tool integration help section', () => {
      const { stdout } = run(['--help']);

      expect(stdout).toContain('AI Tool Integration:');
      expect(stdout).toContain('commandmate docs --section quick-start');
    });
  });

  describe('--version', () => {
    it('should write the package version to stdout and exit 0', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require('../../../package.json') as { version: string };
      const { stdout, error } = run(['--version']);

      expect(error?.exitCode).toBe(0);
      expect(error?.code).toBe('commander.version');
      expect(stdout).toContain(pkg.version);
    });
  });

  describe('subcommand registration', () => {
    const expectedCommands = [
      'init',
      'start',
      'stop',
      'status',
      // Issue #1194: registered in program.ts alongside the other core commands
      'update',
      'issue',
      'docs',
      'ls',
      'send',
      'wait',
      'respond',
      'capture',
      'auto-yes',
      'report',
      'instances',
      // Issue #1237: Skill management (list/info/plan/install/uninstall/status)
      'skill',
    ];

    it.each(expectedCommands)('should register the %s command', (name) => {
      const registered = buildProgram().commands.map((cmd) => cmd.name());
      expect(registered).toContain(name);
    });

    it('should register every expected command and no unexpected ones', () => {
      const registered = buildProgram().commands.map((cmd) => cmd.name());
      expect(registered.sort()).toEqual([...expectedCommands].sort());
    });
  });

  describe('unknown command handling', () => {
    // Regression line for the root-action wiring (T8): once a root action exists, commander
    // reports "error: too many arguments" here unless the operand is handled explicitly.
    it("should report error: unknown command 'bogus'", () => {
      const { stderr, error } = run(['bogus']);

      expect(stderr).toContain("error: unknown command 'bogus'");
      expect(error?.code).toBe('commander.unknownCommand');
      expect(error?.exitCode).toBe(1);
    });

    it('should not report an argument-count error for an unknown command', () => {
      const { stderr } = run(['bogus']);

      expect(stderr).not.toContain('too many arguments');
    });

    it('should reject an unknown option', () => {
      const { stderr, error } = run(['--definitely-not-an-option']);

      expect(stderr).toContain("error: unknown option '--definitely-not-an-option'");
      expect(error?.exitCode).toBe(1);
    });
  });

  describe('no arguments', () => {
    // Current behaviour: no root action => commander falls into help({ error: true }),
    // which writes help to stderr and exits 1 (NOT stdout/exit 0).
    it('should write help to stderr and exit 1', () => {
      const { stdout, stderr, error } = run([]);

      expect(error?.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('Usage: commandmate');
    });
  });
});
