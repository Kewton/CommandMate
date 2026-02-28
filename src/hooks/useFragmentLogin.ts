'use client';

/**
 * useFragmentLogin - Fragment-based auto-login hook
 * Issue #383: QR code login for mobile access via ngrok
 *
 * Extracts token from URL fragment (#token=xxx) and attempts auto-login.
 * The token is never sent as a query parameter (stays client-side in fragment).
 *
 * Security features:
 * - S002: history.replaceState before API call (removes token from address bar/history)
 * - processedRef for React Strict Mode duplicate execution prevention
 * - decodeURIComponent try-catch for malformed tokens
 * - 256-character token length limit
 */

import { useEffect, useRef, useState } from 'react';

export type FragmentLoginErrorKey = 'token_invalid' | 'rate_limited' | 'auto_login_failed' | null;

const MAX_TOKEN_LENGTH = 256;
const TOKEN_FRAGMENT_PATTERN = /(?:^|&)token=([^&]*)/;

function getRetryAfterSeconds(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) {
    return null;
  }

  const parsed = Number.parseInt(retryAfterHeader, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function useFragmentLogin(authEnabled: boolean): {
  autoLoginErrorKey: FragmentLoginErrorKey;
  retryAfterSeconds: number | null;
  clearError: () => void;
} {
  const [autoLoginErrorKey, setAutoLoginErrorKey] = useState<FragmentLoginErrorKey>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const processedRef = useRef(false);

  const clearError = () => {
    setAutoLoginErrorKey(null);
    setRetryAfterSeconds(null);
  };

  useEffect(() => {
    if (!authEnabled) return;
    if (processedRef.current) return;
    processedRef.current = true;

    const hash = window.location.hash;
    if (!hash) return;

    const fragment = hash.startsWith('#') ? hash.substring(1) : hash;
    const tokenMatch = fragment.match(TOKEN_FRAGMENT_PATTERN);
    if (!tokenMatch) return;

    // Remove the token-bearing hash from the address bar before further processing.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

    let token: string;
    try {
      token = decodeURIComponent(tokenMatch[1]);
    } catch {
      setAutoLoginErrorKey('token_invalid');
      return;
    }

    token = token.trim();
    if (!token) return;

    if (token.length > MAX_TOKEN_LENGTH) {
      setAutoLoginErrorKey('token_invalid');
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        if (res.ok) {
          window.location.href = '/';
        } else if (res.status === 401) {
          setAutoLoginErrorKey('token_invalid');
        } else if (res.status === 429) {
          setRetryAfterSeconds(getRetryAfterSeconds(res.headers.get('Retry-After')));
          setAutoLoginErrorKey('rate_limited');
        } else {
          setAutoLoginErrorKey('auto_login_failed');
        }
      } catch {
        setAutoLoginErrorKey('auto_login_failed');
      }
    })();
  }, [authEnabled]);

  return { autoLoginErrorKey, retryAfterSeconds, clearError };
}
