'use client';

/**
 * Login Page
 * Issue #331: Token authentication login form
 *
 * Features:
 * - Token input form (password type)
 * - Rate limit / lockout message display
 * - Authenticated redirect to /
 * - i18n support (useTranslations('auth'))
 */

import { useState, useEffect, FormEvent } from 'react';
import { useTranslations } from 'next-intl';

export default function LoginPage() {
  const t = useTranslations('auth');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Check if already authenticated
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        if (!data.authEnabled) {
          // Auth not enabled, redirect to home
          window.location.href = '/';
          return;
        }
        // Check if user is already authenticated by trying to access a protected route
        const checkRes = await fetch('/', { method: 'HEAD', redirect: 'manual' });
        if (checkRes.ok || checkRes.type === 'opaqueredirect') {
          // User might be authenticated already - check by looking at status
          if (checkRes.ok) {
            window.location.href = '/';
            return;
          }
        }
      } catch {
        // Ignore errors during auth check
      } finally {
        setCheckingAuth(false);
      }
    }
    checkAuth();
  }, []);

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

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

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

          {error && (
            <div className="text-red-600 dark:text-red-400 text-sm">
              {error}
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
      </div>
    </div>
  );
}
