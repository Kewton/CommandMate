import { describe, it, expect } from 'vitest';

describe('date-locale', () => {
  it('should return Japanese locale for ja', async () => {
    const { getDateFnsLocale } = await import('@/lib/date-locale');
    const locale = getDateFnsLocale('ja');
    expect(locale).toBeDefined();
    expect(locale.code).toBe('ja');
  });

  it('should return English US locale for en', async () => {
    const { getDateFnsLocale } = await import('@/lib/date-locale');
    const locale = getDateFnsLocale('en');
    expect(locale).toBeDefined();
    expect(locale.code).toBe('en-US');
  });

  it('should fall back to English for unsupported locale', async () => {
    const { getDateFnsLocale } = await import('@/lib/date-locale');
    const locale = getDateFnsLocale('fr');
    expect(locale).toBeDefined();
    expect(locale.code).toBe('en-US');
  });
});
