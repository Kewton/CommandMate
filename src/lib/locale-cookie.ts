/**
 * Locale Cookie Utility [MF-002]
 *
 * Separated from useLocaleSwitch hook for SRP compliance.
 * Ensures security flags (SameSite=Lax; Secure) are always set.
 */
import { LOCALE_COOKIE_NAME } from '@/config/i18n-config';
import type { SupportedLocale } from '@/config/i18n-config';

const LOCALE_COOKIE_MAX_AGE = 31536000; // 1 year

export function setLocaleCookie(locale: SupportedLocale): void {
  const isSecure = window.location.protocol === 'https:';
  const securePart = isSecure ? ';Secure' : '';
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};SameSite=Lax${securePart}`;
}
