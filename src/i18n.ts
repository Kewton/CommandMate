import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES } from '@/config/i18n-config';
import type { SupportedLocale } from '@/config/i18n-config';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
    // Fallback order [SF-002]:
    // 1. Cookie 'locale' -> 2. Accept-Language -> 3. DEFAULT_LOCALE ('en')
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
    if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale as SupportedLocale)) {
      locale = cookieLocale;
    } else {
      const headerStore = await headers();
      const acceptLang = headerStore.get('accept-language') ?? '';
      const matched = SUPPORTED_LOCALES.find(l => acceptLang.includes(l));
      locale = matched ?? DEFAULT_LOCALE;
    }
  }

  // Load all namespace files and merge them
  const [common, worktree, autoYes, error, prompt, auth, schedule] = await Promise.all([
    import(`../locales/${locale}/common.json`),
    import(`../locales/${locale}/worktree.json`),
    import(`../locales/${locale}/autoYes.json`),
    import(`../locales/${locale}/error.json`),
    import(`../locales/${locale}/prompt.json`),
    import(`../locales/${locale}/auth.json`),
    import(`../locales/${locale}/schedule.json`),
  ]);

  return {
    locale,
    // next-intl v4 requires timeZone to be set for SSR of client components
    timeZone: 'UTC',
    messages: {
      common: common.default,
      worktree: worktree.default,
      autoYes: autoYes.default,
      error: error.default,
      prompt: prompt.default,
      auth: auth.default,
      schedule: schedule.default,
    },
  };
});
