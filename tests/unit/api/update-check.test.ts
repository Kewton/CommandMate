/**
 * Unit tests for GET /api/app/update-check
 * Issue #257: Version update notification feature
 *
 * Tests cover:
 * - toUpdateCheckResponse() mapping function [SF-002]
 * - Status field values (success/degraded) [SF-004]
 * - Cache-Control headers [SEC-SF-003]
 * - updateCommand fixed string constraint [SEC-SF-004]
 * - Test file placement: tests/unit/api/ (no app/ subdirectory) [CONS-003]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock version-checker before importing route
vi.mock('@/lib/version-checker', () => ({
  checkForUpdate: vi.fn(),
  getCurrentVersion: vi.fn().mockReturnValue('0.2.3'),
}));

// Mock install-context [CONS-001]
vi.mock('@/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn().mockReturnValue(false),
}));

import { GET, dynamic } from '@/app/api/app/update-check/route';
import { checkForUpdate, getCurrentVersion } from '@/lib/version-checker';
import { isGlobalInstall } from '@/cli/utils/install-context';
import type { UpdateCheckResult } from '@/lib/version-checker';

// =============================================================================
// Route configuration [FIX-270]
// =============================================================================

describe('Route configuration', () => {
  it('should export dynamic as force-dynamic to prevent static prerendering', () => {
    // [FIX-270] Regression test: ensures Next.js treats this route as dynamic,
    // not statically prerendered at build time.
    expect(dynamic).toBe('force-dynamic');
  });
});

// =============================================================================
// GET handler
// =============================================================================

describe('GET /api/app/update-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentVersion as ReturnType<typeof vi.fn>).mockReturnValue('0.2.3');
    (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  describe('success response (update available)', () => {
    it('should return status: success with update info when newer version exists', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: true,
        currentVersion: '0.2.3',
        latestVersion: '0.3.0',
        releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        releaseName: 'v0.3.0',
        publishedAt: '2026-02-10T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const response = await GET();
      const data = await response.json();

      expect(data.status).toBe('success');
      expect(data.hasUpdate).toBe(true);
      expect(data.currentVersion).toBe('0.2.3');
      expect(data.latestVersion).toBe('0.3.0');
      expect(data.releaseUrl).toBe(
        'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0'
      );
      expect(data.releaseName).toBe('v0.3.0');
      expect(data.publishedAt).toBe('2026-02-10T00:00:00Z');
      expect(data.installType).toBe('global');
      // [SEC-SF-004] updateCommand must be fixed string
      expect(data.updateCommand).toBe('npm install -g commandmate@latest');
    });
  });

  describe('success response (no update)', () => {
    it('should return status: success with hasUpdate false when on latest', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: false,
        currentVersion: '0.2.3',
        latestVersion: '0.2.3',
        releaseUrl: null,
        releaseName: 'v0.2.3',
        publishedAt: '2026-02-01T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await GET();
      const data = await response.json();

      expect(data.status).toBe('success');
      expect(data.hasUpdate).toBe(false);
      expect(data.installType).toBe('local');
      expect(data.updateCommand).toBeNull();
    });
  });

  describe('degraded response (API failure) [SF-004]', () => {
    it('should return status: degraded when checkForUpdate returns null', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await GET();
      const data = await response.json();

      expect(data.status).toBe('degraded');
      expect(data.hasUpdate).toBe(false);
      expect(data.currentVersion).toBe('0.2.3');
      expect(data.latestVersion).toBeNull();
      expect(data.releaseUrl).toBeNull();
      expect(data.releaseName).toBeNull();
      expect(data.publishedAt).toBeNull();
      expect(data.updateCommand).toBeNull();
    });
  });

  describe('installType detection', () => {
    it('should return installType: global when isGlobalInstall returns true', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const response = await GET();
      const data = await response.json();

      expect(data.installType).toBe('global');
    });

    it('should return installType: local when isGlobalInstall returns false', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const response = await GET();
      const data = await response.json();

      expect(data.installType).toBe('local');
    });

    it('should return installType: unknown when isGlobalInstall throws', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('__dirname not available');
      });

      const response = await GET();
      const data = await response.json();

      expect(data.installType).toBe('unknown');
    });
  });

  describe('updateCommand [SEC-SF-004]', () => {
    it('should return fixed update command only for global install with update', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: true,
        currentVersion: '0.2.3',
        latestVersion: '0.3.0',
        releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        releaseName: 'v0.3.0',
        publishedAt: '2026-02-10T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const response = await GET();
      const data = await response.json();

      // [SEC-SF-004] Fixed string only. Never include dynamic path information.
      expect(data.updateCommand).toBe('npm install -g commandmate@latest');
    });

    it('should return null updateCommand for local install even with update', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: true,
        currentVersion: '0.2.3',
        latestVersion: '0.3.0',
        releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        releaseName: 'v0.3.0',
        publishedAt: '2026-02-10T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const response = await GET();
      const data = await response.json();

      expect(data.updateCommand).toBeNull();
    });
  });

  describe('response headers [SEC-SF-003]', () => {
    it('should include Cache-Control: no-store header', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await GET();

      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
    });

    it('should include Pragma: no-cache header', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await GET();

      expect(response.headers.get('Pragma')).toBe('no-cache');
    });
  });

  describe('HTTP 200 always returned', () => {
    it('should return HTTP 200 for success case', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: true,
        currentVersion: '0.2.3',
        latestVersion: '0.3.0',
        releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        releaseName: 'v0.3.0',
        publishedAt: '2026-02-10T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await GET();
      expect(response.status).toBe(200);
    });

    it('should return HTTP 200 even for degraded case', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await GET();
      expect(response.status).toBe(200);
    });

    it('should return HTTP 200 even when server throws', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Unexpected error')
      );

      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('degraded');
    });

    it('should return HTTP 200 with unknown installType when both checkForUpdate and isGlobalInstall throw', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Unexpected error')
      );
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('__dirname not available');
      });

      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('degraded');
      expect(data.installType).toBe('unknown');
      expect(data.hasUpdate).toBe(false);
    });
  });

  describe('response header consistency (DRY)', () => {
    it('should include same Cache-Control headers on error path', async () => {
      (checkForUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Unexpected error')
      );

      const response = await GET();

      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
      expect(response.headers.get('Pragma')).toBe('no-cache');
    });
  });

  describe('updateCommand for unknown installType', () => {
    it('should return null updateCommand for unknown install type even with update', async () => {
      const mockResult: UpdateCheckResult = {
        hasUpdate: true,
        currentVersion: '0.2.3',
        latestVersion: '0.3.0',
        releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
        releaseName: 'v0.3.0',
        publishedAt: '2026-02-10T00:00:00Z',
      };

      (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);
      (isGlobalInstall as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('detection failed');
      });

      const response = await GET();
      const data = await response.json();

      expect(data.installType).toBe('unknown');
      expect(data.updateCommand).toBeNull();
    });
  });
});
