'use client';

/**
 * Logout Button Component
 * Issue #331: Token authentication - logout button
 *
 * Shows a logout button only when authentication is enabled.
 * Issue #3510: the sidebar footer no longer mounts it — logout moved into the
 * shared settings menu, which calls {@link logout} below.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthEnabled } from '@/contexts/AuthContext';

/**
 * Ends the session and lands on /login — even when the call fails, so a dead
 * server cannot leave the user stuck on a page they can no longer use.
 * Shared with the settings menu (Issue #3510).
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  } catch {
    window.location.href = '/login';
  }
}

/**
 * LogoutButton - displays a logout button when auth is enabled
 * Calls /api/auth/logout and redirects to /login
 */
export function LogoutButton() {
  const t = useTranslations('auth');
  const authEnabled = useAuthEnabled();
  const [loading, setLoading] = useState(false);

  if (!authEnabled) {
    return null;
  }

  async function handleLogout() {
    setLoading(true);
    await logout();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      data-testid="logout-button"
      className="
        w-full px-3 py-2 text-sm text-left rounded-md
        text-muted-foreground hover:text-foreground hover:bg-muted
        focus:outline-none focus:ring-2 focus:ring-ring
        disabled:opacity-50 transition-colors
      "
    >
      {loading ? '...' : t('logout.button')}
    </button>
  );
}
