'use client';

/**
 * useFragmentLogin - Fragment-based auto-login hook
 * Issue #383: QR code login for mobile access via ngrok
 * Issue #1937 (R6): generalized to carry `commandmate remote` pairing codes
 *
 * Reads a credential out of the URL fragment and exchanges it for the auth
 * cookie. Two fragment forms are understood:
 *
 *   #code=<26-char pairing code>  -> POST /api/remote/pair   (Issue #1937)
 *   #token=<64-hex auth token>    -> POST /api/auth/login    (Issue #383, DEPRECATED)
 *
 * `#code=` wins when both are present. The fragment is used rather than a query
 * parameter so the credential never leaves the browser as part of a request
 * line; the receiving screen stays `/login`, so no new excluded path is needed.
 *
 * DEPRECATION (design §2.2): `#token=` puts a LONG-LIVED token in a QR code.
 * `commandmate remote` no longer issues such URLs, but acceptance is kept for
 * one release so an already-printed QR keeps working. Removal is Phase 2.
 *
 * Security features:
 * - S002: history.replaceState before API call (removes credential from address bar/history)
 * - processedRef for React Strict Mode duplicate execution prevention
 * - decodeURIComponent try-catch for malformed values
 * - 256-character length limit (matches both endpoints' server-side cap)
 */

import { useEffect, useRef, useState } from 'react';

export type FragmentLoginErrorKey =
  | 'token_invalid'
  | 'rate_limited'
  | 'auto_login_failed'
  | 'pairing_invalid'
  | 'pairing_expired'
  | null;

const MAX_CREDENTIAL_LENGTH = 256;
const CODE_FRAGMENT_PATTERN = /(?:^|&)code=([^&]*)/;
const TOKEN_FRAGMENT_PATTERN = /(?:^|&)token=([^&]*)/;

/** Which credential the fragment carried, and where it has to be redeemed. */
type CredentialKind = 'code' | 'token';

const ENDPOINTS: Record<CredentialKind, string> = {
  code: '/api/remote/pair',
  token: '/api/auth/login',
};

function getRetryAfterSeconds(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) {
    return null;
  }

  const parsed = Number.parseInt(retryAfterHeader, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Pick the credential out of a fragment. `code` is checked first so a fragment
 * carrying both redeems the modern, single-use one.
 *
 * @param fragment - Location hash with any leading '#' already stripped
 * @returns The credential kind and its still-encoded value, or null
 */
function matchCredential(fragment: string): { kind: CredentialKind; raw: string } | null {
  const codeMatch = fragment.match(CODE_FRAGMENT_PATTERN);
  if (codeMatch) {
    return { kind: 'code', raw: codeMatch[1] };
  }

  const tokenMatch = fragment.match(TOKEN_FRAGMENT_PATTERN);
  if (tokenMatch) {
    return { kind: 'token', raw: tokenMatch[1] };
  }

  return null;
}

export function useFragmentLogin(authEnabled: boolean): {
  autoLoginErrorKey: FragmentLoginErrorKey;
  retryAfterSeconds: number | null;
  pairingInProgress: boolean;
  clearError: () => void;
} {
  const [autoLoginErrorKey, setAutoLoginErrorKey] = useState<FragmentLoginErrorKey>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const [pairingInProgress, setPairingInProgress] = useState(false);
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
    const matched = matchCredential(fragment);
    if (!matched) return;

    // Remove the credential-bearing hash from the address bar before further processing.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

    // Both endpoints answer 401 for "wrong value", so a decode failure on either
    // path is surfaced as the same invalid-credential state the user would get
    // from the server.
    const invalidKey: FragmentLoginErrorKey =
      matched.kind === 'code' ? 'pairing_invalid' : 'token_invalid';

    let credential: string;
    try {
      credential = decodeURIComponent(matched.raw);
    } catch {
      setAutoLoginErrorKey(invalidKey);
      return;
    }

    credential = credential.trim();
    if (!credential) return;

    if (credential.length > MAX_CREDENTIAL_LENGTH) {
      setAutoLoginErrorKey(invalidKey);
      return;
    }

    if (matched.kind === 'token') {
      // Deprecation notice. The token itself is deliberately absent - this line
      // exists to tell an operator which flow they are on, not what they sent.
      console.warn(
        '[useFragmentLogin] The #token= login link is deprecated and will be removed in a future release (Issue #1937). Use the pairing URL that `commandmate remote` prints.'
      );
    } else {
      setPairingInProgress(true);
    }

    (async () => {
      try {
        const res = await fetch(ENDPOINTS[matched.kind], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            matched.kind === 'code' ? { code: credential } : { token: credential }
          ),
        });

        if (res.ok) {
          window.location.href = '/';
          return;
        }

        if (res.status === 401) {
          setAutoLoginErrorKey(invalidKey);
        } else if (res.status === 410) {
          // Pairing only: the code was already used, or its TTL ran out.
          setAutoLoginErrorKey('pairing_expired');
        } else if (res.status === 429) {
          setRetryAfterSeconds(getRetryAfterSeconds(res.headers.get('Retry-After')));
          setAutoLoginErrorKey('rate_limited');
        } else {
          setAutoLoginErrorKey('auto_login_failed');
        }
      } catch {
        setAutoLoginErrorKey('auto_login_failed');
      } finally {
        setPairingInProgress(false);
      }
    })();
  }, [authEnabled]);

  return { autoLoginErrorKey, retryAfterSeconds, pairingInProgress, clearError };
}
