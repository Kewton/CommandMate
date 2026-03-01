/**
 * Unit tests for useFragmentLogin hook
 * Issue #383: QR code login for mobile access via ngrok
 *
 * Tests fragment-based auto-login flow with security validations
 * @vitest-environment jsdom
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFragmentLogin } from '@/hooks/useFragmentLogin';

// Store original window.location and history
const originalLocation = window.location;

function setLocation({
  hash,
  pathname = '/login',
  search = '',
}: {
  hash: string;
  pathname?: string;
  search?: string;
}) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: {
      ...originalLocation,
      hash,
      pathname,
      search,
      href: `http://localhost${pathname}${search}${hash}`,
    },
  });
}

function resetLocation() {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
}

describe('useFragmentLogin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    replaceStateSpy = vi.spyOn(history, 'replaceState');

    // Default: no hash
    setLocation({ hash: '' });
  });

  afterEach(() => {
    resetLocation();
    vi.restoreAllMocks();
  });

  it('should return null error when no fragment is present', () => {
    setLocation({ hash: '' });

    const { result } = renderHook(() => useFragmentLogin(true));

    expect(result.current.autoLoginErrorKey).toBeNull();
    expect(result.current.retryAfterSeconds).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip processing when authEnabled is false', () => {
    setLocation({ hash: '#token=mytoken' });

    const { result } = renderHook(() => useFragmentLogin(false));

    expect(result.current.autoLoginErrorKey).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('should redirect to / on successful login (200)', async () => {
    setLocation({ hash: '#token=validtoken' });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    // Track window.location.href assignments via a spy
    const hrefSetter = vi.fn();
    const locationObj = {
      ...originalLocation,
      hash: '#token=validtoken',
      pathname: '/login',
    };
    Object.defineProperty(locationObj, 'href', {
      get: () => 'http://localhost/login#token=validtoken',
      set: (val: string) => {
        hrefSetter(val);
      },
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      writable: true,
      value: locationObj,
    });

    renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('/');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'validtoken' }),
    });
  });

  it('should skip when token param is missing from fragment', () => {
    setLocation({ hash: '#foo=bar' });

    const { result } = renderHook(() => useFragmentLogin(true));

    expect(result.current.autoLoginErrorKey).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip when token is empty after trim', () => {
    setLocation({ hash: '#token=%20%20' });

    const { result } = renderHook(() => useFragmentLogin(true));

    expect(result.current.autoLoginErrorKey).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return token_invalid when token exceeds 256 characters', async () => {
    const longToken = 'a'.repeat(257);
    setLocation({ hash: `#token=${longToken}` });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('token_invalid');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return token_invalid on 401 response', async () => {
    setLocation({ hash: '#token=badtoken' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('token_invalid');
    });
  });

  it('should return rate_limited on 429 response with Retry-After header', async () => {
    setLocation({ hash: '#token=sometoken' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '60' }),
    });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('rate_limited');
    });
    expect(result.current.retryAfterSeconds).toBe(60);
  });

  it('should return rate_limited on 429 response without Retry-After header', async () => {
    setLocation({ hash: '#token=sometoken' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('rate_limited');
    });
    expect(result.current.retryAfterSeconds).toBeNull();
  });

  it('should return auto_login_failed on network error', async () => {
    setLocation({ hash: '#token=sometoken' });

    fetchMock.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('auto_login_failed');
    });
  });

  it('should return auto_login_failed on unexpected status code', async () => {
    setLocation({ hash: '#token=sometoken' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('auto_login_failed');
    });
  });

  it('should call history.replaceState before API request (S002)', async () => {
    setLocation({ hash: '#token=securetoken' });

    let fetchCalledAfterReplaceState = false;

    replaceStateSpy.mockImplementation(() => {
      // At the time replaceState is called, fetch should NOT have been called yet
      if (fetchMock.mock.calls.length === 0) {
        fetchCalledAfterReplaceState = true;
      }
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
    });

    renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login');
    });

    expect(fetchCalledAfterReplaceState).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('should return token_invalid on decodeURIComponent failure', async () => {
    setLocation({ hash: '#token=%E0%A4%A' });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('token_invalid');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should clear error and retryAfterSeconds when clearError is called', async () => {
    setLocation({ hash: '#token=badtoken' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '60' }),
    });

    const { result } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('rate_limited');
    });
    expect(result.current.retryAfterSeconds).toBe(60);

    act(() => {
      result.current.clearError();
    });

    expect(result.current.autoLoginErrorKey).toBeNull();
    expect(result.current.retryAfterSeconds).toBeNull();
  });

  it('should not process twice due to processedRef (React Strict Mode)', async () => {
    setLocation({ hash: '#token=validtoken' });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
    });

    const { result, rerender } = renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(result.current.autoLoginErrorKey).toBe('token_invalid');
    });

    // Rerender should not trigger another fetch
    rerender();

    // Wait a tick
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // fetch should only have been called once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should preserve search params when clearing the token fragment', async () => {
    setLocation({ hash: '#token=securetoken', pathname: '/login', search: '?lang=ja' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
    });

    renderHook(() => useFragmentLogin(true));

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login?lang=ja');
    });
  });
});
