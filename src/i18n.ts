import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/config/i18n-config';
import type { SupportedLocale } from '@/config/i18n-config';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
    locale = DEFAULT_LOCALE;
  }

  // Load all namespace files and merge them
  const [common, worktree, autoYes, error, prompt] = await Promise.all([
    import(`../locales/${locale}/common.json`),
    import(`../locales/${locale}/worktree.json`),
    import(`../locales/${locale}/autoYes.json`),
    import(`../locales/${locale}/error.json`),
    import(`../locales/${locale}/prompt.json`),
  ]);

  return {
    locale,
    messages: {
      common: common.default,
      worktree: worktree.default,
      autoYes: autoYes.default,
      error: error.default,
      prompt: prompt.default,
    },
  };
});
