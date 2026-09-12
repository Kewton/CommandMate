/**
 * Offscreen tiles are silent — Issue #2509's load-bearing acceptance criterion.
 *
 * The `/sessions` tile grid mounts one live chat surface per session, and each
 * one owns two pollers: `useTerminalPanePolling` (`/current-output`, as often as
 * every 2s) and `useSplitMessages` (`/messages`). A screen showing four tiles out
 * of twenty must not be paying for twenty. This suite pins that at the seam the
 * Issue names — the HTTP calls — rather than at the `enabled` prop, because a
 * prop can be threaded correctly into a hook that fetches anyway.
 *
 * The REAL hooks run here on purpose; only `ChatSurface` is stubbed (it is the
 * rendering half, and mounting the virtualized transcript per tile would make
 * this suite about `ChatTranscript`). jsdom has no IntersectionObserver, so one
 * is installed that hands its callback back to the test — no intersection is
 * ever reported unless a test reports it, which is exactly the offscreen state.
 *
 * Issue #2512 added a third per-tile request — the composer's slash-command
 * catalog, fetched once when `MessageInput` mounts — and one request that is not
 * a tile's at all: the grid's single connectivity probe (`/api/capabilities`,
 * issued only while the connection verdict is degraded). The composer is gated
 * on `enabled` like the pollers, so it falls under the same assertions; the
 * probe is left out of {@link fetchedUrls}, because counting it would make these
 * tests about a timer rather than about offscreen tiles.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

// The tile's body. Stubbed to keep this suite about the network, not about the
// transcript — see the file comment.
vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({ worktreeId }: { worktreeId: string }) =>
    React.createElement('div', { 'data-testid': `chat-surface-${worktreeId}` }),
}));

import { SessionTileGrid } from '@/components/sessions/SessionTileGrid';
import type { Worktree } from '@/types/models';

/**
 * `waitFor`'s 1s default is a wall-clock budget, and this suite runs inside a
 * 1585-file parallel run — a poll that is fetched promptly can still be observed
 * late. The assertions are about WHETHER a request was made, never about how
 * fast, so the budget is widened rather than left to the machine's load.
 */
const WAIT_TIMEOUT_MS = 10_000;

// --- IntersectionObserver stub that captures one callback per observed node ---
type IOCallback = (entries: IntersectionObserverEntry[]) => void;

/** Every live observer, in construction order (= tile order in the grid). */
let observers: Array<{ callback: IOCallback; nodes: Element[] }> = [];

class MockIntersectionObserver {
  private entry: { callback: IOCallback; nodes: Element[] };
  constructor(callback: IOCallback) {
    this.entry = { callback, nodes: [] };
    observers.push(this.entry);
  }
  observe = (node: Element) => {
    this.entry.nodes.push(node);
  };
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = '';
  thresholds = [];
}

/** Report `isIntersecting` for the n-th mounted tile. */
function reportIntersection(index: number, isIntersecting: boolean): void {
  const observer = observers[index];
  expect(observer, `no observer at index ${index}`).toBeDefined();
  act(() => {
    observer.callback(
      observer.nodes.map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: 0,
      })) as IntersectionObserverEntry[],
    );
  });
}

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  } as Worktree;
}

/** Every worktree-scoped URL `fetch` was called with this test — i.e. every tile request. */
function fetchedUrls(): string[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith('/api/worktrees/'));
}

let originalIntersectionObserver: unknown;

beforeEach(() => {
  observers = [];
  originalIntersectionObserver = (window as unknown as Record<string, unknown>).IntersectionObserver;
  (window as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  // Each endpoint answers in its own shape: `/messages` a row array, the
  // composer's catalog (#2512) an object of groups.
  global.fetch = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => (String(input).includes('/slash-commands') ? { groups: [] } : []),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).IntersectionObserver = originalIntersectionObserver;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = originalIntersectionObserver;
  vi.restoreAllMocks();
});

describe('SessionTileGrid viewport gating (Issue #2509)', () => {
  it('a tile that has never been reported visible fetches neither /current-output nor /messages', async () => {
    render(
      <SessionTileGrid
        worktrees={[
          createWorktree({ id: 'wt-a' }),
          createWorktree({ id: 'wt-b' }),
        ]}
      />,
    );

    // Both tiles are mounted (the grid does not virtualize) …
    expect(screen.getByTestId('session-tile-wt-a')).toBeDefined();
    expect(screen.getByTestId('session-tile-wt-b')).toBeDefined();
    // … and both are observed …
    expect(observers).toHaveLength(2);

    // … and neither has asked the server anything.
    await waitFor(() => expect(observers[0].nodes).toHaveLength(1), { timeout: WAIT_TIMEOUT_MS });
    expect(fetchedUrls()).toEqual([]);
  });

  it('marks an offscreen tile as disabled and renders a placeholder instead of the chat surface', () => {
    render(<SessionTileGrid worktrees={[createWorktree({ id: 'wt-a' })]} />);

    expect(screen.getByTestId('session-tile-wt-a').getAttribute('data-enabled')).toBe('false');
    expect(screen.getByTestId('session-tile-placeholder-wt-a')).toBeDefined();
    expect(screen.queryByTestId('chat-surface-wt-a')).toBeNull();
  });

  it('the tile reported visible fetches both endpoints; its offscreen sibling still fetches nothing', async () => {
    render(
      <SessionTileGrid
        worktrees={[
          createWorktree({ id: 'wt-a' }),
          createWorktree({ id: 'wt-b' }),
        ]}
      />,
    );
    await waitFor(() => expect(observers).toHaveLength(2), { timeout: WAIT_TIMEOUT_MS });

    reportIntersection(0, true);

    await waitFor(
      () => {
        const urls = fetchedUrls();
        expect(urls.some((url) => url.includes('/wt-a/current-output'))).toBe(true);
        expect(urls.some((url) => url.includes('/wt-a/messages'))).toBe(true);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const urls = fetchedUrls();
    expect(urls.some((url) => url.includes('/wt-b/'))).toBe(false);
    expect(screen.getByTestId('chat-surface-wt-a')).toBeDefined();
    expect(screen.queryByTestId('chat-surface-wt-b')).toBeNull();
  });

  it('scrolling a tile back out of view stops it fetching again', async () => {
    render(<SessionTileGrid worktrees={[createWorktree({ id: 'wt-a' })]} />);
    await waitFor(() => expect(observers).toHaveLength(1), { timeout: WAIT_TIMEOUT_MS });

    reportIntersection(0, true);
    await waitFor(() => expect(fetchedUrls().length).toBeGreaterThan(0), { timeout: WAIT_TIMEOUT_MS });

    reportIntersection(0, false);
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();

    // The pollers are suspended, so nothing arrives on the next tick either.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchedUrls()).toEqual([]);
    expect(screen.getByTestId('session-tile-wt-a').getAttribute('data-enabled')).toBe('false');
  });
});
