/**
 * Issue #3952 review P2-2: the read mark moves when a send lets go of the
 * composer, not only when one is admitted.
 *
 * The order "send admitted → the answer's mark and capture → send released →
 * the answer takes the lock" admitted no send after the mark and did not queue,
 * so the answer typed at a screen read while the send was still typing. The
 * mark now moves on the release too, and such an answer reads the screen again.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  answerUnderInstanceInputLock,
  instanceInputReadMark,
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const S = 'mcbd-claude-wt-3952-mark';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetInstanceInputLocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

describe('[#3952 review P2-2] a mark taken while a send held the composer', () => {
  it('positive: the send let go before the answer took the lock — the screen is read again', async () => {
    const gate = deferred();
    const send = withInstanceInputLock(S, async () => {
      await gate.promise;
    });
    // The answer's read, while the send still holds the composer.
    const readMark = instanceInputReadMark();
    gate.resolve();
    await send;
    const stillApplies = vi.fn(async () => false);
    const typed = vi.fn(async () => 'typed');
    const outcome = await answerUnderInstanceInputLock(S, readMark, stillApplies, typed);
    expect(stillApplies).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ answered: false, reason: 'target-changed' });
    expect(typed).not.toHaveBeenCalled();
  });

  it('positive: a send revoked by a session replacement moves the mark too', async () => {
    const gate = deferred();
    const send = withInstanceInputLock(S, async () => {
      await gate.promise;
    });
    const readMark = instanceInputReadMark();
    invalidateInstanceInput(S);
    expect(instanceInputReadMark()).not.toBe(readMark);
    gate.resolve();
    await send;
  });

  it('negative: the send had let go before the mark — nothing is read again', async () => {
    await withInstanceInputLock(S, async () => {});
    const readMark = instanceInputReadMark();
    const stillApplies = vi.fn(async () => false);
    const outcome = await answerUnderInstanceInputLock(S, readMark, stillApplies, async () => 'typed');
    expect(stillApplies).not.toHaveBeenCalled();
    expect(outcome).toEqual({ answered: true, value: 'typed' });
  });

  it('negative: another answer (shared) coming and going does not move the mark', async () => {
    const readMark = instanceInputReadMark();
    await answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => undefined);
    expect(instanceInputReadMark()).toBe(readMark);
  });
});
