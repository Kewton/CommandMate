/**
 * Unit tests for github-links.ts
 * Issue #264: GitHub URL constants centralization
 */

import { describe, it, expect } from 'vitest';
import {
  GITHUB_REPO_BASE_URL,
  GITHUB_ISSUES_URL,
  GITHUB_NEW_ISSUE_URL,
  GITHUB_BUG_REPORT_URL,
  GITHUB_FEATURE_REQUEST_URL,
  GITHUB_QUESTION_URL,
  GITHUB_RELEASE_URL_PREFIX,
  GITHUB_SECURITY_GUIDE_URL,
} from '../../../src/config/github-links';

describe('github-links constants', () => {
  describe('GITHUB_REPO_BASE_URL', () => {
    it('should be the correct repository URL', () => {
      expect(GITHUB_REPO_BASE_URL).toBe('https://github.com/Kewton/CommandMate');
    });
  });

  describe('derived URL constants', () => {
    it('should derive GITHUB_ISSUES_URL from base', () => {
      expect(GITHUB_ISSUES_URL).toBe(`${GITHUB_REPO_BASE_URL}/issues`);
    });

    it('should derive GITHUB_NEW_ISSUE_URL from base', () => {
      expect(GITHUB_NEW_ISSUE_URL).toBe(`${GITHUB_REPO_BASE_URL}/issues/new`);
    });

    it('should derive GITHUB_BUG_REPORT_URL with template parameter', () => {
      expect(GITHUB_BUG_REPORT_URL).toBe(`${GITHUB_NEW_ISSUE_URL}?template=bug_report.md`);
    });

    it('should derive GITHUB_FEATURE_REQUEST_URL with template parameter', () => {
      expect(GITHUB_FEATURE_REQUEST_URL).toBe(`${GITHUB_NEW_ISSUE_URL}?template=feature_request.md`);
    });

    it('should derive GITHUB_QUESTION_URL with template parameter', () => {
      expect(GITHUB_QUESTION_URL).toBe(`${GITHUB_NEW_ISSUE_URL}?template=question.md`);
    });

    it('should derive GITHUB_RELEASE_URL_PREFIX from base', () => {
      expect(GITHUB_RELEASE_URL_PREFIX).toBe(`${GITHUB_REPO_BASE_URL}/releases/`);
    });

    it('should derive GITHUB_SECURITY_GUIDE_URL from base', () => {
      expect(GITHUB_SECURITY_GUIDE_URL).toBe(`${GITHUB_REPO_BASE_URL}/blob/main/docs/security-guide.md`);
    });
  });

  describe('URL format validation', () => {
    it('all URLs should start with https://', () => {
      const urls = [
        GITHUB_REPO_BASE_URL,
        GITHUB_ISSUES_URL,
        GITHUB_NEW_ISSUE_URL,
        GITHUB_BUG_REPORT_URL,
        GITHUB_FEATURE_REQUEST_URL,
        GITHUB_QUESTION_URL,
        GITHUB_RELEASE_URL_PREFIX,
        GITHUB_SECURITY_GUIDE_URL,
      ];
      urls.forEach(url => {
        expect(url).toMatch(/^https:\/\//);
      });
    });

    it('all URLs should contain the repository name', () => {
      const urls = [
        GITHUB_ISSUES_URL,
        GITHUB_NEW_ISSUE_URL,
        GITHUB_BUG_REPORT_URL,
        GITHUB_FEATURE_REQUEST_URL,
        GITHUB_QUESTION_URL,
        GITHUB_RELEASE_URL_PREFIX,
        GITHUB_SECURITY_GUIDE_URL,
      ];
      urls.forEach(url => {
        expect(url).toContain('Kewton/CommandMate');
      });
    });
  });
});
