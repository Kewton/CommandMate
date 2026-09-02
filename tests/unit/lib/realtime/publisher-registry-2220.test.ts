/**
 * The publisher registry's ownership and observability rules (Issue #2220).
 *
 * The integration file proves frames cross a module boundary. This one covers
 * the rules that only show up in the awkward orderings — a superseded owner
 * shutting down, a registration replaced mid-flight, a process with no owner at
 * all — because each of those is a way the bridge turns into a *new* silent
 * failure rather than a fix for the old one.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNROUTED_PUBLISH_WARN_INTERVAL_MS,
  __resetRoomPublisherRegistryForTest,
  getRoomPublisher,
  getRoomPublisherGeneration,
  getUnroutedPublishStats,
  recordUnroutedPublish,
  registerRoomPublisher,
  unregisterRoomPublisher,
  type RoomPublisher,
} from '@/lib/realtime/publisher-registry';

vi.mock('@/lib/logger', () => {
  const warn = vi.fn();
  return {
    createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    __warn: warn,
  };
});

const loggerModule = (await import('@/lib/logger')) as unknown as { __warn: ReturnType<typeof vi.fn> };
const warn = loggerModule.__warn;

/** A publisher that records what it was asked to do, and nothing else. */
function stubPublisher(label: string) {
  const published: Array<[string, unknown]> = [];
  const cleaned: string[][] = [];
  const publisher: RoomPublisher = {
    publish: (worktreeId, data) => published.push([worktreeId, data]),
    hasSubscribers: (worktreeId) => worktreeId === `room-of-${label}`,
    cleanupRooms: (ids) => cleaned.push(ids),
    migrateRooms: (renames) =>
      renames.map(({ oldId, newId }) => ({ oldId, newId, subscribers: 1 })),
  };
  return { publisher, published, cleaned };
}

beforeEach(() => {
  __resetRoomPublisherRegistryForTest();
  warn.mockClear();
});

afterEach(() => {
  __resetRoomPublisherRegistryForTest();
});

describe('claiming the rooms', () => {
  it('starts with no owner', () => {
    expect(getRoomPublisher()).toBeNull();
    expect(getRoomPublisherGeneration()).toBe(0);
  });

  it('hands the registered publisher back to every reader', () => {
    const { publisher, published } = stubPublisher('a');

    registerRoomPublisher(publisher);

    expect(getRoomPublisher()).toBe(publisher);
    getRoomPublisher()!.publish('wt-1', { type: 'message' });
    expect(published).toEqual([['wt-1', { type: 'message' }]]);
  });

  it('lets a later registration supersede an earlier one', () => {
    const first = stubPublisher('a');
    const second = stubPublisher('b');

    const firstHandle = registerRoomPublisher(first.publisher);
    const secondHandle = registerRoomPublisher(second.publisher);

    expect(getRoomPublisher()).toBe(second.publisher);
    expect(secondHandle.token).toBeGreaterThan(firstHandle.token);
  });
});

describe('withdrawal is authorised by token', () => {
  it('lets the current owner withdraw', () => {
    const { publisher } = stubPublisher('a');
    const handle = registerRoomPublisher(publisher);

    expect(handle.unregister()).toBe(true);
    expect(getRoomPublisher()).toBeNull();
  });

  it('declines a superseded owner’s withdrawal', () => {
    // The HMR / double-`setupWebSocket` hazard in one line: the instance being
    // torn down is not the one holding the live sockets, and a registry that
    // took its word for it would silence the running server.
    const first = stubPublisher('a');
    const second = stubPublisher('b');
    const firstHandle = registerRoomPublisher(first.publisher);
    registerRoomPublisher(second.publisher);

    expect(firstHandle.unregister()).toBe(false);
    expect(getRoomPublisher()).toBe(second.publisher);
  });

  it('is idempotent, and a re-used token cannot unseat a successor', () => {
    const first = stubPublisher('a');
    const second = stubPublisher('b');
    const firstHandle = registerRoomPublisher(first.publisher);

    expect(firstHandle.unregister()).toBe(true);
    expect(firstHandle.unregister()).toBe(false);

    // The generation counter never rewinds, so the slot the second publisher
    // takes cannot collide with the token the first one still holds.
    const secondHandle = registerRoomPublisher(second.publisher);
    expect(secondHandle.token).toBeGreaterThan(firstHandle.token);
    expect(unregisterRoomPublisher(firstHandle.token)).toBe(false);
    expect(getRoomPublisher()).toBe(second.publisher);
  });
});

describe('the unrouted-publish signal', () => {
  it('warns on the first dropped frame and counts it', () => {
    recordUnroutedPublish('broadcast', 'wt-1', 1_000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('realtime:no-room-publisher');
    expect(warn.mock.calls[0][1]).toMatchObject({ operation: 'broadcast', worktreeId: 'wt-1' });
    expect(getUnroutedPublishStats()).toMatchObject({ total: 1, operations: { broadcast: 1 } });
  });

  it('suppresses the flood but keeps counting it', () => {
    // `hasRoomSubscribers` is called on every poller tick for every session; an
    // unsuppressed warning there would bury the log it is supposed to surface.
    recordUnroutedPublish('broadcast', 'wt-1', 1_000);
    for (let i = 0; i < 50; i += 1) {
      recordUnroutedPublish('hasRoomSubscribers', 'wt-1', 1_000 + i);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const stats = getUnroutedPublishStats();
    expect(stats.total).toBe(51);
    expect(stats.suppressed).toBe(50);
    expect(stats.operations).toEqual({ broadcast: 1, hasRoomSubscribers: 50 });
  });

  it('warns again after the interval, reporting what it withheld', () => {
    recordUnroutedPublish('broadcast', 'wt-1', 1_000);
    recordUnroutedPublish('broadcast', 'wt-1', 2_000);
    recordUnroutedPublish('broadcast', 'wt-1', 1_000 + UNROUTED_PUBLISH_WARN_INTERVAL_MS);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({ total: 3, suppressedSinceLastWarning: 1 });
  });

  it('clears the counters when an owner appears', () => {
    recordUnroutedPublish('broadcast', 'wt-1', 1_000);
    const { publisher } = stubPublisher('a');

    registerRoomPublisher(publisher);

    // Otherwise a process that lost frames during startup would keep reporting
    // them for as long as it ran, long after the owner arrived.
    expect(getUnroutedPublishStats()).toMatchObject({ total: 0, suppressed: 0, operations: {} });
  });
});
