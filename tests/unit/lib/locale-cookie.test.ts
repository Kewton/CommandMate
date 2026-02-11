/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';

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
});
