/**
 * The review list, the external apps list and each app's health check rest while the
 * tab is hidden and read once on coming back (Issue #4174, after #4160). Late answers
 * — older than the read made on coming back, after unmount, or for an app no longer
 * shown — are not taken.
 *
 * Positive controls: the hidden and late-answer tests fail on the code before #4174
 * (a bare `setInterval(fetch…)` that never looks at `visibilityState` and sets state
 * from whatever answers last).
 * Negative controls: visible ticks keep asking; a failed read keeps what it kept before.
 *
 * Both PC and mobile render these same components, so layout is not looked at.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/review',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

import ReviewTab from '@/components/review/ReviewTab';
import { ExternalAppsManager } from '@/components/external-apps/ExternalAppsManager';
import { ExternalAppStatus } from '@/components/external-apps/ExternalAppStatus';
import { EXTERNAL_APPS_POLL_INTERVAL_MS } from '@/config/external-apps-config';
import { resetClientDefaultSelectedAgents } from '@/config/default-agents';

const REVIEW_TICK_MS = 7000; // REVIEW_POLL_INTERVAL_MS
const HEALTH_TICK_MS = 30000;
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

/** Every read stays pending until the test answers it, by the order they were asked in. */
function holdReads(fetchSpy: ReturnType<typeof vi.fn>): Array<(reply: unknown) => void> {
  const answers: Array<(reply: unknown) => void> = [];
  fetchSpy.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
  return answers;
}

async function answerWith(resolve: (reply: unknown) => void, reply: unknown): Promise<void> {
  await act(async () => {
    resolve(reply);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const reviewRow = (id: string) => ({
  id,
  name: `feature/${id}`,
  repositoryName: 'repo',
  status: 'in_review',
  reviewStatus: 'in_review',
});
const reviewList = (...ids: string[]) => ({ worktrees: ids.map(reviewRow), repositories: [] });
const appList = (...names: string[]) => ({
  apps: names.map((name) => ({
    id: name,
    name,
    displayName: `App ${name}`,
    pathPrefix: name,
    targetPort: 4000,
    targetHost: 'localhost',
    appType: 'other',
    websocketEnabled: false,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  })),
});
const health = (id: string, healthy: boolean) => ({ id, healthy, lastChecked: 0 });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  resetClientDefaultSelectedAgents();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetClientDefaultSelectedAgents();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

type Case = {
  name: string;
  mount: () => ReturnType<typeof render>;
  tickMs: number;
  body: () => unknown;
};

const CASES: Case[] = [
  { name: 'ReviewTab', mount: () => render(<ReviewTab />), tickMs: REVIEW_TICK_MS, body: () => reviewList('a') },
  {
    name: 'ExternalAppsManager',
    mount: () => render(<ExternalAppsManager />),
    tickMs: EXTERNAL_APPS_POLL_INTERVAL_MS,
    body: () => appList('a'),
  },
  {
    name: 'ExternalAppStatus',
    mount: () => render(<ExternalAppStatus appId="a" />),
    tickMs: HEALTH_TICK_MS,
    body: () => health('a', true),
  },
];

/** Requests that are the poll's own (the manager's cards also mount health checks). */
function pollCalls(name: string): number {
  return fetchSpy.mock.calls.filter(([url]) => {
    const u = String(url);
    if (name === 'ExternalAppsManager') return u === '/api/external-apps';
    if (name === 'ExternalAppStatus') return u.endsWith('/health');
    return u.startsWith('/api/worktrees');
  }).length;
}

describe.each(CASES)('[#4174] $name while the tab is hidden', ({ name, mount, tickMs, body }) => {
  beforeEach(() => {
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(ok(String(url).endsWith('/health') && name !== 'ExternalAppStatus' ? health('a', true) : body())),
    );
  });

  it('visible: every tick asks (negative control)', async () => {
    mount();
    await tick(0);
    expect(pollCalls(name)).toBe(1);
    fetchSpy.mockClear();
    await tick(tickMs * 2);
    expect(pollCalls(name)).toBe(2);
  });

  it('hidden: no tick asks, and coming back asks exactly once', async () => {
    mount();
    await tick(0);
    await switchTo('hidden');
    fetchSpy.mockClear();
    await tick(tickMs * 3);
    expect(pollCalls(name)).toBe(0);
    await switchTo('visible');
    expect(pollCalls(name)).toBe(1);
    fetchSpy.mockClear();
    await tick(tickMs);
    expect(pollCalls(name)).toBe(1);
  });

  it('mounted hidden: nothing until it is shown', async () => {
    setVisibility('hidden');
    mount();
    await tick(tickMs * 2);
    expect(pollCalls(name)).toBe(0);
    await switchTo('visible');
    expect(pollCalls(name)).toBe(1);
  });

  it('unmounted: coming back asks nothing (negative control)', async () => {
    const { unmount } = mount();
    await tick(0);
    unmount();
    fetchSpy.mockClear();
    setVisibility('hidden');
    await switchTo('visible');
    await tick(tickMs * 2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('[#4174] ReviewTab when answers arrive late', () => {
  it('an answer older than the read made on coming back is not taken', async () => {
    const answers = holdReads(fetchSpy);
    render(<ReviewTab />);
    await tick(0);
    await switchTo('hidden');
    await switchTo('visible');
    expect(answers).toHaveLength(2);
    await answerWith(answers[1], ok(reviewList('fresh')));
    await answerWith(answers[0], ok(reviewList('stale')));
    expect(screen.getByTestId('review-item-fresh')).toBeTruthy();
    expect(screen.queryByTestId('review-item-stale')).toBeNull();
  });

  it('a failed newer read keeps the last list, and an older answer does not come back (negative control)', async () => {
    const answers = holdReads(fetchSpy);
    render(<ReviewTab />);
    await tick(0);
    await answerWith(answers[0], ok(reviewList('kept')));
    await tick(REVIEW_TICK_MS);
    await switchTo('hidden');
    await switchTo('visible');
    expect(answers).toHaveLength(3);
    await answerWith(answers[2], { ok: false, json: () => Promise.resolve({}) });
    await answerWith(answers[1], ok(reviewList('stale')));
    expect(screen.getByTestId('review-item-kept')).toBeTruthy();
    expect(screen.queryByTestId('review-item-stale')).toBeNull();
  });

  // React 19 no longer warns on setState after unmount, so this alone passes on the old
  // code too; the refusal itself is pinned in tests/unit/hooks/useVisiblePolling-4174.
  it('an answer after unmount sets nothing (negative control)', async () => {
    const answers = holdReads(fetchSpy);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<ReviewTab />);
    await tick(0);
    unmount();
    await answerWith(answers[0], ok(reviewList('late')));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('[#4174] ExternalAppsManager when answers arrive late', () => {
  it('an answer older than the read made on coming back is not taken', async () => {
    const answers: Array<(reply: unknown) => void> = [];
    fetchSpy.mockImplementation((url: string) =>
      String(url).endsWith('/health')
        ? Promise.resolve(ok(health('x', true)))
        : new Promise((resolve) => answers.push(resolve)),
    );
    render(<ExternalAppsManager />);
    await tick(0);
    await switchTo('hidden');
    await switchTo('visible');
    expect(answers).toHaveLength(2);
    await answerWith(answers[1], ok(appList('fresh')));
    await answerWith(answers[0], ok(appList('stale')));
    expect(screen.getByText('App fresh')).toBeTruthy();
    expect(screen.queryByText('App stale')).toBeNull();
  });
});

describe('[#4174] ExternalAppsManager refresh after a delete', () => {
  /** Lists answer at once; the DELETE is held until the test lets it finish. */
  function holdDelete(): { finish: () => Promise<void>; listCalls: () => number } {
    let release: ((reply: unknown) => void) | null = null;
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise((resolve) => (release = resolve));
      if (String(url).endsWith('/health')) return Promise.resolve(ok(health('a', true)));
      return Promise.resolve(ok(appList('a')));
    });
    return {
      finish: () => answerWith((reply) => release?.(reply), ok({})),
      listCalls: () => fetchSpy.mock.calls.filter(([u, init]) => u === '/api/external-apps' && !init).length,
    };
  }

  async function startDelete(): Promise<void> {
    await tick(0);
    fireEvent.click(screen.getByText('card.delete'));
    // The confirm row shows a second delete button; it is the one that sends.
    const buttons = screen.getAllByText('card.delete');
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('a delete finishing while hidden asks nothing until the tab is shown, then once', async () => {
    const { finish, listCalls } = holdDelete();
    render(<ExternalAppsManager />);
    await startDelete();
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    const before = listCalls();
    await switchTo('hidden');
    await finish();
    expect(listCalls()).toBe(before);
    await switchTo('visible');
    expect(listCalls()).toBe(before + 1);
  });

  it('a delete finishing while visible re-reads at once (negative control)', async () => {
    const { finish, listCalls } = holdDelete();
    render(<ExternalAppsManager />);
    await startDelete();
    const before = listCalls();
    await finish();
    expect(listCalls()).toBe(before + 1);
  });
});

describe('[#4174] ExternalAppStatus when answers arrive late', () => {
  const dotTitle = (container: HTMLElement) => container.querySelector('span[title]')?.getAttribute('title');

  it('an answer older than the read made on coming back is not taken', async () => {
    const answers = holdReads(fetchSpy);
    const { container } = render(<ExternalAppStatus appId="a" compact />);
    await tick(0);
    await switchTo('hidden');
    await switchTo('visible');
    expect(answers).toHaveLength(2);
    await answerWith(answers[1], ok(health('a', true)));
    await answerWith(answers[0], ok(health('a', false)));
    expect(dotTitle(container)).toBe('status.running');
  });

  it('an answer for the app shown before is not taken after appId changes', async () => {
    const answers = holdReads(fetchSpy);
    const { container, rerender } = render(<ExternalAppStatus appId="a" compact />);
    await tick(0);
    rerender(<ExternalAppStatus appId="b" compact />);
    await tick(0);
    expect(fetchSpy.mock.calls.map(([u]) => u)).toEqual([
      '/api/external-apps/a/health',
      '/api/external-apps/b/health',
    ]);
    await answerWith(answers[1], ok(health('b', false)));
    await answerWith(answers[0], ok(health('a', true)));
    expect(dotTitle(container)).toBe('status.stopped');
  });

  it('a failed newer check still shows unhealthy (negative control)', async () => {
    const answers = holdReads(fetchSpy);
    const { container } = render(<ExternalAppStatus appId="a" compact />);
    await tick(0);
    await answerWith(answers[0], ok(health('a', true)));
    expect(dotTitle(container)).toBe('status.running');
    await tick(HEALTH_TICK_MS);
    await answerWith(answers[1], { ok: false, json: () => Promise.resolve({}) });
    expect(dotTitle(container)).toBe('status.stopped');
  });
});
