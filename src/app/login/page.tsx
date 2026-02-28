'use client';

/**
 * Login Page
 * Issue #331: Token authentication login form
 * Issue #383: QR code login for mobile access via ngrok
 *
 * Features:
 * - Token input form (password type)
 * - Rate limit / lockout message display
 * - Redirect to / when auth is disabled (via AuthContext, no fetch needed)
 * - i18n support (useTranslations('auth'))
 * - Fragment-based auto-login (#token=xxx) for QR code scanned access
 * - QR code generator (PC only, hidden md:block) for mobile access
 */

import { useState, useEffect, FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useAuthEnabled } from '@/contexts/AuthContext';
import { useFragmentLogin } from '@/hooks/useFragmentLogin';

const QrCodeGenerator = dynamic(
  () => import('@/components/auth/QrCodeGenerator').then((m) => ({ default: m.QrCodeGenerator })),
  { ssr: false }
);

export default function LoginPage() {
  const t = useTranslations('auth');
  const authEnabled = useAuthEnabled();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  const { autoLoginErrorKey, retryAfterSeconds, clearError: clearAutoLoginError } = useFragmentLogin(authEnabled);

  // Map autoLoginErrorKey to localized message
  const autoLoginErrorMessages: Record<string, string> = {
    token_invalid: t('login.qr.tokenExpiredOrInvalid'),
    rate_limited: t('login.qr.rateLimited'),
    auto_login_failed: t('login.qr.autoLoginError'),
  };
  const autoLoginError = autoLoginErrorKey ? autoLoginErrorMessages[autoLoginErrorKey] ?? null : null;

  // Redirect to home if auth is not enabled
  useEffect(() => {
    if (!authEnabled) {
      window.location.href = '/';
    }
  }, [authEnabled]);

  // Set retryAfter from fragment login's retryAfterSeconds
  useEffect(() => {
    if (retryAfterSeconds !== null) {
      setRetryAfter(retryAfterSeconds);
    }
  }, [retryAfterSeconds]);

  // Countdown timer for retry
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    clearAutoLoginError();
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        window.location.href = '/';
        return;
      }

      if (res.status === 429) {
        const retryHeader = res.headers.get('Retry-After');
        const seconds = retryHeader ? parseInt(retryHeader, 10) : 900;
        setRetryAfter(seconds);
        setError(t('error.lockedOut'));
        return;
      }

      if (res.status === 401) {
        setError(t('error.invalidToken'));
        return;
      }

      setError(t('error.unknownError'));
    } catch {
      setError(t('error.unknownError'));
    } finally {
      setLoading(false);
    }
  }

  if (!authEnabled) return null;

  // Display autoLoginError with priority over manual form error
  const displayError = autoLoginError || error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center text-gray-900 dark:text-white">
          {t('login.title')}
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="token"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('login.tokenLabel')}
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('login.tokenPlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white"
              autoFocus
              autoComplete="off"
              disabled={retryAfter !== null && retryAfter > 0}
            />
          </div>

          {displayError && (
            <div className="text-red-600 dark:text-red-400 text-sm">
              {displayError}
              {retryAfter !== null && retryAfter > 0 && (
                <div className="mt-1">
                  {t('error.retryAfter', { minutes: Math.ceil(retryAfter / 60) })}
                </div>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !token || (retryAfter !== null && retryAfter > 0)}
            className="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '...' : t('login.submitButton')}
          </button>
        </form>

        {/* QR Code Generator - PC only (768px+), hidden on mobile */}
        <div className="hidden md:block">
          <QrCodeGenerator />
        </div>
      </div>
    </div>
  );
}
