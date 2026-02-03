/**
 * Input Validators Tests
 * Issue #136: Phase 1 - Foundation
 * Tests for input validation functions
 */

import { describe, it, expect } from 'vitest';
import {
  validateIssueNo,
  validateBranchName,
  MAX_ISSUE_NO,
  BRANCH_NAME_PATTERN,
} from '../../../../src/cli/utils/input-validators';

describe('input-validators', () => {

  describe('validateIssueNo', () => {
    describe('valid inputs', () => {
      it('should accept positive integer', () => {
        expect(() => validateIssueNo(1)).not.toThrow();
        expect(() => validateIssueNo(100)).not.toThrow();
        expect(() => validateIssueNo(12345)).not.toThrow();
      });

      it('should accept MAX_ISSUE_NO', () => {
        expect(() => validateIssueNo(2147483647)).not.toThrow();
      });
    });

    describe('invalid inputs', () => {
      it('should reject non-integer types', () => {
        expect(() => validateIssueNo('123')).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo(null)).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo(undefined)).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo({})).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo([])).toThrow('INVALID_ISSUE_NO');
      });

      it('should reject floating point numbers', () => {
        expect(() => validateIssueNo(1.5)).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo(3.14159)).toThrow('INVALID_ISSUE_NO');
      });

      it('should reject zero', () => {
        expect(() => validateIssueNo(0)).toThrow('ISSUE_NO_OUT_OF_RANGE');
      });

      it('should reject negative numbers', () => {
        expect(() => validateIssueNo(-1)).toThrow('ISSUE_NO_OUT_OF_RANGE');
        expect(() => validateIssueNo(-100)).toThrow('ISSUE_NO_OUT_OF_RANGE');
      });

      it('should reject numbers exceeding MAX_ISSUE_NO', () => {
        expect(() => validateIssueNo(2147483648)).toThrow('ISSUE_NO_OUT_OF_RANGE');
        expect(() => validateIssueNo(Number.MAX_SAFE_INTEGER)).toThrow('ISSUE_NO_OUT_OF_RANGE');
      });

      it('should reject NaN', () => {
        expect(() => validateIssueNo(NaN)).toThrow('INVALID_ISSUE_NO');
      });

      it('should reject Infinity', () => {
        expect(() => validateIssueNo(Infinity)).toThrow('INVALID_ISSUE_NO');
        expect(() => validateIssueNo(-Infinity)).toThrow('INVALID_ISSUE_NO');
      });
    });
  });

  describe('validateBranchName', () => {
    describe('valid branch names', () => {
      it('should accept simple alphanumeric names', () => {
        expect(() => validateBranchName('main')).not.toThrow();
        expect(() => validateBranchName('develop')).not.toThrow();
        expect(() => validateBranchName('feature123')).not.toThrow();
      });

      it('should accept names with slashes', () => {
        expect(() => validateBranchName('feature/123-add-feature')).not.toThrow();
        expect(() => validateBranchName('fix/456-bug-fix')).not.toThrow();
        expect(() => validateBranchName('hotfix/critical-fix')).not.toThrow();
      });

      it('should accept names with underscores', () => {
        expect(() => validateBranchName('feature_branch')).not.toThrow();
        expect(() => validateBranchName('my_feature_123')).not.toThrow();
      });

      it('should accept names with hyphens', () => {
        expect(() => validateBranchName('feature-branch')).not.toThrow();
        expect(() => validateBranchName('my-feature-123')).not.toThrow();
      });

      it('should accept mixed valid characters', () => {
        expect(() => validateBranchName('feature/136-worktree_parallel-dev')).not.toThrow();
      });
    });

    describe('invalid branch names', () => {
      it('should reject names with spaces', () => {
        expect(() => validateBranchName('feature branch')).toThrow('INVALID_BRANCH_NAME');
      });

      it('should reject names with special characters', () => {
        expect(() => validateBranchName('feature@branch')).toThrow('INVALID_BRANCH_NAME');
        expect(() => validateBranchName('feature#branch')).toThrow('INVALID_BRANCH_NAME');
        expect(() => validateBranchName('feature$branch')).toThrow('INVALID_BRANCH_NAME');
        expect(() => validateBranchName('feature%branch')).toThrow('INVALID_BRANCH_NAME');
        expect(() => validateBranchName('feature&branch')).toThrow('INVALID_BRANCH_NAME');
        expect(() => validateBranchName('feature*branch')).toThrow('INVALID_BRANCH_NAME');
      });

      it('should reject names with backticks (command injection prevention)', () => {
        expect(() => validateBranchName('feature`rm -rf /`')).toThrow('INVALID_BRANCH_NAME');
      });

      it('should reject names with semicolons (command injection prevention)', () => {
        expect(() => validateBranchName('feature;rm -rf /')).toThrow('INVALID_BRANCH_NAME');
      });

      it('should reject names with pipes (command injection prevention)', () => {
        expect(() => validateBranchName('feature|cat /etc/passwd')).toThrow('INVALID_BRANCH_NAME');
      });

      it('should reject names exceeding 255 characters', () => {
        const longName = 'a'.repeat(256);
        expect(() => validateBranchName(longName)).toThrow('BRANCH_NAME_TOO_LONG');
      });

      it('should accept names up to 255 characters', () => {
        const maxLengthName = 'a'.repeat(255);
        expect(() => validateBranchName(maxLengthName)).not.toThrow();
      });

      it('should reject empty string', () => {
        expect(() => validateBranchName('')).toThrow('INVALID_BRANCH_NAME');
      });
    });
  });

  describe('constants', () => {
    it('MAX_ISSUE_NO should be 2^31 - 1', () => {
      expect(MAX_ISSUE_NO).toBe(2147483647);
    });

    it('BRANCH_NAME_PATTERN should match valid characters', () => {
      expect(BRANCH_NAME_PATTERN.test('abc')).toBe(true);
      expect(BRANCH_NAME_PATTERN.test('ABC')).toBe(true);
      expect(BRANCH_NAME_PATTERN.test('123')).toBe(true);
      expect(BRANCH_NAME_PATTERN.test('a-b_c/d')).toBe(true);
      expect(BRANCH_NAME_PATTERN.test('a@b')).toBe(false);
    });
  });
});
