/**
 * Log Manager Unit Tests
 * Regression tests for log file management functionality
 *
 * Issue #11: Verify existing createLog/readLog/listLogs/appendToLog behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises before importing the module under test
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  },
}));

// Mock date-fns format to return deterministic values
vi.mock('date-fns', () => ({
  format: vi.fn((date: Date, pattern: string) => {
    if (pattern === 'yyyy-MM-dd') return '2025-01-20';
    if (pattern === 'yyyy-MM-dd HH:mm:ss') return '2025-01-20 10:30:00';
    return '';
  }),
}));

// Mock log-config to return a deterministic path
vi.mock('@/config/log-config', () => ({
  getLogDir: vi.fn(() => '/mock/data/logs'),
}));

import fs from 'fs/promises';
import {
  createLog,
  readLog,
  listLogs,
  appendToLog,
  getLogFilePath,
  cleanupOldLogs,
} from '@/lib/log-manager';

describe('log-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getLogFilePath', () => {
    it('should return path with worktreeId, date, and default cliToolId', () => {
      const result = getLogFilePath('feature-foo');
      expect(result).toBe(
        path.join('/mock/data/logs', 'claude', 'feature-foo-2025-01-20.md')
      );
    });

    it('should return path with specified cliToolId', () => {
      const result = getLogFilePath('feature-foo', 'codex');
      expect(result).toBe(
        path.join('/mock/data/logs', 'codex', 'feature-foo-2025-01-20.md')
      );
    });

    it('should return path for gemini cliToolId', () => {
      const result = getLogFilePath('my-worktree', 'gemini');
      expect(result).toBe(
        path.join('/mock/data/logs', 'gemini', 'my-worktree-2025-01-20.md')
      );
    });
  });

  describe('createLog', () => {
    it('should create a new log file with header when file does not exist', async () => {
      // Arrange: fs.access succeeds (directory exists), readFile fails (file not found)
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // Act
      const result = await createLog(
        'feature-foo',
        'Hello Claude',
        'Here is my response',
        'claude'
      );

      // Assert
      expect(result).toBe(
        path.join('/mock/data/logs', 'claude', 'feature-foo-2025-01-20.md')
      );
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Claude Code Conversation Log: feature-foo');
      expect(writtenContent).toContain('Created: 2025-01-20 10:30:00');
      expect(writtenContent).toContain('### User');
      expect(writtenContent).toContain('Hello Claude');
      expect(writtenContent).toContain('### Claude');
      expect(writtenContent).toContain('Here is my response');
    });

    it('should append conversation to existing log file', async () => {
      // Arrange: directory exists, file already has content
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        '# Claude Code Conversation Log: feature-foo\n\nCreated: 2025-01-20 09:00:00\n\n---\n\n'
      );
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // Act
      const result = await createLog(
        'feature-foo',
        'Second message',
        'Second response',
        'claude'
      );

      // Assert
      expect(result).toBe(
        path.join('/mock/data/logs', 'claude', 'feature-foo-2025-01-20.md')
      );
      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      // Should preserve existing content
      expect(writtenContent).toContain('Created: 2025-01-20 09:00:00');
      // Should append new conversation
      expect(writtenContent).toContain('Second message');
      expect(writtenContent).toContain('Second response');
    });

    it('should use Codex CLI tool name for codex cliToolId', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await createLog('my-wt', 'msg', 'resp', 'codex');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Codex CLI Conversation Log: my-wt');
      expect(writtenContent).toContain('### Codex');
    });

    it('should use Gemini CLI tool name for gemini cliToolId', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await createLog('my-wt', 'msg', 'resp', 'gemini');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Gemini CLI Conversation Log: my-wt');
      expect(writtenContent).toContain('### Gemini');
    });

    it('should default to claude when cliToolId is not specified', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await createLog('my-wt', 'msg', 'resp');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Claude Code Conversation Log: my-wt');
    });

    it('should create log directory if it does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await createLog('feature-foo', 'msg', 'resp', 'claude');

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'claude'),
        { recursive: true }
      );
    });

    it('should include conversation separator (---)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await createLog('wt', 'msg', 'resp', 'claude');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      // Header has --- and conversation ends with ---
      const separatorCount = (writtenContent.match(/---/g) || []).length;
      expect(separatorCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('readLog', () => {
    it('should return file content when log file exists', async () => {
      const mockContent = '# Claude Code Conversation Log\n\nSome content';
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const result = await readLog('feature-foo', 'claude');

      expect(result).toBe(mockContent);
      expect(fs.readFile).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'claude', 'feature-foo-2025-01-20.md'),
        'utf-8'
      );
    });

    it('should return null when log file does not exist', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await readLog('nonexistent-wt', 'claude');

      expect(result).toBeNull();
    });

    it('should default to claude cliToolId', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('content');

      await readLog('feature-foo');

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'claude', 'feature-foo-2025-01-20.md'),
        'utf-8'
      );
    });

    it('should use correct path for codex cliToolId', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('content');

      await readLog('feature-foo', 'codex');

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'codex', 'feature-foo-2025-01-20.md'),
        'utf-8'
      );
    });
  });

  describe('listLogs', () => {
    it('should list log files for a specific worktree and cliToolId', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'feature-foo-2025-01-20.md',
        'feature-foo-2025-01-19.md',
        'other-wt-2025-01-20.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const result = await listLogs('feature-foo', 'claude');

      // Only feature-foo files should be included
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('feature-foo-2025-01-20.md');
      expect(result[1]).toContain('feature-foo-2025-01-19.md');
    });

    it('should return files sorted in reverse order (most recent first)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'wt-2025-01-18.md',
        'wt-2025-01-20.md',
        'wt-2025-01-19.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const result = await listLogs('wt', 'claude');

      expect(result).toHaveLength(3);
      // After sort().reverse(), most recent should be first
      expect(result[0]).toContain('wt-2025-01-20.md');
      expect(result[1]).toContain('wt-2025-01-19.md');
      expect(result[2]).toContain('wt-2025-01-18.md');
    });

    it('should search all tool directories when cliToolId is "all"', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['wt-2025-01-20.md'] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
        .mockResolvedValueOnce(['wt-2025-01-19.md'] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
        .mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const result = await listLogs('wt', 'all');

      // Should have called readdir for claude, codex, gemini
      expect(fs.readdir).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(2);
    });

    it('should default to "all" when cliToolId is not specified', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      await listLogs('wt');

      // Should be called 3 times (claude, codex, gemini)
      expect(fs.readdir).toHaveBeenCalledTimes(3);
    });

    it('should return empty array when no log files match', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'other-wt-2025-01-20.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const result = await listLogs('feature-foo', 'claude');

      expect(result).toHaveLength(0);
    });

    it('should handle directory read errors gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

      const result = await listLogs('wt', 'claude');

      expect(result).toHaveLength(0);
    });

    it('should create log directory if it does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      await listLogs('wt', 'claude');

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'claude'),
        { recursive: true }
      );
    });
  });

  describe('appendToLog', () => {
    it('should append content to existing log file', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        '# Claude Code Conversation Log: wt\n\nCreated: 2025-01-20 09:00:00\n\n---\n\n'
      );
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'Additional notes here', 'claude');

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      // Should contain original content
      expect(writtenContent).toContain('Created: 2025-01-20 09:00:00');
      // Should contain appended content
      expect(writtenContent).toContain('Additional notes here');
    });

    it('should create header when appending to non-existent file', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'First content', 'claude');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Claude Code Conversation Log: wt');
      expect(writtenContent).toContain('Created: 2025-01-20 10:30:00');
      expect(writtenContent).toContain('First content');
    });

    it('should use correct tool name for codex header', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'content', 'codex');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Codex CLI Conversation Log: wt');
    });

    it('should use correct tool name for gemini header', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'content', 'gemini');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Gemini CLI Conversation Log: wt');
    });

    it('should default to claude cliToolId', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'content');

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(writtenContent).toContain('# Claude Code Conversation Log: wt');
    });

    it('should ensure log directory exists before writing', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await appendToLog('wt', 'content', 'claude');

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('/mock/data/logs', 'claude'),
        { recursive: true }
      );
    });
  });

  describe('cleanupOldLogs', () => {
    it('should delete files older than specified days', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'wt-2025-01-20.md',
        'wt-old.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const now = new Date();
      const oldDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000); // 31 days old
      const recentDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day old

      vi.mocked(fs.stat)
        .mockResolvedValueOnce({ mtime: recentDate } as Awaited<ReturnType<typeof fs.stat>>)
        .mockResolvedValueOnce({ mtime: oldDate } as Awaited<ReturnType<typeof fs.stat>>);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const deleted = await cleanupOldLogs(30);

      // Should delete only the old file (for each tool directory that has it)
      expect(fs.unlink).toHaveBeenCalled();
      expect(deleted).toBeGreaterThanOrEqual(1);
    });

    it('should iterate over all tool directories', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      await cleanupOldLogs(30);

      // Should check claude, codex, gemini directories
      expect(fs.readdir).toHaveBeenCalledTimes(3);
    });

    it('should return 0 when no files to delete', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const deleted = await cleanupOldLogs(30);

      expect(deleted).toBe(0);
    });

    it('should skip non-md files', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'file.txt',
        'data.json',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      await cleanupOldLogs(30);

      expect(fs.stat).not.toHaveBeenCalled();
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully per tool directory', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const deleted = await cleanupOldLogs(30);

      expect(deleted).toBe(0);
    });

    it('should default to 30 days', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        'wt-old.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const now = new Date();
      const oldDate = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000); // 29 days old (should NOT be deleted)

      vi.mocked(fs.stat).mockResolvedValue({
        mtime: oldDate,
      } as Awaited<ReturnType<typeof fs.stat>>);

      const deleted = await cleanupOldLogs();

      // 29 days is within 30 day threshold, should not be deleted
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(deleted).toBe(0);
    });
  });
});
