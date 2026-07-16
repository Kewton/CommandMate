/**
 * i18n Configuration - Single Source of Truth [MF-001]
 *
 * All locale-related constants are centralized here.
 * When adding a new language, update SUPPORTED_LOCALES and LOCALE_LABELS only.
 */

export const SUPPORTED_LOCALES = ['en', 'ja'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_COOKIE_NAME = 'locale';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  ja: '日本語',
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

/**
 * Resolve a locale the way a request would: cookie -> Accept-Language -> default.
 *
 * Shared by `src/i18n.ts` (what the reader SEES) and push subscription
 * registration (what the reader is NOTIFIED in). These must agree, so both call
 * this rather than each matching locales their own way — a push body in a
 * different language than the UI is the bug this exists to prevent.
 */
export function resolveLocale(
  cookieLocale: string | undefined | null,
  acceptLanguage: string | undefined | null
): SupportedLocale {
  if (isSupportedLocale(cookieLocale)) return cookieLocale;
  const matched = SUPPORTED_LOCALES.find((l) => (acceptLanguage ?? '').includes(l));
  return matched ?? DEFAULT_LOCALE;
}
