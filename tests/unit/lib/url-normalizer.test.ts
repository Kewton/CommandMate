/**
 * URL Normalizer unit tests
 * Issue #71: Clone URL registration feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect } from 'vitest';
import { UrlNormalizer } from '@/lib/url-normalizer';

describe('UrlNormalizer', () => {
  const normalizer = UrlNormalizer.getInstance();

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = UrlNormalizer.getInstance();
      const instance2 = UrlNormalizer.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('normalize', () => {
    describe('HTTPS URLs', () => {
      it('should remove .git suffix', () => {
        const result = normalizer.normalize('https://github.com/user/repo.git');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should convert to lowercase', () => {
        const result = normalizer.normalize('https://GitHub.COM/User/Repo');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should remove trailing slash', () => {
        const result = normalizer.normalize('https://github.com/user/repo/');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle URL with .git suffix and trailing slash', () => {
        const result = normalizer.normalize('https://github.com/user/repo.git/');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should normalize URL with subgroups', () => {
        const result = normalizer.normalize('https://gitlab.com/group/subgroup/repo.git');
        expect(result).toBe('https://gitlab.com/group/subgroup/repo');
      });
    });

    describe('Standard SSH URLs (git@host:path)', () => {
      it('should convert SSH to HTTPS format', () => {
        const result = normalizer.normalize('git@github.com:user/repo.git');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle SSH URL without .git suffix', () => {
        const result = normalizer.normalize('git@github.com:user/repo');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should convert host to lowercase', () => {
        const result = normalizer.normalize('git@GitHub.COM:User/Repo');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle SSH URL with subgroups (GitLab style)', () => {
        const result = normalizer.normalize('git@gitlab.com:group/subgroup/repo.git');
        expect(result).toBe('https://gitlab.com/group/subgroup/repo');
      });
    });

    describe('SSH URL format (ssh://git@host)', () => {
      it('should convert ssh:// URL to HTTPS format', () => {
        const result = normalizer.normalize('ssh://git@github.com/user/repo.git');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle ssh:// URL with port', () => {
        const result = normalizer.normalize('ssh://git@github.com:22/user/repo.git');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle ssh:// URL without .git suffix', () => {
        const result = normalizer.normalize('ssh://git@github.com/user/repo');
        expect(result).toBe('https://github.com/user/repo');
      });

      it('should handle ssh:// URL with non-standard port', () => {
        const result = normalizer.normalize('ssh://git@gitlab.example.com:2222/org/repo.git');
        expect(result).toBe('https://gitlab.example.com/org/repo');
      });
    });
  });

  describe('isSameRepository', () => {
    it('should return true for same HTTPS URL', () => {
      expect(normalizer.isSameRepository(
        'https://github.com/user/repo.git',
        'https://github.com/user/repo'
      )).toBe(true);
    });

    it('should return true for HTTPS and SSH pointing to same repo', () => {
      expect(normalizer.isSameRepository(
        'https://github.com/user/repo.git',
        'git@github.com:user/repo.git'
      )).toBe(true);
    });

    it('should return true for case-insensitive comparison', () => {
      expect(normalizer.isSameRepository(
        'https://GitHub.COM/User/Repo',
        'https://github.com/user/repo'
      )).toBe(true);
    });

    it('should return false for different repositories', () => {
      expect(normalizer.isSameRepository(
        'https://github.com/user/repo1',
        'https://github.com/user/repo2'
      )).toBe(false);
    });

    it('should return false for different hosts', () => {
      expect(normalizer.isSameRepository(
        'https://github.com/user/repo',
        'https://gitlab.com/user/repo'
      )).toBe(false);
    });
  });

  describe('extractRepoName', () => {
    it('should extract repo name from HTTPS URL', () => {
      expect(normalizer.extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
    });

    it('should extract repo name from SSH URL', () => {
      expect(normalizer.extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });

    it('should extract repo name from URL without .git suffix', () => {
      expect(normalizer.extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
    });

    it('should extract repo name from URL with subgroups', () => {
      expect(normalizer.extractRepoName('https://gitlab.com/group/subgroup/my-repo.git')).toBe('my-repo');
    });

    it('should extract repo name from ssh:// URL', () => {
      expect(normalizer.extractRepoName('ssh://git@github.com/user/my-repo.git')).toBe('my-repo');
    });

    it('should return empty string for invalid URL', () => {
      expect(normalizer.extractRepoName('invalid-url')).toBe('');
    });

    it('should handle URL without path (returns host as fallback)', () => {
      // Current behavior: returns the last segment of the URL path
      // For "https://github.com", the last segment is "github.com"
      expect(normalizer.extractRepoName('https://github.com')).toBe('github.com');
    });
  });

  describe('getUrlType', () => {
    it('should return https for HTTPS URLs', () => {
      expect(normalizer.getUrlType('https://github.com/user/repo')).toBe('https');
    });

    it('should return ssh for git@ URLs', () => {
      expect(normalizer.getUrlType('git@github.com:user/repo')).toBe('ssh');
    });

    it('should return ssh for ssh:// URLs', () => {
      expect(normalizer.getUrlType('ssh://git@github.com/user/repo')).toBe('ssh');
    });

    it('should return null for unknown URL formats', () => {
      expect(normalizer.getUrlType('http://github.com/user/repo')).toBeNull();
      expect(normalizer.getUrlType('ftp://github.com/user/repo')).toBeNull();
      expect(normalizer.getUrlType('invalid-url')).toBeNull();
    });
  });

  describe('validate', () => {
    it('should return valid for HTTPS URL', () => {
      const result = normalizer.validate('https://github.com/user/repo');
      expect(result.valid).toBe(true);
    });

    it('should return valid for SSH URL', () => {
      const result = normalizer.validate('git@github.com:user/repo');
      expect(result.valid).toBe(true);
    });

    it('should return valid for ssh:// URL', () => {
      const result = normalizer.validate('ssh://git@github.com/user/repo');
      expect(result.valid).toBe(true);
    });

    it('should return invalid for HTTP URL (not HTTPS)', () => {
      const result = normalizer.validate('http://github.com/user/repo');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('INVALID_URL_FORMAT');
    });

    it('should return invalid for malformed URL', () => {
      const result = normalizer.validate('not-a-valid-url');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for empty string', () => {
      const result = normalizer.validate('');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for URL without path', () => {
      const result = normalizer.validate('https://github.com');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('INVALID_URL_FORMAT');
    });

    it('should return invalid for URL with only owner (no repo)', () => {
      const result = normalizer.validate('https://github.com/user');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('INVALID_URL_FORMAT');
    });
  });
});
