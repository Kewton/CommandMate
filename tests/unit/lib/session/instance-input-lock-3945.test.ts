/**
 * Issue #3945: the instance input lock — one writer at a time per tmux session.
 *
 * The contract the prereview (#5 / #6 / #7) asked to be pinned:
 *   - a waiter that times out is cancelled, never run late;
 *   - the owner keeps the composer until its function settles (throw included);
 *   - a call from inside the owner joins its ticket instead of deadlocking;
 *   - a module loaded twice (`next dev` bundles) shares one lock (`globalThis`);
 *   - a session replaced while sends wait expires them and the stale owner;
 *   - mark TTL < lock wait (constants).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CARRIED_PASTE_MARK_TTL_MS,
  INSTANCE_INPUT_LOCK_WAIT_MS,
  LATE_PASTE_OBSERVE_MS,
  InstanceInputLockTimeoutError,
  InstanceInputSessionReplacedError,
  clearExpiredCarriedPasteMark,
  currentInstanceInputTicket,
  getCarriedPasteMark,
  invalidateInstanceInput,
  leaveCarriedPasteMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';
import { classifySendFailure } from '@/lib/session/send-attempt-state';

const S = 'mcbd-codex-wt-lock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued microtask (and the lock's hand-over) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('instance input lock (Issue #3945)', () => {
  beforeEach(() => {
    resetInstanceInputLocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  it('the mark expires before a queued send would give up, and the late watch is shorter still', () => {
    expect(CARRIED_PASTE_MARK_TTL_MS).toBeLessThan(INSTANCE_INPUT_LOCK_WAIT_MS);
    expect(LATE_PASTE_OBSERVE_MS).toBeLessThan(CARRIED_PASTE_MARK_TTL_MS);
  });

  it('runs a second writer only after the first settles, in arrival order', async () => {
    const events: string[] = [];
    const gateA = deferred();
    const a = withInstanceInputLock(S, async () => {
      events.push('A:start');
      await gateA.promise;
      events.push('A:end');
    });
    const b = withInstanceInputLock(S, async () => {
      events.push('B:start');
    });
    const c = withInstanceInputLock(S, async () => {
      events.push('C:start');
    });
    await flush();
    expect(events).toEqual(['A:start']);
    gateA.resolve();
    await Promise.all([a, b, c]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'C:start']);
  });

  it('does not order different sessions', async () => {
    const events: string[] = [];
    const gateA = deferred();
    const a = withInstanceInputLock(S, async () => {
      await gateA.promise;
      events.push('A:end');
    });
    await withInstanceInputLock(`${S}-other`, async () => {
      events.push('other');
    });
    expect(events).toEqual(['other']);
    gateA.resolve();
    await a;
  });

  it('A holds -> B times out -> A releases -> C succeeds: B never runs, and its error is not-sent', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const gateA = deferred();
    const a = withInstanceInputLock(S, async () => {
      events.push('A');
      await gateA.promise;
    });
    const b = withInstanceInputLock(
      S,
      async () => {
        events.push('B');
      },
      { waitMs: 1_000 }
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    const bError = await b;
    expect(bError).toBeInstanceOf(InstanceInputLockTimeoutError);
    expect(classifySendFailure(bError)).toEqual({ state: 'not-sent', reason: 'input-lock-timeout' });
    // Wrapped as a tool wraps it, the wording still classifies.
    expect(classifySendFailure(new Error(`Failed to send message to Codex: ${(bError as Error).message}`))).toEqual({
      state: 'not-sent',
      reason: 'input-lock-timeout',
    });

    gateA.resolve();
    await a;
    await withInstanceInputLock(S, async () => {
      events.push('C');
    });
    expect(events).toEqual(['A', 'C']);
  });

  it('does not hand the composer on while the owner is still working, however long it takes', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const a = withInstanceInputLock(S, async () => {
      await new Promise((resolve) => setTimeout(resolve, INSTANCE_INPUT_LOCK_WAIT_MS * 3));
      events.push('A:end');
    });
    const b = withInstanceInputLock(S, async () => {
      events.push('B');
    }).catch(() => events.push('B:timeout'));
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    // B timed out waiting; A was never cut short.
    expect(events).toEqual(['B:timeout', 'A:end']);
  });

  it('releases the composer when the owner throws', async () => {
    const a = withInstanceInputLock(S, async () => {
      throw new Error('boom');
    });
    await expect(a).rejects.toThrow('boom');
    await expect(withInstanceInputLock(S, async () => 'next')).resolves.toBe('next');
  });

  it('a call from inside the owner joins its ticket (no self-deadlock), and the ticket ends with the owner', async () => {
    let outer: InstanceInputTicket | null = null;
    let inner: InstanceInputTicket | null = null;
    await withInstanceInputLock(S, async (ticket) => {
      outer = ticket;
      await withInstanceInputLock(S, async (joined) => {
        inner = joined;
      });
      expect(currentInstanceInputTicket(S)).toBe(ticket);
    });
    expect(inner).toBe(outer);
    expect(outer!.isCurrent()).toBe(false);
    expect(currentInstanceInputTicket(S)).toBeNull();
  });

  it('marks only an owner that had to queue as waited', async () => {
    const gateA = deferred();
    const tickets: InstanceInputTicket[] = [];
    const a = withInstanceInputLock(S, async (ticket) => {
      tickets.push(ticket);
      await gateA.promise;
    });
    const b = withInstanceInputLock(S, async (ticket) => {
      tickets.push(ticket);
    });
    await flush();
    gateA.resolve();
    await Promise.all([a, b]);
    expect(tickets.map((t) => t.waited)).toEqual([false, true]);
    expect(tickets[1].generation).toBeGreaterThan(tickets[0].generation);
  });

  it('shares one lock when the module is loaded twice (globalThis), as `next dev` bundles do', async () => {
    vi.resetModules();
    const second = await import('@/lib/session/instance-input-lock');
    expect(second.withInstanceInputLock).not.toBe(withInstanceInputLock);

    const events: string[] = [];
    const gateA = deferred();
    const a = withInstanceInputLock(S, async () => {
      events.push('A:start');
      await gateA.promise;
      events.push('A:end');
    });
    const b = second.withInstanceInputLock(S, async () => {
      events.push('B:start');
    });
    await flush();
    expect(events).toEqual(['A:start']);
    gateA.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start']);
  });

  describe('carried paste mark', () => {
    it('is handled by the next owner, cannot be revived by the stale one, and is not shortened by a refusal', async () => {
      vi.useFakeTimers();
      let a: InstanceInputTicket | null = null;
      await withInstanceInputLock(S, async (ticket) => {
        a = ticket;
        leaveCarriedPasteMark(ticket);
      });
      const mark = getCarriedPasteMark(S);
      expect(mark?.originGeneration).toBe(a!.generation);

      // A's ticket is over: it can neither leave a new mark nor clear one.
      leaveCarriedPasteMark(a!);
      clearExpiredCarriedPasteMark(a!, mark!.expiresAt + 1);
      expect(getCarriedPasteMark(S)).toEqual(mark);

      // B refused before the expiry (a guard, a dialog): the mark keeps its expiry.
      await withInstanceInputLock(S, async (ticket) => {
        clearExpiredCarriedPasteMark(ticket);
      });
      expect(getCarriedPasteMark(S)?.expiresAt).toBe(mark!.expiresAt);

      // C waits it out and takes it down.
      await vi.advanceTimersByTimeAsync(CARRIED_PASTE_MARK_TTL_MS);
      await withInstanceInputLock(S, async (ticket) => {
        clearExpiredCarriedPasteMark(ticket);
      });
      expect(getCarriedPasteMark(S)).toBeNull();
    });
  });

  describe('session replaced (kill / recreate)', () => {
    it('expires waiters and the in-flight owner, drops the mark, and leaves the next session free', async () => {
      const events: string[] = [];
      const gateA = deferred();
      let a: InstanceInputTicket | null = null;
      const aRun = withInstanceInputLock(S, async (ticket) => {
        a = ticket;
        leaveCarriedPasteMark(ticket);
        await gateA.promise;
        // The old send resumes after the session was replaced.
        events.push(ticket.isCurrent() ? 'A:still-owner' : 'A:stale');
      });
      const b = withInstanceInputLock(S, async () => {
        events.push('B');
      }).catch((error: unknown) => error);
      await flush();

      invalidateInstanceInput(S);

      const bError = await b;
      expect(bError).toBeInstanceOf(InstanceInputSessionReplacedError);
      expect(classifySendFailure(bError)).toEqual({ state: 'not-sent', reason: 'session-replaced' });
      expect(a!.isCurrent()).toBe(false);
      expect(getCarriedPasteMark(S)).toBeNull();

      // The new session's first send does not wait for the stale owner.
      await withInstanceInputLock(S, async () => {
        events.push('C');
      });
      gateA.resolve();
      await aRun;
      expect(events).toEqual(['C', 'A:stale']);
    });

    it('keeps the ticket of a send that relaunches its own pane', async () => {
      await withInstanceInputLock(S, async (ticket) => {
        invalidateInstanceInput(S);
        expect(ticket.isCurrent()).toBe(true);
      });
    });
  });
});
