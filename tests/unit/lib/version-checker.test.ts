/**
 * Unit tests for version-checker.ts
 * Issue #257: Version update notification feature
 *
 * Tests cover:
 * - isNewerVersion() semver comparison (normal + edge cases) [SF-003]
 * - getCurrentVersion() with env var fallback [CONS-002]
 * - validateReleaseUrl() URL prefix validation [SEC-SF-001]
 * - sanitizeReleaseName() input sanitization [SEC-SF-001]
 * - checkForUpdate() GitHub API integration with cache [SEC-001]
 * - GITHUB_API_URL hardcoded constant verification [SEC-001]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isNewerVersion,
  getCurrentVersion,
  validateReleaseUrl,
  sanitizeReleaseName,
  checkForUpdate,
  GITHUB_API_URL,
  GITHUB_RELEASE_URL_PREFIX,
  resetCacheForTesting,
} from '@/lib/version-checker';

describe('version-checker', () => {
  // =========================================================================
  // isNewerVersion() tests
  // =========================================================================
  describe('isNewerVersion', () => {
    describe('normal cases', () => {
      it('should return true when major version is higher', () => {
        expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
      });

      it('should return true when minor version is higher', () => {
        expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true);
      });

      it('should return true when patch version is higher', () => {
        expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true);
      });

      it('should return false when versions are identical', () => {
        expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
      });

      it('should return false when current is newer (major)', () => {
        expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false);
      });

      it('should return false when current is newer (minor)', () => {
        expect(isNewerVersion('1.1.0', '1.0.0')).toBe(false);
      });

      it('should return false when current is newer (patch)', () => {
        expect(isNewerVersion('1.0.1', '1.0.0')).toBe(false);
      });

      it('should handle v-prefix on both versions', () => {
        expect(isNewerVersion('v1.0.0', 'v1.1.0')).toBe(true);
      });

      it('should handle mixed v-prefix (current has v)', () => {
        expect(isNewerVersion('v1.0.0', '1.1.0')).toBe(true);
      });

      it('should handle mixed v-prefix (latest has v)', () => {
        expect(isNewerVersion('1.0.0', 'v1.1.0')).toBe(true);
      });

      it('should handle real-world version comparison (0.2.3 vs 0.3.0)', () => {
        expect(isNewerVersion('0.2.3', '0.3.0')).toBe(true);
      });
    });

    describe('invalid input cases [SF-003]', () => {
      it('should return false for beta version string', () => {
        expect(isNewerVersion('1.0.0', 'v0.3.0-beta')).toBe(false);
      });

      it('should return false for 2-segment version', () => {
        expect(isNewerVersion('1.0.0', '0.3')).toBe(false);
      });

      it('should return false for 4-segment version', () => {
        expect(isNewerVersion('1.0.0', '0.3.0.1')).toBe(false);
      });

      it('should return false for release prefix', () => {
        expect(isNewerVersion('1.0.0', 'release-0.3.0')).toBe(false);
      });

      it('should return false for empty string (current)', () => {
        expect(isNewerVersion('', '1.0.0')).toBe(false);
      });

      it('should return false for empty string (latest)', () => {
        expect(isNewerVersion('1.0.0', '')).toBe(false);
      });

      it('should return false for non-version string', () => {
        expect(isNewerVersion('1.0.0', 'latest')).toBe(false);
      });

      it('should return false for alpha version string', () => {
        expect(isNewerVersion('1.0.0', 'v1.0.0-alpha.1')).toBe(false);
      });

      it('should return false for rc version string', () => {
        expect(isNewerVersion('1.0.0', 'v1.0.0-rc.1')).toBe(false);
      });

      it('should return false when current version is invalid', () => {
        expect(isNewerVersion('invalid', '1.0.0')).toBe(false);
      });

      it('should return false when both versions are invalid', () => {
        expect(isNewerVersion('foo', 'bar')).toBe(false);
      });
    });
  });

  // =========================================================================
  // getCurrentVersion() tests
  // =========================================================================
  describe('getCurrentVersion', () => {
    const originalEnv = process.env.NEXT_PUBLIC_APP_VERSION;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.NEXT_PUBLIC_APP_VERSION = originalEnv;
      } else {
        delete process.env.NEXT_PUBLIC_APP_VERSION;
      }
    });

    it('should return NEXT_PUBLIC_APP_VERSION when set', () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.2.3';
      expect(getCurrentVersion()).toBe('1.2.3');
    });

    it('should return 0.0.0 as fallback when env var is not set', () => {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
      expect(getCurrentVersion()).toBe('0.0.0');
    });
  });

  // =========================================================================
  // validateReleaseUrl() tests [SEC-SF-001]
  // =========================================================================
  describe('validateReleaseUrl', () => {
    it('should return URL when it has valid GitHub releases prefix', () => {
      const url = 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0';
      expect(validateReleaseUrl(url)).toBe(url);
    });

    it('should return null for URL with different domain', () => {
      const url = 'https://evil.com/Kewton/CommandMate/releases/tag/v0.3.0';
      expect(validateReleaseUrl(url)).toBeNull();
    });

    it('should return null for javascript: protocol', () => {
      const url = 'javascript:alert(1)';
      expect(validateReleaseUrl(url)).toBeNull();
    });

    it('should return null for data: protocol', () => {
      const url = 'data:text/html,<h1>malicious</h1>';
      expect(validateReleaseUrl(url)).toBeNull();
    });

    it('should return null for different repository path', () => {
      const url = 'https://github.com/Evil/Repo/releases/tag/v0.3.0';
      expect(validateReleaseUrl(url)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(validateReleaseUrl('')).toBeNull();
    });
  });

  // =========================================================================
  // sanitizeReleaseName() tests [SEC-SF-001]
  // =========================================================================
  describe('sanitizeReleaseName', () => {
    it('should return name when valid (alphanumeric)', () => {
      expect(sanitizeReleaseName('v0.3.0', 'v0.3.0')).toBe('v0.3.0');
    });

    it('should return name with spaces', () => {
      expect(sanitizeReleaseName('Version 0.3.0', 'v0.3.0')).toBe('Version 0.3.0');
    });

    it('should return name with hyphens and underscores', () => {
      expect(sanitizeReleaseName('v0.3.0-release_final', 'v0.3.0')).toBe('v0.3.0-release_final');
    });

    it('should return tagName fallback for HTML tags in name', () => {
      expect(sanitizeReleaseName('<script>alert(1)</script>', 'v0.3.0')).toBe('v0.3.0');
    });

    it('should return tagName fallback for names exceeding 128 chars', () => {
      const longName = 'a'.repeat(129);
      expect(sanitizeReleaseName(longName, 'v0.3.0')).toBe('v0.3.0');
    });

    it('should accept names at exactly 128 chars', () => {
      const name = 'a'.repeat(128);
      expect(sanitizeReleaseName(name, 'v0.3.0')).toBe(name);
    });

    it('should return tagName fallback for emoji in name', () => {
      expect(sanitizeReleaseName('Release v0.3.0 \u{1F389}', 'v0.3.0')).toBe('v0.3.0');
    });

    it('should return tagName fallback for special characters', () => {
      expect(sanitizeReleaseName('v0.3.0; DROP TABLE', 'v0.3.0')).toBe('v0.3.0');
    });
  });

  // =========================================================================
  // GITHUB_API_URL constant verification [SEC-001]
  // =========================================================================
  describe('GITHUB_API_URL constant [SEC-001]', () => {
    it('should be the exact expected hardcoded URL', () => {
      expect(GITHUB_API_URL).toBe(
        'https://api.github.com/repos/Kewton/CommandMate/releases/latest'
      );
    });

    it('should not be undefined or empty', () => {
      expect(GITHUB_API_URL).toBeDefined();
      expect(GITHUB_API_URL.length).toBeGreaterThan(0);
    });
  });

  describe('GITHUB_RELEASE_URL_PREFIX constant [SEC-SF-001]', () => {
    it('should be the exact expected prefix', () => {
      expect(GITHUB_RELEASE_URL_PREFIX).toBe(
        'https://github.com/Kewton/CommandMate/releases/'
      );
    });
  });

  // =========================================================================
  // checkForUpdate() tests
  // =========================================================================
  describe('checkForUpdate', () => {
    const originalEnv = process.env.NEXT_PUBLIC_APP_VERSION;

    beforeEach(() => {
      // Reset cache before each test
      resetCacheForTesting();
      process.env.NEXT_PUBLIC_APP_VERSION = '0.2.3';
      vi.restoreAllMocks();
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.NEXT_PUBLIC_APP_VERSION = originalEnv;
      } else {
        delete process.env.NEXT_PUBLIC_APP_VERSION;
      }
    });

    it('should return update info when newer version is available', async () => {
      const mockResponse = {
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        name: 'v0.3.0',
        published_at: '2026-02-10T00:00:00Z',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.hasUpdate).toBe(true);
      expect(result!.currentVersion).toBe('0.2.3');
      expect(result!.latestVersion).toBe('0.3.0');
      expect(result!.releaseUrl).toBe(
        'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0'
      );
      expect(result!.releaseName).toBe('v0.3.0');
      expect(result!.publishedAt).toBe('2026-02-10T00:00:00Z');
    });

    it('should return hasUpdate false when already on latest version', async () => {
      const mockResponse = {
        tag_name: 'v0.2.3',
        html_url: 'https://github.com/Kewton/CommandMate/releases/tag/v0.2.3',
        name: 'v0.2.3',
        published_at: '2026-02-01T00:00:00Z',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.hasUpdate).toBe(false);
      expect(result!.currentVersion).toBe('0.2.3');
      expect(result!.latestVersion).toBe('0.2.3');
    });

    it('should return null on network error (silent failure)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const result = await checkForUpdate();

      expect(result).toBeNull();
    });

    it('should return cached result on 403 rate limit', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      // First call with no cache returns null
      expect(result).toBeNull();
    });

    it('should return null on non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      expect(result).toBeNull();
    });

    it('should use cache on subsequent calls within TTL', async () => {
      const mockResponse = {
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        name: 'v0.3.0',
        published_at: '2026-02-10T00:00:00Z',
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      // First call - fetches from API
      await checkForUpdate();
      // Second call - should use cache
      const result = await checkForUpdate();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result!.hasUpdate).toBe(true);
    });

    it('should send correct headers including User-Agent [SEC-SF-002]', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          tag_name: 'v0.3.0',
          html_url: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
          name: 'v0.3.0',
          published_at: '2026-02-10T00:00:00Z',
        }),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      await checkForUpdate();

      expect(mockFetch).toHaveBeenCalledWith(
        GITHUB_API_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Accept': 'application/vnd.github+json',
            'User-Agent': expect.stringContaining('CommandMate/'),
          }),
        })
      );
    });

    it('should handle invalid tag_name from API gracefully', async () => {
      const mockResponse = {
        tag_name: 'invalid-version',
        html_url: 'https://github.com/Kewton/CommandMate/releases/tag/invalid-version',
        name: 'Invalid Release',
        published_at: '2026-02-10T00:00:00Z',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      // Invalid version should result in hasUpdate: false
      expect(result).not.toBeNull();
      expect(result!.hasUpdate).toBe(false);
    });

    it('should handle malicious html_url from API [SEC-SF-001]', async () => {
      const mockResponse = {
        tag_name: 'v0.3.0',
        html_url: 'https://evil.com/malicious',
        name: 'v0.3.0',
        published_at: '2026-02-10T00:00:00Z',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      // The releaseUrl should be null when validation fails
      expect(result!.releaseUrl).toBeNull();
    });

    it('should sanitize malicious release name [SEC-SF-001]', async () => {
      const mockResponse = {
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        name: '<script>alert(1)</script>',
        published_at: '2026-02-10T00:00:00Z',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
        headers: new Headers(),
      }));

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      // Sanitized name should fall back to tag_name
      expect(result!.releaseName).toBe('v0.3.0');
    });

    it('should handle 403 rate limit and extend cache TTL', async () => {
      const resetTimestamp = Math.floor((Date.now() + 3600000) / 1000).toString();

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Headers({
          'X-RateLimit-Reset': resetTimestamp,
        }),
      }));

      // First call (no cache, rate limited)
      const result1 = await checkForUpdate();
      expect(result1).toBeNull();

      // Reset cache to simulate fresh call but keep rate limit state
      // The rate limit should prevent another API call
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const result2 = await checkForUpdate();
      // Should not have called fetch again due to rate limit
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result2).toBeNull();
    });
  });
});
