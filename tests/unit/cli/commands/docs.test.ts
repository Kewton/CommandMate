/**
 * Unit tests for docs command
 * Issue #264: Documentation retrieval command
 *
 * Tests delegation to DocsReader utility (SF-003 SRP).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDocsCommand } from '../../../../src/cli/commands/docs';

// Mock DocsReader
vi.mock('../../../../src/cli/utils/docs-reader', () => ({
  getAvailableSections: vi.fn(() => ['quick-start', 'commands', 'readme']),
  isValidSection: vi.fn((section: string) => ['quick-start', 'commands', 'readme'].includes(section)),
  readSection: vi.fn((section: string) => `# Content of ${section}`),
  searchDocs: vi.fn((query: string) => {
    if (query === 'test') {
      return [{ section: 'readme', matches: ['test line 1', 'test line 2'] }];
    }
    return [];
  }),
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('docs command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Note: Do NOT use vi.restoreAllMocks() here as it removes module-level spies

  describe('createDocsCommand', () => {
    it('should create a command named "docs"', () => {
      const cmd = createDocsCommand();
      expect(cmd.name()).toBe('docs');
    });
  });

  describe('--all option', () => {
    it('should list all available sections', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['--all'], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleLog).toHaveBeenCalledWith('Available documentation sections:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  - quick-start');
      expect(mockConsoleLog).toHaveBeenCalledWith('  - commands');
      expect(mockConsoleLog).toHaveBeenCalledWith('  - readme');
      expect(mockExit).toHaveBeenCalledWith(0); // SUCCESS
    });
  });

  describe('--section option', () => {
    it('should display section content for valid section', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['--section', 'quick-start'], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleLog).toHaveBeenCalledWith('# Content of quick-start');
      expect(mockExit).toHaveBeenCalledWith(0); // SUCCESS
    });

    it('should error for invalid section', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['--section', 'nonexistent'], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Unknown section'));
      expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR
    });
  });

  describe('--search option', () => {
    it('should display search results', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['--search', 'test'], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Search results'));
      expect(mockConsoleLog).toHaveBeenCalledWith('--- readme ---');
      expect(mockExit).toHaveBeenCalledWith(0); // SUCCESS
    });

    it('should show no results message when nothing found', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse(['--search', 'zzzznoexist'], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('No results found'));
      expect(mockExit).toHaveBeenCalledWith(0); // SUCCESS
    });
  });

  describe('no options', () => {
    it('should show help-like output with available sections', () => {
      const cmd = createDocsCommand();
      cmd.exitOverride();
      try {
        cmd.parse([], { from: 'user' });
      } catch {
        // commander exitOverride throws, ignore
      }

      expect(mockConsoleLog).toHaveBeenCalledWith('CommandMate Documentation');
      expect(mockExit).toHaveBeenCalledWith(0); // SUCCESS
    });
  });
});
