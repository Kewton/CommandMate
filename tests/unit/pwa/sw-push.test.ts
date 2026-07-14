/**
 * Behavioural tests for the Service Worker push / notificationclick handlers
 * (Issue #1125). The shipped public/sw.js is plain (non-module) JS, so we load
 * its source into a mock ServiceWorkerGlobalScope and dispatch synthetic events.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const swSource = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');

type Listener = (event: unknown) => void;

function loadServiceWorker(openWindows: Array<{ url: string; focus: () => unknown; navigate?: (url: string) => Promise<unknown> }> = []) {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn(() => Promise.resolve());
  const openWindow = vi.fn(() => Promise.resolve({ focus: vi.fn() }));

  const self = {
    addEventListener: (type: string, handler: Listener) => {
      listeners[type] = handler;
    },
    location: { origin: 'https://app.example' },
    registration: { showNotification },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(() => Promise.resolve(openWindows)),
      openWindow,
    },
  };

  const cachesStub = { open: vi.fn(), keys: vi.fn(), match: vi.fn(), delete: vi.fn() };
  // sw.js references bare `self` and `caches`; supply both as params.
  // eslint-disable-next-line no-new-func
  const run = new Function('self', 'caches', swSource);
  run(self, cachesStub);

  return { listeners, showNotification, openWindow, self };
}

function pushEvent(payload: unknown) {
  const event: { data: { json: () => unknown } | null; waitUntil: (p: unknown) => void; _promise?: unknown } = {
    data: payload === undefined ? null : { json: () => payload },
    waitUntil: (p) => {
      event._promise = p;
    },
  };
  return event;
}

describe('service worker push handler', () => {
  it('shows a notification from the payload', () => {
    const { listeners, showNotification } = loadServiceWorker();
    expect(listeners.push).toBeTypeOf('function');

    listeners.push(
      pushEvent({
        title: 'feature-x (claude)',
        body: '応答待ち: Continue?',
        url: '/worktrees/abc',
        tag: 'abc:prompt',
        worktreeId: 'abc',
        kind: 'prompt',
      })
    );

    expect(showNotification).toHaveBeenCalledWith(
      'feature-x (claude)',
      expect.objectContaining({
        body: '応答待ち: Continue?',
        tag: 'abc:prompt',
        data: expect.objectContaining({ url: '/worktrees/abc', worktreeId: 'abc', kind: 'prompt' }),
      })
    );
  });

  it('falls back to a default title when the payload is missing', () => {
    const { listeners, showNotification } = loadServiceWorker();
    listeners.push(pushEvent(undefined));
    expect(showNotification).toHaveBeenCalledWith('CommandMate', expect.objectContaining({ body: '' }));
  });
});

describe('service worker notificationclick handler', () => {
  function clickEvent(url: string) {
    const event: { notification: { close: () => void; data: { url: string } }; waitUntil: (p: unknown) => void; _promise?: unknown } = {
      notification: { close: vi.fn(), data: { url } },
      waitUntil: (p) => {
        event._promise = p;
      },
    };
    return event;
  }

  it('opens a new window at the deep link when no window is open', async () => {
    const { listeners, openWindow } = loadServiceWorker([]);
    const event = clickEvent('/worktrees/abc');
    listeners.notificationclick(event);
    await event._promise;
    expect(openWindow).toHaveBeenCalledWith('/worktrees/abc');
  });

  it('focuses an existing window already on the target path', async () => {
    const focus = vi.fn();
    const { listeners, openWindow } = loadServiceWorker([
      { url: 'https://app.example/worktrees/abc', focus },
    ]);
    const event = clickEvent('/worktrees/abc');
    listeners.notificationclick(event);
    await event._promise;
    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('navigates an existing window when none matches the path', async () => {
    const focus = vi.fn();
    const navigate = vi.fn(() => Promise.resolve({ focus }));
    const { listeners, openWindow } = loadServiceWorker([
      { url: 'https://app.example/other', focus: vi.fn(), navigate },
    ]);
    const event = clickEvent('/worktrees/abc');
    listeners.notificationclick(event);
    await event._promise;
    expect(navigate).toHaveBeenCalledWith('/worktrees/abc');
    expect(openWindow).not.toHaveBeenCalled();
  });
});
