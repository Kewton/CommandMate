import createMiddleware from 'next-intl/middleware';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@/config/i18n-config';

export default createMiddleware({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localeDetection: true,
  localePrefix: 'never', // Cookie/Header-based, no URL prefix
});

// Fallback order [SF-002]:
// 1. Cookie 'locale' -> 2. Accept-Language -> 3. DEFAULT_LOCALE ('en')
// This order depends on next-intl createMiddleware internals.
// Verify with integration tests on library updates.

export const config = {
  // Exclude API, WebSocket, static files, proxy routes
  matcher: ['/((?!api|_next|proxy|.*\\..*).*)'],
};
