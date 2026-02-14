/**
 * Unit tests for DocsReader utility
 * Issue #264: Documentation retrieval
 *
 * Tests: section validation, file reading, search, path traversal prevention,
 * query length limit (SEC-SF-002).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAvailableSections,
  isValidSection,
  readSection,
  searchDocs,
} from '../../../../src/cli/utils/docs-reader';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn((filePath: string) => {
    if (filePath.includes('quick-start')) {
      return '# Quick Start\nGet started quickly\nInstall commandmate';
    }
    if (filePath.includes('commands-guide')) {
      return '# Commands Guide\nList of commands\ncommandmate start';
    }
    if (filePath.includes('README')) {
      return '# CommandMate\nGit worktree management tool';
    }
    throw new Error('ENOENT: no such file or directory');
  }),
}));

describe('DocsReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAvailableSections', () => {
    it('should return an array of section names', () => {
      const sections = getAvailableSections();
      expect(Array.isArray(sections)).toBe(true);
      expect(sections.length).toBeGreaterThan(0);
    });

    it('should include expected sections', () => {
      const sections = getAvailableSections();
      expect(sections).toContain('quick-start');
      expect(sections).toContain('commands');
      expect(sections).toContain('readme');
      expect(sections).toContain('architecture');
    });
  });

  describe('isValidSection', () => {
    it('should return true for valid sections', () => {
      expect(isValidSection('quick-start')).toBe(true);
      expect(isValidSection('commands')).toBe(true);
      expect(isValidSection('readme')).toBe(true);
    });

    it('should return false for invalid sections', () => {
      expect(isValidSection('nonexistent')).toBe(false);
      expect(isValidSection('')).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      expect(isValidSection('../../../etc/passwd')).toBe(false);
      expect(isValidSection('../../secrets')).toBe(false);
      expect(isValidSection('/etc/passwd')).toBe(false);
      expect(isValidSection('..\\..\\windows\\system32')).toBe(false);
    });
  });

  describe('readSection', () => {
    it('should read content for a valid section', () => {
      const content = readSection('quick-start');
      expect(content).toContain('Quick Start');
    });

    it('should throw for invalid section', () => {
      expect(() => readSection('nonexistent')).toThrow('Invalid section');
    });

    it('should throw for path traversal attempt', () => {
      expect(() => readSection('../../../etc/passwd')).toThrow('Invalid section');
    });
  });

  describe('searchDocs', () => {
    it('should find matches across sections', () => {
      const results = searchDocs('commandmate');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return matching lines', () => {
      const results = searchDocs('Quick Start');
      const quickStartResult = results.find(r => r.section === 'quick-start');
      expect(quickStartResult).toBeDefined();
      expect(quickStartResult!.matches.length).toBeGreaterThan(0);
    });

    it('should be case-insensitive', () => {
      const results = searchDocs('QUICK START');
      const quickStartResult = results.find(r => r.section === 'quick-start');
      expect(quickStartResult).toBeDefined();
    });

    it('should return empty array for no matches', () => {
      const results = searchDocs('zzzznonexistentzzzzz');
      expect(results).toEqual([]);
    });

    it('[SEC-SF-002] should reject queries exceeding 256 characters', () => {
      const longQuery = 'a'.repeat(257);
      expect(() => searchDocs(longQuery)).toThrow('Search query exceeds maximum length');
    });

    it('[SEC-SF-002] should accept queries of exactly 256 characters', () => {
      const maxQuery = 'a'.repeat(256);
      // Should not throw
      expect(() => searchDocs(maxQuery)).not.toThrow();
    });
  });
});
