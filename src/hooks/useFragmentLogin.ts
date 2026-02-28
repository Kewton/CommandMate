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

export function useFragmentLogin(authEnabled: boolean): {
  autoLoginErrorKey: FragmentLoginErrorKey;
  retryAfterSeconds: number | null;
} {
  const [autoLoginErrorKey, setAutoLoginErrorKey] = useState<FragmentLoginErrorKey>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const processedRef = useRef(false);

  useEffect(() => {
    if (!authEnabled) return;
    if (processedRef.current) return;
    processedRef.current = true;

    const hash = window.location.hash;
    if (!hash) return;

    const params = new URLSearchParams(hash.substring(1));
    const rawToken = params.get('token');
    if (rawToken === null) return;

    let token: string;
    try {
      token = decodeURIComponent(rawToken);
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

    // S002: Remove token from address bar and browser history before API call
    history.replaceState(null, '', window.location.pathname);

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
          const retryAfter = res.headers.get('Retry-After');
          setRetryAfterSeconds(retryAfter ? parseInt(retryAfter, 10) : null);
          setAutoLoginErrorKey('rate_limited');
        } else {
          setAutoLoginErrorKey('auto_login_failed');
        }
      } catch {
        setAutoLoginErrorKey('auto_login_failed');
      }
    })();
  }, [authEnabled]);

  return { autoLoginErrorKey, retryAfterSeconds };
}
