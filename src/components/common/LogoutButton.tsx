'use client';

/**
 * Logout Button Component
 * Issue #331: Token authentication - logout button
 *
 * Shows a logout button only when authentication is enabled.
 * Used in both desktop sidebar and mobile header.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';

/**
 * LogoutButton - displays a logout button when auth is enabled
 * Calls /api/auth/logout and redirects to /login
 */
export function LogoutButton() {
  const t = useTranslations('auth');
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check if auth is enabled on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        setAuthEnabled(data.authEnabled);
      } catch {
        // Ignore errors - assume auth is not enabled
      }
    }
    checkAuth();
  }, []);

  if (!authEnabled) {
    return null;
  }

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      // Force redirect even on error
      window.location.href = '/login';
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      data-testid="logout-button"
      className="
        w-full px-3 py-2 text-sm text-left rounded-md
        text-gray-300 hover:text-white hover:bg-gray-700
        focus:outline-none focus:ring-2 focus:ring-blue-500
        disabled:opacity-50 transition-colors
      "
    >
      {loading ? '...' : t('logout.button')}
    </button>
  );
}
