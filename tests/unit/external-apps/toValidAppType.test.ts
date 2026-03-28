/**
 * toValidAppType tests
 * Issue #573: Runtime validation replacing unsafe `as ExternalAppType` casts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { toValidAppType, DEFAULT_APP_TYPE, VALID_APP_TYPES } from '@/lib/external-apps/validation';

describe('toValidAppType (Issue #573)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid app types', () => {
    it.each([...VALID_APP_TYPES])('should return "%s" as-is for valid type', (appType) => {
      expect(toValidAppType(appType)).toBe(appType);
    });

    it('should not emit a warning for valid types', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      toValidAppType('nextjs');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('invalid app types', () => {
    it('should return DEFAULT_APP_TYPE for unknown type', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(toValidAppType('react')).toBe(DEFAULT_APP_TYPE);
    });

    it('should return DEFAULT_APP_TYPE for empty string', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(toValidAppType('')).toBe(DEFAULT_APP_TYPE);
    });

    it('should emit console.warn for invalid type', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      toValidAppType('vue');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('vue');
      expect(warnSpy.mock.calls[0][0]).toContain(DEFAULT_APP_TYPE);
    });
  });

  describe('DEFAULT_APP_TYPE constant', () => {
    it('should be "other"', () => {
      expect(DEFAULT_APP_TYPE).toBe('other');
    });

    it('should be a member of VALID_APP_TYPES', () => {
      expect(VALID_APP_TYPES).toContain(DEFAULT_APP_TYPE);
    });
  });
});
