/**
 * AppProviders on the unauthenticated `/login` screen (Issue #3157).
 *
 * The root layout mounts AppProviders on every page, `/login` included. Before
 * this fix the worktrees cache (`/api/worktrees` + polling), the realtime
 * WebSocket and the update check (`/api/app/update-check`) all started there
 * too, and with auth on every one of them came back 401.
 *
 * The real provider tree is rendered with `fetch` and `WebSocket` stubbed, so
 * the assertion is on what actually leaves the browser:
 *   - auth on  + `/login`        → no request, no socket
 *   - auth on  + any other path  → requests and socket as before (control)
 *   - auth off + `/login`        → requests and socket as before (control)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { installMockWebSocket, MockWebSocket } from '@tests/helpers/mock-websocket';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const nav = vi.hoisted(() => ({ pathname: '/login' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { AppProviders, shouldStartAppData } from '@/components/providers/AppProviders';

const fetchMock = vi.fn();
let restoreWebSocket: () => void;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url,
  );
}

function feedRequests(): string[] {
  return requestedUrls().filter(
    (url) => url.startsWith('/api/worktrees') || url.startsWith('/api/app/update-check'),
  );
}

function renderAt(pathname: string, authEnabled: boolean): void {
  nav.pathname = pathname;
  render(
    <AppProviders locale="en" messages={{}} authEnabled={authEnabled}>
      <div data-testid="page" />
    </AppProviders>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/worktrees')) return jsonResponse({ worktrees: [], repositories: [] });
    if (url.startsWith('/api/app/update-check')) {
      return jsonResponse({ status: 'success', hasUpdate: false, currentVersion: '0.0.0' });
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  restoreWebSocket = installMockWebSocket();
});

afterEach(() => {
  cleanup();
  restoreWebSocket();
  vi.unstubAllGlobals();
});

describe('shouldStartAppData', () => {
  it('holds the feeds only on auth-excluded screens of an auth-enabled server', () => {
    expect(shouldStartAppData(true, '/login')).toBe(false);
    expect(shouldStartAppData(true, '/offline')).toBe(false);
    expect(shouldStartAppData(true, '/')).toBe(true);
    expect(shouldStartAppData(true, '/sessions')).toBe(true);
    // Exact match, like the middleware: `/loginx` is behind the cookie check.
    expect(shouldStartAppData(true, '/loginx')).toBe(true);
    expect(shouldStartAppData(false, '/login')).toBe(true);
  });
});

describe('AppProviders data feeds (Issue #3157)', () => {
  it('sends no /api/worktrees, /api/app/update-check or WebSocket on /login with auth on', async () => {
    renderAt('/login', true);
    // Let mount effects, the deferred polling start and any microtasks run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(feedRequests()).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('starts all three on a logged-in screen with auth on (control)', async () => {
    renderAt('/', true);

    await waitFor(() => {
      expect(requestedUrls()).toContain('/api/worktrees');
      expect(requestedUrls()).toContain('/api/app/update-check');
    });
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });

  it('starts all three on /login when auth is off (control)', async () => {
    renderAt('/login', false);

    await waitFor(() => {
      expect(requestedUrls()).toContain('/api/worktrees');
      expect(requestedUrls()).toContain('/api/app/update-check');
    });
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });
});
