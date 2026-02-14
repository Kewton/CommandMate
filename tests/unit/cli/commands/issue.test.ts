/**
 * Unit tests for issue command
 * Issue #264: gh CLI integration for issue management
 *
 * Tests: template name mapping, input validation, label sanitization,
 * gh CLI availability check, exit codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIssueCommand } from '../../../../src/cli/commands/issue';

// Mock child_process
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('issue command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gh CLI available
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === '--version') {
        return { error: null, status: 0, stdout: 'gh version 2.40.0', stderr: '' };
      }
      return { error: null, status: 0, stdout: '', stderr: '' };
    });
  });

  // Note: Do NOT use vi.restoreAllMocks() here as it removes module-level spies

  describe('createIssueCommand', () => {
    it('should create a command named "issue"', () => {
      const cmd = createIssueCommand();
      expect(cmd.name()).toBe('issue');
    });

    it('should have create, search, and list subcommands', () => {
      const cmd = createIssueCommand();
      const subcommands = cmd.commands.map(c => c.name());
      expect(subcommands).toContain('create');
      expect(subcommands).toContain('search');
      expect(subcommands).toContain('list');
    });
  });

  describe('create subcommand', () => {
    it('should pass --template "Bug Report" for --bug flag', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--bug', '--title', 'Test bug'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      expect(args).toContain('--template');
      expect(args[args.indexOf('--template') + 1]).toBe('Bug Report');
    });

    it('should pass --template "Feature Request" for --feature flag', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--feature', '--title', 'Test feature'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      expect(args).toContain('--template');
      expect(args[args.indexOf('--template') + 1]).toBe('Feature Request');
    });

    it('should pass --template "Question" for --question flag', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--question', '--title', 'Test question'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      expect(args).toContain('--template');
      expect(args[args.indexOf('--template') + 1]).toBe('Question');
    });

    it('should exit with DEPENDENCY_ERROR when gh is not installed', () => {
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === '--version') {
          return { error: new Error('ENOENT'), status: null, stdout: '', stderr: '' };
        }
        return { error: null, status: 0, stdout: '', stderr: '' };
      });

      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', 'Test'], { from: 'user' });
      } catch {
        // exitOverride
      }

      expect(mockExit).toHaveBeenCalledWith(1); // DEPENDENCY_ERROR
    });

    it('[SEC-MF-001] should reject title exceeding 256 characters', () => {
      const longTitle = 'a'.repeat(257);
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', longTitle], { from: 'user' });
      } catch {
        // exitOverride
      }

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Title exceeds maximum length')
      );
      expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR
    });

    it('[SEC-MF-001] should reject body exceeding 65536 characters', () => {
      const longBody = 'b'.repeat(65537);
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', 'Test', '--body', longBody], { from: 'user' });
      } catch {
        // exitOverride
      }

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Body exceeds maximum length')
      );
      expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR
    });

    it('[SEC-SF-001] should sanitize labels with control characters', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', 'Test', '--labels', 'bug\x00,enhancement\x1F'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      if (args.includes('--label')) {
        const labelValue = args[args.indexOf('--label') + 1];
        expect(labelValue).not.toMatch(/[\x00-\x1F]/);
      }
    });

    it('[SEC-SF-001] should sanitize labels with zero-width characters', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', 'Test', '--labels', 'bug\u200B,enhancement\uFEFF'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      if (args.includes('--label')) {
        const labelValue = args[args.indexOf('--label') + 1];
        expect(labelValue).not.toMatch(/[\u200B-\u200F\uFEFF]/);
      }
    });

    it('should pass title and body as separate arguments (no shell injection)', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['create', '--title', 'Test; rm -rf /', '--body', 'Description'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[])[0] === 'issue'
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      // Title should be passed as a single argument, not split by shell
      expect(args).toContain('Test; rm -rf /');
    });
  });

  describe('search subcommand', () => {
    it('should pass query to gh issue list --search', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['search', 'keyword'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[]).includes('--search')
      );
      expect(ghCall).toBeDefined();
      const args = ghCall![1] as string[];
      expect(args).toContain('keyword');
    });
  });

  describe('list subcommand', () => {
    it('should call gh issue list', () => {
      const cmd = createIssueCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['list'], { from: 'user' });
      } catch {
        // exitOverride
      }

      const ghCall = mockSpawnSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'gh' && (call[1] as string[]).includes('list')
      );
      expect(ghCall).toBeDefined();
    });
  });
});
