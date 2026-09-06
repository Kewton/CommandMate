/**
 * Issue #2228: completion-notification dedup must survive a module-graph boundary.
 *
 * Under `next start` the custom server graph and the Next route graph each
 * evaluate `notification-dedup` once (#2220). With `lastSent` as a bare
 * module-scoped Map, a completion recorded by one graph is invisible to the
 * other, so a poller that resumes under the other graph's ownership re-sends
 * the same completion (#2223 removed the double-poller case but not this one).
 *
 * The second module instance is real, not simulated: `vi.resetModules()` gives
 * a fresh evaluation of the module, exactly as a second bundle would. What the
 * test checks is that the fresh instance still sees the first instance's record.
 *
 * `vi.resetModules()` does NOT clear `globalThis`, so every test wipes the
 * shared slot itself before and after — otherwise state would leak across
 * tests (and across files, since the slot is process-wide).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type DedupModule = typeof import('@/lib/push/notification-dedup');

const SLOT = '__notificationDedupLastSent';

function clearSharedSlot(): void {
  delete (globalThis as Record<string, unknown>)[SLOT];
}

async function freshInstance(): Promise<DedupModule> {
  vi.resetModules();
  return import('@/lib/push/notification-dedup');
}

const completion = { worktreeId: 'wt-1', kind: 'completion' as const, content: 'Task done' };

describe('notification-dedup across module instances (Issue #2228)', () => {
  beforeEach(() => {
    clearSharedSlot();
  });

  afterEach(() => {
    clearSharedSlot();
    vi.resetModules();
  });

  it('a completion recorded by one module instance is suppressed by a second instance', async () => {
    const graphA = await freshInstance();
    const graphB = await freshInstance();
    expect(graphB).not.toBe(graphA);

    expect(graphA.shouldSendNotification(completion, 0)).toBe(true);
    // Same completion, seen again from the other graph within the window.
    expect(graphB.shouldSendNotification(completion, 1_000)).toBe(false);
  });

  it('the shared record lives on globalThis and is seen by an instance created later', async () => {
    const graphA = await freshInstance();
    expect(graphA.shouldSendNotification(completion, 0)).toBe(true);

    // Instance created *after* the record exists — the ownership-handover shape.
    const graphB = await freshInstance();
    expect(graphB.shouldSendNotification(completion, 1_000)).toBe(false);

    const slot = (globalThis as Record<string, unknown>)[SLOT];
    expect(slot).toBeInstanceOf(Map);
    expect((slot as Map<string, unknown>).has('wt-1:completion')).toBe(true);
  });

  it('TTL still applies across instances: after the window the completion is sent again', async () => {
    const graphA = await freshInstance();
    const graphB = await freshInstance();

    expect(graphA.shouldSendNotification(completion, 0)).toBe(true);
    expect(
      graphB.shouldSendNotification(completion, graphB.DEFAULT_DEDUP_WINDOW_MS)
    ).toBe(true);
  });

  it('a different content hash is still sent from the other instance', async () => {
    const graphA = await freshInstance();
    const graphB = await freshInstance();

    expect(graphA.shouldSendNotification(completion, 0)).toBe(true);
    expect(
      graphB.shouldSendNotification({ ...completion, content: 'Another task done' }, 1_000)
    ).toBe(true);
  });

  it('resetNotificationDedup() on one instance clears the state the other instance sees', async () => {
    const graphA = await freshInstance();
    const graphB = await freshInstance();

    expect(graphA.shouldSendNotification(completion, 0)).toBe(true);
    graphB.resetNotificationDedup();
    expect(graphA.shouldSendNotification(completion, 1_000)).toBe(true);
  });
});
