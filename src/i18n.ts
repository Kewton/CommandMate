import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE_NAME, isSupportedLocale, resolveLocale } from '@/config/i18n-config';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!isSupportedLocale(locale)) {
    // Fallback order [SF-002]:
    // 1. Cookie 'locale' -> 2. Accept-Language -> 3. DEFAULT_LOCALE ('en')
    const cookieStore = await cookies();
    const headerStore = await headers();
    locale = resolveLocale(
      cookieStore.get(LOCALE_COOKIE_NAME)?.value,
      headerStore.get('accept-language')
    );
  }

  // Load all namespace files and merge them
  const [common, worktree, autoYes, error, prompt, auth, schedule, commandPalette, home, review, pwa, notifications, keyboardShortcuts, externalApps, skills] = await Promise.all([
    import(`../locales/${locale}/common.json`),
    import(`../locales/${locale}/worktree.json`),
    import(`../locales/${locale}/autoYes.json`),
    import(`../locales/${locale}/error.json`),
    import(`../locales/${locale}/prompt.json`),
    import(`../locales/${locale}/auth.json`),
    import(`../locales/${locale}/schedule.json`),
    import(`../locales/${locale}/commandPalette.json`),
    import(`../locales/${locale}/home.json`),
    import(`../locales/${locale}/review.json`),
    import(`../locales/${locale}/pwa.json`),
    import(`../locales/${locale}/notifications.json`),
    import(`../locales/${locale}/keyboardShortcuts.json`),
    import(`../locales/${locale}/externalApps.json`),
    import(`../locales/${locale}/skills.json`),
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
      commandPalette: commandPalette.default,
      home: home.default,
      review: review.default,
      pwa: pwa.default,
      notifications: notifications.default,
      keyboardShortcuts: keyboardShortcuts.default,
      externalApps: externalApps.default,
      skills: skills.default,
    },
  };
});
