/**
 * @vitest-environment jsdom
 *
 * Issue #1937 (R7): the #383 QR generator is gone from /login.
 *
 * `grep -c QrCodeGenerator src/app/login/page.tsx` returning 0 is NOT proof the
 * UI is gone — an import can be reintroduced under another name, and a dead
 * `dynamic()` chunk leaves no grep trace in the rendered tree either. So the
 * removal is pinned from both ends here: the rendered tree carries none of the
 * generator's affordances, and the files it lived in no longer exist.
 *
 * The second half is the more important one. Deleting i18n keys is invisible to
 * ESLint, `tsc` and CI: `t('login.qr.rateLimited')` type-checks whether or not
 * the key survives in the dictionary, and `tests/setup.ts` mocks `next-intl`
 * with a function that returns the key string itself. So this file proves the
 * three SURVIVING `login.qr.*` keys and the R6 `login.pairing.*` keys are still
 * reached by real code paths, and `login-auth-keys-1937r7.test.ts` proves the
 * dictionaries still define them.
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import { AuthProvider } from '@/contexts/AuthContext';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The 10 keys R7 deleted. Every one of them was QrCodeGenerator-only. */
const REMOVED_QR_KEYS = [
  'sectionTitle',
  'urlLabel',
  'urlPlaceholder',
  'tokenLabel',
  'tokenPlaceholder',
  'securityNotice',
  'showQrButton',
  'hideQrButton',
  'qrSecurityWarning',
  'httpsWarning',
] as const;

const originalLocation = window.location;

function setLocation(hash: string): void {
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: {
      ...originalLocation,
      hash,
      pathname: '/login',
      search: '',
      href: `http://localhost/login${hash}`,
    },
  });
}

function renderLogin(): void {
  render(
    <AuthProvider authEnabled={true}>
      <LoginPage />
    </AuthProvider>,
  );
}

describe('/login after the QR generator removal (Issue #1937 R7)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    setLocation('');
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  describe('the generator no longer renders', () => {
    it('still renders the login form itself', () => {
      // Positive control. Without it every absence assertion below would also
      // pass on a page that threw and rendered nothing at all.
      renderLogin();

      expect(screen.getByText('auth.login.title')).toBeInTheDocument();
      expect(screen.getByText('auth.login.submitButton')).toBeInTheDocument();
    });

    it.each(REMOVED_QR_KEYS)('renders nothing for login.qr.%s', (key) => {
      const { container } = render(
        <AuthProvider authEnabled={true}>
          <LoginPage />
        </AuthProvider>,
      );

      // The next-intl mock renders the key path verbatim, so a surviving
      // `t('login.qr.showQrButton')` would put that exact string in the DOM.
      expect(container.textContent).not.toContain(`auth.login.qr.${key}`);
    });

    it('has no URL field and exactly one password field', () => {
      // Structural, not string-based: the generator contributed an
      // `<input type="url">` and a SECOND `<input type="password">` (its token
      // box) next to the form's own token box.
      const { container } = render(
        <AuthProvider authEnabled={true}>
          <LoginPage />
        </AuthProvider>,
      );

      expect(container.querySelectorAll('input[type="url"]')).toHaveLength(0);
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    });
  });

  describe('the surviving keys are still reached by real code paths', () => {
    it('uses login.qr.tokenExpiredOrInvalid when #token= is rejected (401)', async () => {
      setLocation('#token=deadbeef');
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
      });

      renderLogin();

      // The deprecated receiver is deliberately still wired (design §2.2):
      // R7 removed the ISSUER, not the acceptance.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.anything());
      });
      expect(await screen.findByText('auth.login.qr.tokenExpiredOrInvalid')).toBeInTheDocument();
    });

    it('uses login.qr.rateLimited when the exchange is throttled (429)', async () => {
      setLocation('#token=deadbeef');
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'Retry-After' ? '120' : null) },
      });

      renderLogin();

      expect(await screen.findByText('auth.login.qr.rateLimited')).toBeInTheDocument();
      // Interpolated, not the bare key: `error.retryAfter` takes {minutes}.
      expect(await screen.findByText('auth.error.retryAfter')).toBeInTheDocument();
    });

    it('uses login.qr.autoLoginError when the exchange throws', async () => {
      setLocation('#token=deadbeef');
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      renderLogin();

      expect(await screen.findByText('auth.login.qr.autoLoginError')).toBeInTheDocument();
    });

    it('uses login.pairing.inProgress and login.pairing.expired for #code=', async () => {
      setLocation('#code=01JABCDEFGHJKMNPQRSTVWXYZ0');
      let resolveFetch: (value: unknown) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      renderLogin();

      expect(await screen.findByText('auth.login.pairing.inProgress')).toBeInTheDocument();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/remote/pair', expect.anything());
      });

      resolveFetch({ ok: false, status: 410, headers: { get: () => null } });

      expect(await screen.findByText('auth.login.pairing.expired')).toBeInTheDocument();
    });

    it('uses login.pairing.invalidCode when the code is rejected (401)', async () => {
      setLocation('#code=notacode');
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
      });

      renderLogin();

      expect(await screen.findByText('auth.login.pairing.invalidCode')).toBeInTheDocument();
    });
  });

  describe('the generator files are gone', () => {
    it('src/components/auth/QrCodeGenerator.tsx no longer exists', () => {
      expect(fs.existsSync(path.join(REPO_ROOT, 'src/components/auth/QrCodeGenerator.tsx'))).toBe(
        false,
      );
    });

    it('its 15-case suite was deleted with it', () => {
      // The suite pinned the removed behaviour itself - notably "embed the
      // URL-encoded token in #token=". Keeping any of it would re-pin the
      // spec this Issue removes.
      expect(
        fs.existsSync(path.join(REPO_ROOT, 'tests/unit/components/QrCodeGenerator.test.tsx')),
      ).toBe(false);
    });

    it('login/page.tsx imports neither the component nor next/dynamic for it', () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'src/app/login/page.tsx'), 'utf-8');

      expect(source).not.toContain('QrCodeGenerator');
      expect(source).not.toContain('components/auth');
      expect(source).not.toContain('hidden md:block');
      // ...but the receiver stays.
      expect(source).toContain('useFragmentLogin');
    });
  });
});
