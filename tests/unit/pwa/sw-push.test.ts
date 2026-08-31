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

/**
 * One notification already on the device, as `getNotifications` hands them back
 * (Issue #2001). Only `close` is ever called on them.
 */
interface StaleNotification {
  tag: string;
  close: ReturnType<typeof vi.fn>;
}

interface LoadOptions {
  /** Notifications the registration reports as currently displayed. */
  displayed?: StaleNotification[];
  /** Make `getNotifications` reject, as a registration in a bad state would. */
  getNotificationsRejects?: boolean;
  /** Drop `getNotifications` entirely, as an engine without it would. */
  omitGetNotifications?: boolean;
}

function loadServiceWorker(
  openWindows: Array<{ url: string; focus: () => unknown; navigate?: (url: string) => Promise<unknown> }> = [],
  options: LoadOptions = {}
) {
  const listeners: Record<string, Listener> = {};
  // Typed by the two parameters the assertions read, so `mock.calls[n][1]` is
  // the options object rather than a 0-tuple index error.
  const showNotification = vi.fn(
    (_title: string, _options: Record<string, unknown>) => Promise.resolve()
  );
  const openWindow = vi.fn(() => Promise.resolve({ focus: vi.fn() }));
  const displayed = options.displayed ?? [];
  const getNotifications = vi.fn((filter?: { tag?: string }) =>
    options.getNotificationsRejects
      ? Promise.reject(new Error('registration unavailable'))
      : Promise.resolve(
          filter?.tag ? displayed.filter((n) => n.tag === filter.tag) : displayed
        )
  );

  const registration: Record<string, unknown> = { showNotification };
  if (!options.omitGetNotifications) registration.getNotifications = getNotifications;

  const self = {
    addEventListener: (type: string, handler: Listener) => {
      listeners[type] = handler;
    },
    location: { origin: 'https://app.example' },
    registration,
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

  return { listeners, showNotification, getNotifications, openWindow, self };
}

/** A notification the device is already showing, ready to assert `close` on. */
function stale(tag: string): StaleNotification {
  return { tag, close: vi.fn() };
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
  it('shows a notification from the payload', async () => {
    const { listeners, showNotification } = loadServiceWorker();
    expect(listeners.push).toBeTypeOf('function');

    // Tagged, so since Issue #2155 this takes the close→show path and the
    // notification appears when the waitUntil promise settles, not inline.
    const event = pushEvent({
      title: 'feature-x (claude)',
      body: '応答待ち: Continue?',
      url: '/worktrees/abc',
      tag: 'abc:prompt',
      worktreeId: 'abc',
      kind: 'prompt',
    });
    listeners.push(event);
    await event._promise;

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

// ============================================================================
// Issue #2001 — the resolution push
// ============================================================================

/** The payload `resolution-push-notifier` produces, as the SW receives it. */
function resolutionPayload(tag = 'abc:prompt') {
  return {
    title: 'feature-x (claude)',
    body: 'Handled — answered on another device',
    url: '/worktrees/abc',
    tag,
    worktreeId: 'abc',
    kind: 'prompt',
    resolved: true,
  };
}

describe('service worker resolution push (Issue #2001)', () => {
  it('closes every stale card carrying the tag, then shows the replacement', async () => {
    const mine = [stale('abc:prompt'), stale('abc:prompt')];
    const { listeners, showNotification, getNotifications } = loadServiceWorker([], {
      displayed: [...mine, stale('other:prompt')],
    });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(getNotifications).toHaveBeenCalledWith({ tag: 'abc:prompt' });
    for (const notification of mine) expect(notification.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves another worktree’s card alone', async () => {
    const foreign = stale('other:prompt');
    const { listeners } = loadServiceWorker([], { displayed: [stale('abc:prompt'), foreign] });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('closes BEFORE showing — the order the userVisibleOnly contract depends on', async () => {
    // Inverting these two ends the push event with nothing displayed, which
    // Chrome answers with its own generic card, Firefox charges to a silent-push
    // quota and WebKit punishes by revoking the subscription. See
    // docs/design/cross-device-notification-dismissal.md.
    const outstanding = stale('abc:prompt');
    const { listeners, showNotification } = loadServiceWorker([], { displayed: [outstanding] });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(outstanding.close.mock.invocationCallOrder[0]).toBeLessThan(
      showNotification.mock.invocationCallOrder[0]
    );
  });

  it('replaces silently and without re-alerting, on the stale card’s own tag', async () => {
    const { listeners, showNotification } = loadServiceWorker([], {
      displayed: [stale('abc:prompt')],
    });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(showNotification).toHaveBeenCalledWith(
      'feature-x (claude)',
      expect.objectContaining({
        body: 'Handled — answered on another device',
        // Same tag as the prompt card: this is what makes it a replacement
        // rather than a second card.
        tag: 'abc:prompt',
        silent: true,
        renotify: false,
        data: expect.objectContaining({ resolved: true }),
      })
    );
  });

  it('still shows a notification when there was nothing to close', async () => {
    // The device the reader answered on has already closed its own card. The
    // contract is per delivered push, not per card cleared, so this one still
    // has to display something.
    const { listeners, showNotification } = loadServiceWorker([], { displayed: [] });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('still shows a notification when getNotifications rejects', async () => {
    const { listeners, showNotification } = loadServiceWorker([], {
      getNotificationsRejects: true,
    });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('still shows a notification on an engine without getNotifications', async () => {
    const { listeners, showNotification } = loadServiceWorker([], {
      omitGetNotifications: true,
    });

    const event = pushEvent(resolutionPayload());
    listeners.push(event);
    await event._promise;

    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Issue #2155 — every TAGGED push takes the close→show path, not just resolutions
// ============================================================================

/** A plain waiting push — no `resolved` flag, same tag as the card on screen. */
function waitingPayload(tag = 'abc:prompt') {
  return {
    title: 'feature-x (claude)',
    body: 'Waiting for your reply',
    url: '/worktrees/abc',
    tag,
    worktreeId: 'abc',
    kind: 'prompt',
  };
}

describe('service worker waiting push (Issue #2155)', () => {
  it('closes the stale card BEFORE showing, for a non-resolution push too', async () => {
    // Safari/iOS does not collapse same-tag cards on a bare `showNotification`,
    // so waiting pushes stacked up there while Chrome folded them into one
    // (measured 2026-08-30, iPad iOS 18.7 vs Android 10 Chrome 151). The close
    // has to happen first all the same: ending the event with nothing displayed
    // is the userVisibleOnly violation documented in
    // docs/design/cross-device-notification-dismissal.md §1.2.
    const outstanding = stale('abc:prompt');
    const { listeners, showNotification, getNotifications } = loadServiceWorker([], {
      displayed: [outstanding],
    });

    const event = pushEvent(waitingPayload());
    listeners.push(event);
    await event._promise;

    expect(getNotifications).toHaveBeenCalledWith({ tag: 'abc:prompt' });
    expect(outstanding.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(outstanding.close.mock.invocationCallOrder[0]).toBeLessThan(
      showNotification.mock.invocationCallOrder[0]
    );
  });

  it('folds an escalation re-notification onto the cards already piled up', async () => {
    // The escalation re-notification (waiting-push-notifier.ts) is an ordinary
    // push, so before #2155 each threshold hit added a card on iOS — up to 12
    // in an hour at the 5-minute setting.
    const piled = [stale('abc:prompt'), stale('abc:prompt')];
    const foreign = stale('other:prompt');
    const { listeners, showNotification } = loadServiceWorker([], {
      displayed: [...piled, foreign],
    });

    const event = pushEvent(waitingPayload());
    listeners.push(event);
    await event._promise;

    for (const notification of piled) expect(notification.close).toHaveBeenCalledTimes(1);
    expect(foreign.close).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('keeps the waiting replacement audible and re-alerting', async () => {
    const { listeners, showNotification } = loadServiceWorker([], {
      displayed: [stale('abc:prompt')],
    });

    const event = pushEvent(waitingPayload());
    listeners.push(event);
    await event._promise;

    const options = showNotification.mock.calls[0][1] as Record<string, unknown>;
    expect(options.renotify).toBe(true);
    // Absent, not `false`: the Notifications API reads an absent `silent` as
    // "respect the device's settings". `silent` stays a resolution-only flag —
    // quieting the waiting push is #1999 / #2000, not this Issue.
    expect(options).not.toHaveProperty('silent');
  });

  it('goes straight to showNotification when the payload has no tag', async () => {
    // Nothing to replace, so there is nothing to enumerate: the other side of
    // the branch, pinned so it cannot drift into an unconditional close pass.
    const { listeners, showNotification, getNotifications } = loadServiceWorker([], {
      displayed: [stale('abc:prompt')],
    });

    // Built inline, not via `waitingPayload(undefined)`: an explicit `undefined`
    // argument re-triggers a default parameter, which would silently tag it.
    const event = pushEvent({
      title: 'feature-x (claude)',
      body: 'Waiting for your reply',
      url: '/worktrees/abc',
      worktreeId: 'abc',
      kind: 'prompt',
    });
    listeners.push(event);
    await event._promise;

    expect(getNotifications).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
    const options = showNotification.mock.calls[0][1] as Record<string, unknown>;
    expect(options.tag).toBeUndefined();
  });

  it('still shows the waiting card when getNotifications rejects', async () => {
    const { listeners, showNotification } = loadServiceWorker([], {
      getNotificationsRejects: true,
    });

    const event = pushEvent(waitingPayload());
    listeners.push(event);
    await event._promise;

    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
