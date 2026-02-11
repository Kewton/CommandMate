import { describe, it, expect } from 'vitest';

describe('i18n-config', () => {
  it('should export SUPPORTED_LOCALES with en and ja', async () => {
    const { SUPPORTED_LOCALES } = await import('@/config/i18n-config');
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ja']);
  });

  it('should export DEFAULT_LOCALE as en', async () => {
    const { DEFAULT_LOCALE } = await import('@/config/i18n-config');
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('should export LOCALE_LABELS for all supported locales', async () => {
    const { LOCALE_LABELS, SUPPORTED_LOCALES } = await import('@/config/i18n-config');
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[locale]).toBeDefined();
      expect(typeof LOCALE_LABELS[locale]).toBe('string');
    }
    expect(LOCALE_LABELS['en']).toBe('English');
    expect(LOCALE_LABELS['ja']).toBe('日本語');
  });

  it('should have SupportedLocale type matching SUPPORTED_LOCALES', async () => {
    const { SUPPORTED_LOCALES } = await import('@/config/i18n-config');
    // Type check: SUPPORTED_LOCALES should be a readonly tuple
    expect(Array.isArray(SUPPORTED_LOCALES)).toBe(true);
    expect(SUPPORTED_LOCALES.length).toBe(2);
  });
});
