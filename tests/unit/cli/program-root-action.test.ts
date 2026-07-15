/**
 * Root Action Wiring Tests
 * Issue #1195: bare `commandmate` launches the quickstart, while every pre-existing top-level
 * behaviour (unknown command, help, version) must stay exactly as it was.
 *
 * tests/unit/cli/index.test.ts pins the same behaviour against the real quickstart module;
 * this file mocks the quickstart away to assert the wiring itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CommanderError } from 'commander';

vi.mock('../../../src/cli/commands/quickstart', () => ({ quickstartCommand: vi.fn() }));
vi.mock('../../../src/cli/utils/prompt', () => ({ isInteractive: vi.fn(() => true) }));

// Import after mocking
import { buildProgram } from '../../../src/cli/program';
import { quickstartCommand } from '../../../src/cli/commands/quickstart';
import { isInteractive } from '../../../src/cli/utils/prompt';

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

describe('root action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(quickstartCommand).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no arguments', () => {
    it('should launch the quickstart with browser opening enabled', () => {
      const { error } = run([]);

      expect(quickstartCommand).toHaveBeenCalledWith({ open: true });
      expect(error).toBeUndefined();
    });

    it('should not launch the quickstart when stdin is not a TTY', () => {
      vi.mocked(isInteractive).mockReturnValue(false);

      const { stdout, stderr, error } = run([]);

      expect(quickstartCommand).not.toHaveBeenCalled();
      expect(error?.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('Usage: commandmate');
    });
  });

  describe('--no-open', () => {
    it('should launch the quickstart with browser opening disabled', () => {
      run(['--no-open']);

      expect(quickstartCommand).toHaveBeenCalledWith({ open: false });
    });
  });

  describe('unknown command', () => {
    it("should report error: unknown command 'bogus' rather than an argument-count error", () => {
      const { stderr, error } = run(['bogus']);

      expect(stderr).toContain("error: unknown command 'bogus'");
      expect(stderr).not.toContain('too many arguments');
      expect(error?.code).toBe('commander.unknownCommand');
      expect(error?.exitCode).toBe(1);
      expect(quickstartCommand).not.toHaveBeenCalled();
    });

    it('should report the unknown command when extra operands follow it', () => {
      // Without the trailing variadic argument commander would answer "too many arguments"
      const { stderr, error } = run(['bogus', 'extra']);

      expect(stderr).toContain("error: unknown command 'bogus'");
      expect(stderr).not.toContain('too many arguments');
      expect(error?.exitCode).toBe(1);
    });

    it('should keep commander suggestions for near-miss commands', () => {
      const { stderr } = run(['strat']);

      expect(stderr).toContain("error: unknown command 'strat'");
      expect(stderr).toContain('Did you mean start?');
    });

    it('should still dispatch a known command instead of the quickstart', () => {
      // `status` reaches its own action; the quickstart must not run for known commands
      const program = buildProgram();
      const statusCommand = program.commands.find((cmd) => cmd.name() === 'status');

      expect(statusCommand).toBeDefined();
      expect(quickstartCommand).not.toHaveBeenCalled();
    });
  });

  describe('help command', () => {
    // commander drops its implicit `help [command]` once a root action exists, which silently
    // turned `commandmate help` into "error: unknown command 'help'".
    // (`help <subcommand>` is covered by the CLI smoke check: the subcommand owns its own
    // output configuration, so it cannot be captured through the root program here.)
    it('should treat help as a command rather than an unknown one', () => {
      const { stdout, stderr, error } = run(['help']);

      expect(stderr).not.toContain("unknown command 'help'");
      expect(stdout).toContain('Usage: commandmate');
      expect(error?.exitCode).toBe(0);
      expect(quickstartCommand).not.toHaveBeenCalled();
    });

    it('should keep listing the help command in --help', () => {
      const { stdout } = run(['--help']);

      expect(stdout).toContain('help [command]');
      expect(stdout).toContain('display help for command');
    });
  });

  describe('help output', () => {
    it('should keep the usage line free of a duplicated [command]', () => {
      const { stdout } = run(['--help']);

      expect(stdout).toContain('Usage: commandmate [options] [command]\n');
      expect(stdout).not.toContain('[command] [command]');
      expect(stdout).not.toContain('[args...]');
    });

    it('should not add an Arguments section for the root operands', () => {
      const { stdout } = run(['--help']);

      expect(stdout).not.toContain('Arguments:');
    });

    it('should document --no-open', () => {
      const { stdout } = run(['--help']);

      expect(stdout).toContain('--no-open');
      expect(stdout).toContain('Do not open the browser automatically');
    });

    it('should exit 0 without launching the quickstart', () => {
      const { error } = run(['--help']);

      expect(error?.exitCode).toBe(0);
      expect(quickstartCommand).not.toHaveBeenCalled();
    });
  });

  describe('--version', () => {
    it('should print the version without launching the quickstart', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require('../../../package.json') as { version: string };
      const { stdout, error } = run(['--version']);

      expect(stdout).toContain(pkg.version);
      expect(error?.exitCode).toBe(0);
      expect(quickstartCommand).not.toHaveBeenCalled();
    });
  });
});
