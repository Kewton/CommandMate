/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('locale-cookie', () => {
  beforeEach(() => {
    // Clear cookies
    document.cookie = 'locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('should set locale cookie with correct value', async () => {
    const { setLocaleCookie } = await import('@/lib/locale-cookie');
    setLocaleCookie('ja');
    expect(document.cookie).toContain('locale=ja');
  });

  it('should set locale cookie with SameSite=Lax', async () => {
    // We can't directly test cookie flags in jsdom, but we verify the function runs without error
    const { setLocaleCookie } = await import('@/lib/locale-cookie');
    expect(() => setLocaleCookie('en')).not.toThrow();
    expect(document.cookie).toContain('locale=en');
  });

  describe('cookie flags', () => {
    const originalLocation = window.location;
    let cookieValues: string[];

    beforeEach(() => {
      cookieValues = [];
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        set: (v: string) => { cookieValues.push(v); },
        get: () => '',
      });
    });

    afterEach(() => {
      // Restore original location
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
      vi.restoreAllMocks();
    });

    it('should not include Secure flag on HTTP', async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, protocol: 'http:' },
      });

      const mod = await import('@/lib/locale-cookie');
      mod.setLocaleCookie('en');

      expect(cookieValues.length).toBeGreaterThan(0);
      const cookieString = cookieValues[cookieValues.length - 1];
      expect(cookieString).not.toContain('Secure');
      expect(cookieString).toContain('SameSite=Lax');
    });

    it('should include Secure flag on HTTPS', async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, protocol: 'https:' },
      });

      const mod = await import('@/lib/locale-cookie');
      mod.setLocaleCookie('ja');

      expect(cookieValues.length).toBeGreaterThan(0);
      const cookieString = cookieValues[cookieValues.length - 1];
      expect(cookieString).toContain(';Secure');
    });

    it('should set max-age to 31536000 (1 year)', async () => {
      const mod = await import('@/lib/locale-cookie');
      mod.setLocaleCookie('en');

      expect(cookieValues.length).toBeGreaterThan(0);
      const cookieString = cookieValues[cookieValues.length - 1];
      expect(cookieString).toContain('max-age=31536000');
    });

    it('should set path=/', async () => {
      const mod = await import('@/lib/locale-cookie');
      mod.setLocaleCookie('en');

      expect(cookieValues.length).toBeGreaterThan(0);
      const cookieString = cookieValues[cookieValues.length - 1];
      expect(cookieString).toContain('path=/');
    });
  });
});
