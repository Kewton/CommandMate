/**
 * Issue #3798 PR 2: a resolution push names the episode whose card it clears
 * (`resolvedEpisodeId`), and the Service Worker leaves a newer episode's card
 * standing (design `docs/design/issue-3798-waiting-episode.md` §2.4 規則 5).
 *
 * A resolution can reach a device after the card of a newer wait in the same
 * worktree (same tag). Cards of the resolved episode, and cards that name none,
 * are closed and the resolution shown, as before; a card of another episode
 * sent after the resolution was decided (`data.order` greater than the
 * resolution's `order`, the server's per-worktree counter) is closed and shown
 * again with its own content, silently, instead of the resolution. A different
 * id alone is not enough — a device that missed one wait's card can still show
 * an older, finished wait's card — nor is the wait's start, which the next
 * wait can reuse; those cards are closed. Every branch calls `showNotification` exactly once — the
 * `userVisibleOnly` contract (Issue #2001). A resolution without the id keeps
 * today's behaviour.
 *
 * Loaded the way `sw-push.test.ts` loads it: the shipped source run against a
 * mock ServiceWorkerGlobalScope.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const swSource = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');

type Listener = (event: unknown) => void;

interface DisplayedNotification {
  tag: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data: Record<string, unknown>;
  close: ReturnType<typeof vi.fn>;
}

interface LoadOptions {
  displayed?: DisplayedNotification[];
  getNotificationsRejects?: boolean;
  omitGetNotifications?: boolean;
}

function loadServiceWorker(options: LoadOptions = {}) {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn((_title: string, _options: Record<string, unknown>) => Promise.resolve());
  const displayed = options.displayed ?? [];
  const getNotifications = vi.fn((filter?: { tag?: string }) =>
    options.getNotificationsRejects
      ? Promise.reject(new Error('registration unavailable'))
      : Promise.resolve(filter?.tag ? displayed.filter((n) => n.tag === filter.tag) : displayed)
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
    clients: { claim: vi.fn(), matchAll: vi.fn(() => Promise.resolve([])), openWindow: vi.fn() },
  };
  const cachesStub = { open: vi.fn(), keys: vi.fn(), match: vi.fn(), delete: vi.fn() };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', swSource)(self, cachesStub);
  return { listeners, showNotification };
}

const TAG = 'wt-1:prompt';

/** The worktree's prompt push order the resolution in these tests took. */
const RESOLVED_ORDER = 10;
/** A card sent after that resolution was decided, and one sent before it. */
const AFTER = RESOLVED_ORDER + 1;
const BEFORE = RESOLVED_ORDER - 1;

function card(
  episodeId: string | undefined,
  body = `waiting ${episodeId ?? 'legacy'}`,
  order: number | null = episodeId !== undefined ? AFTER : null
): DisplayedNotification {
  return {
    tag: TAG,
    title: 'feature-x (claude)',
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: '/worktrees/wt-1',
      worktreeId: 'wt-1',
      kind: 'prompt',
      resolved: false,
      ...(episodeId !== undefined ? { episodeId } : {}),
      ...(order !== null ? { order } : {}),
    },
    close: vi.fn(),
  };
}

function resolution(resolvedEpisodeId?: string, order: number = RESOLVED_ORDER): Record<string, unknown> {
  return {
    timestamp: 1_800_000_010_000,
    order,
    title: 'feature-x (claude)',
    body: 'Handled',
    tag: TAG,
    worktreeId: 'wt-1',
    kind: 'prompt',
    url: '/worktrees/wt-1',
    resolved: true,
    ...(resolvedEpisodeId !== undefined ? { resolvedEpisodeId } : {}),
  };
}

async function dispatchPush(listeners: Record<string, Listener>, payload: unknown): Promise<void> {
  const event: { data: { json: () => unknown }; waitUntil: (p: unknown) => void; _promise?: unknown } = {
    data: { json: () => payload },
    waitUntil: (p) => {
      event._promise = p;
    },
  };
  listeners.push(event);
  await event._promise;
}

describe('[#3798] the resolution names its episode', () => {
  it('resolution closes only its own episode card and re-shows a newer one silently', async () => {
    const own = card('wep-a');
    const newer = card('wep-b', 'waiting for the next prompt');
    const { listeners, showNotification } = loadServiceWorker({ displayed: [own, newer] });

    await dispatchPush(listeners, resolution('wep-a'));

    expect(own.close).toHaveBeenCalledTimes(1);
    expect(newer.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0];
    expect(title).toBe('feature-x (claude)');
    expect(options).toMatchObject({
      body: 'waiting for the next prompt',
      tag: TAG,
      silent: true,
      renotify: false,
      data: expect.objectContaining({ episodeId: 'wep-b', resolved: false }),
    });
    // Closed before shown: the userVisibleOnly order of #2001.
    expect(newer.close.mock.invocationCallOrder[0]).toBeLessThan(showNotification.mock.invocationCallOrder[0]);
  });

  it('its own card alone (and a card naming no episode) is replaced by the resolution', async () => {
    const own = card('wep-a');
    const legacy = card(undefined);
    const { listeners, showNotification } = loadServiceWorker({ displayed: [legacy, own] });

    await dispatchPush(listeners, resolution('wep-a'));

    expect(own.close).toHaveBeenCalledTimes(1);
    expect(legacy.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      body: 'Handled',
      silent: true,
      renotify: false,
      data: expect.objectContaining({ resolved: true }),
    });
  });

  it('showNotification is called exactly once on every branch', async () => {
    const branches: Array<{ name: string; options: LoadOptions; payload: Record<string, unknown> }> = [
      { name: 'newer card', options: { displayed: [card('wep-a'), card('wep-b')] }, payload: resolution('wep-a') },
      { name: 'two newer cards', options: { displayed: [card('wep-b'), card('wep-c')] }, payload: resolution('wep-a') },
      { name: 'own card', options: { displayed: [card('wep-a')] }, payload: resolution('wep-a') },
      { name: 'nothing displayed', options: { displayed: [] }, payload: resolution('wep-a') },
      { name: 'enumeration rejects', options: { getNotificationsRejects: true }, payload: resolution('wep-a') },
      { name: 'no getNotifications', options: { omitGetNotifications: true }, payload: resolution('wep-a') },
      { name: 'id-less resolution', options: { displayed: [card('wep-b')] }, payload: resolution() },
      { name: 'untagged resolution', options: { displayed: [card('wep-b')] }, payload: { ...resolution('wep-a'), tag: undefined } },
      { name: 'waiting card', options: { displayed: [card('wep-a')] }, payload: { title: 't', tag: TAG, kind: 'prompt', episodeId: 'wep-b' } },
    ];
    for (const branch of branches) {
      const { listeners, showNotification } = loadServiceWorker(branch.options);
      await dispatchPush(listeners, branch.payload);
      expect(showNotification, branch.name).toHaveBeenCalledTimes(1);
    }
  });

  it('two newer cards: the one the server sent last is the one shown again', async () => {
    const b = card('wep-b', 'b', AFTER);
    const c = card('wep-c', 'c', AFTER + 1);
    const { listeners, showNotification } = loadServiceWorker({ displayed: [b, c] });
    await dispatchPush(listeners, resolution('wep-a'));
    expect(b.close).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalled();
    expect(showNotification.mock.calls[0][1]).toMatchObject({ body: 'c', silent: true, renotify: false });
  });

  it('id-less resolution keeps today\'s behaviour', async () => {
    const a = card('wep-a');
    const b = card('wep-b');
    const { listeners, showNotification } = loadServiceWorker({ displayed: [a, b] });

    await dispatchPush(listeners, resolution());

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({ body: 'Handled', silent: true, renotify: false });
  });

  it('a waiting card keeps its episode id in data, and still replaces every card of its tag', async () => {
    const older = card('wep-a');
    const { listeners, showNotification } = loadServiceWorker({ displayed: [older] });

    await dispatchPush(listeners, { title: 't', body: 'b', tag: TAG, kind: 'prompt', worktreeId: 'wt-1', episodeId: 'wep-b' });

    expect(older.close).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      renotify: true,
      data: expect.objectContaining({ episodeId: 'wep-b' }),
    });
    expect(showNotification.mock.calls[0][1]).not.toHaveProperty('silent');
  });
});

describe('[#3798] newer is proved by the push order, not by a different id', () => {
  it('old A / resolution B: an older card of another episode is closed, not shown again', async () => {
    // Wait A's card stayed on this device because wait B's card never reached it.
    const oldA = card('wep-a', 'waiting A', BEFORE);
    const { listeners, showNotification } = loadServiceWorker({ displayed: [oldA] });

    await dispatchPush(listeners, resolution('wep-b'));

    expect(oldA.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      body: 'Handled',
      silent: true,
      renotify: false,
      data: expect.objectContaining({ resolved: true }),
    });
  });

  it('new B / resolution A: a card sent after the resolution was decided is shown again', async () => {
    const newB = card('wep-b', 'waiting B', AFTER);
    const { listeners, showNotification } = loadServiceWorker({ displayed: [newB] });

    await dispatchPush(listeners, resolution('wep-a'));

    expect(newB.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      body: 'waiting B',
      silent: true,
      renotify: false,
      data: expect.objectContaining({ episodeId: 'wep-b', order: AFTER, resolved: false }),
    });
  });

  it('an order equal to the resolution\'s is not newer (the server never repeats one)', async () => {
    const tie = card('wep-b', 'waiting B', RESOLVED_ORDER);
    const { listeners, showNotification } = loadServiceWorker({ displayed: [tie] });
    await dispatchPush(listeners, resolution('wep-a'));
    expect(tie.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({ body: 'Handled', silent: true });
  });

  it('the wait\'s start does not decide: a card with a later since but an earlier order is closed', async () => {
    const reused = card('wep-b', 'waiting B', BEFORE);
    reused.data.waitingSince = 1_800_000_099_000;
    const { listeners, showNotification } = loadServiceWorker({ displayed: [reused] });
    await dispatchPush(listeners, resolution('wep-a'));
    expect(reused.close).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({ body: 'Handled' });
  });

  it('a card of another episode without an order, or a resolution without one, is closed', async () => {
    const noOrder = card('wep-b', 'waiting B', null);
    const first = loadServiceWorker({ displayed: [noOrder] });
    await dispatchPush(first.listeners, resolution('wep-a'));
    expect(noOrder.close).toHaveBeenCalledTimes(1);
    expect(first.showNotification.mock.calls[0][1]).toMatchObject({ body: 'Handled' });

    const newB = card('wep-b', 'waiting B', AFTER);
    const second = loadServiceWorker({ displayed: [newB] });
    const { order: _dropped, ...unordered } = resolution('wep-a');
    await dispatchPush(second.listeners, unordered);
    expect(newB.close).toHaveBeenCalledTimes(1);
    expect(second.showNotification.mock.calls[0][1]).toMatchObject({ body: 'Handled' });
  });

  it('an older and a newer card of other episodes: only the newer is shown again', async () => {
    const newer = card('wep-c', 'waiting C', AFTER);
    const older = card('wep-a', 'waiting A', BEFORE);
    // Handed back newest-first: order of enumeration does not decide.
    const { listeners, showNotification } = loadServiceWorker({ displayed: [newer, older] });
    await dispatchPush(listeners, resolution('wep-b'));
    expect(newer.close).toHaveBeenCalledTimes(1);
    expect(older.close).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).toMatchObject({ body: 'waiting C', silent: true });
  });

  it('a waiting card keeps its order in data', async () => {
    const { listeners, showNotification } = loadServiceWorker({ displayed: [] });
    await dispatchPush(listeners, {
      title: 't',
      body: 'b',
      tag: TAG,
      kind: 'prompt',
      worktreeId: 'wt-1',
      episodeId: 'wep-b',
      order: AFTER,
    });
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      data: expect.objectContaining({ episodeId: 'wep-b', order: AFTER }),
    });
  });
});
