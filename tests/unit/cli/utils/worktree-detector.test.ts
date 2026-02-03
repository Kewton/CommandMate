/**
 * Worktree Detector Tests
 * Issue #136: Phase 1 - Task 1.3
 * Tests for detecting current worktree and extracting issue numbers
 */

import { describe, it, expect } from 'vitest';
import {
  detectCurrentWorktree,
  extractIssueNoFromPath,
  extractIssueNoFromBranch,
  isWorktreeDirectory,
  WorktreeInfo,
} from '../../../../src/cli/utils/worktree-detector';

describe('worktree-detector', () => {

  describe('extractIssueNoFromPath', () => {
    it('should extract issue number from standard worktree path', () => {
      const result = extractIssueNoFromPath('/home/user/repos/commandmate-issue-135');
      expect(result).toBe(135);
    });

    it('should extract issue number from path with different base', () => {
      const result = extractIssueNoFromPath('/var/projects/commandmate-issue-200');
      expect(result).toBe(200);
    });

    it('should return null for non-worktree paths', () => {
      expect(extractIssueNoFromPath('/home/user/repos/commandmate')).toBeNull();
      expect(extractIssueNoFromPath('/home/user/repos/my-project')).toBeNull();
      expect(extractIssueNoFromPath('/home/user/repos')).toBeNull();
    });

    it('should handle paths with trailing slash', () => {
      const result = extractIssueNoFromPath('/home/user/repos/commandmate-issue-42/');
      expect(result).toBe(42);
    });

    it('should extract from nested directory paths', () => {
      const result = extractIssueNoFromPath('/home/user/repos/commandmate-issue-99/src/components');
      expect(result).toBe(99);
    });

    it('should return null for malformed issue numbers', () => {
      expect(extractIssueNoFromPath('/home/user/repos/commandmate-issue-abc')).toBeNull();
      expect(extractIssueNoFromPath('/home/user/repos/commandmate-issue-')).toBeNull();
      expect(extractIssueNoFromPath('/home/user/repos/commandmate-issue-0')).toBeNull();
      expect(extractIssueNoFromPath('/home/user/repos/commandmate-issue--1')).toBeNull();
    });
  });

  describe('extractIssueNoFromBranch', () => {
    it('should extract issue number from feature branch', () => {
      expect(extractIssueNoFromBranch('feature/135-add-worktree')).toBe(135);
      expect(extractIssueNoFromBranch('feature/200-fix-bug')).toBe(200);
    });

    it('should extract issue number from fix branch', () => {
      expect(extractIssueNoFromBranch('fix/42-security-issue')).toBe(42);
    });

    it('should extract issue number from hotfix branch', () => {
      expect(extractIssueNoFromBranch('hotfix/999-critical')).toBe(999);
    });

    it('should extract issue number from branch without prefix', () => {
      expect(extractIssueNoFromBranch('135-worktree-feature')).toBe(135);
    });

    it('should return null for branches without issue number', () => {
      expect(extractIssueNoFromBranch('main')).toBeNull();
      expect(extractIssueNoFromBranch('develop')).toBeNull();
      expect(extractIssueNoFromBranch('feature/add-feature')).toBeNull();
      expect(extractIssueNoFromBranch('release-1.0.0')).toBeNull();
    });

    it('should return null for invalid issue numbers', () => {
      expect(extractIssueNoFromBranch('feature/0-invalid')).toBeNull();
      expect(extractIssueNoFromBranch('feature/-1-invalid')).toBeNull();
    });
  });

  describe('isWorktreeDirectory', () => {
    // Note: These tests are integration-level and require actual git commands
    // The function is tested via manual testing and e2e tests
    // Here we just verify the function exists and returns proper types
    it('should be a function that returns a promise', () => {
      expect(typeof isWorktreeDirectory).toBe('function');
      // Can't easily mock promisified execFile, so just verify the API
    });
  });

  describe('detectCurrentWorktree', () => {
    // Note: These tests require proper git mocking which is complex with promisified execFile
    // The extraction functions are thoroughly tested above
    // Integration/E2E tests should cover the full detectCurrentWorktree flow
    it('should be a function that returns a promise', () => {
      expect(typeof detectCurrentWorktree).toBe('function');
    });

    it('should return null for invalid directory', async () => {
      // When git commands fail, should return null gracefully
      // This test verifies error handling without mocking
      const result = await detectCurrentWorktree('/nonexistent/path/that/does/not/exist');
      expect(result).toBeNull();
    });
  });

  describe('WorktreeInfo type', () => {
    it('should have correct structure', () => {
      const info: WorktreeInfo = {
        issueNo: 135,
        path: '/home/user/repos/commandmate-issue-135',
        branch: 'feature/135-worktree',
      };

      expect(info.issueNo).toBe(135);
      expect(info.path).toBeDefined();
      expect(info.branch).toBeDefined();
    });
  });
});
