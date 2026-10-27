/**
 * Issue #3952: the answers the server types at a screen it read join the
 * instance input lock as `shared` writers.
 *
 *   - an answer waits for a send that holds the composer, and a send waits for
 *     an answer in progress (both directions);
 *   - answers do not wait for each other (they never did; #3880's holds order them);
 *   - an answer that had to wait for a send reads the screen again, and types
 *     nothing when it moved or could not be read (`answered: false`);
 *   - an answer that did not wait reads nothing again (no extra capture);
 *   - a call inside a send's own ownership joins it;
 *   - another instance's session is not waited for;
 *   - a session replaced while an answer holds it takes its ticket.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  answerUnderInstanceInputLock,
  instanceInputReadMark,
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';

const S = 'mcbd-codex-wt-3952';
const OTHER = 'mcbd-codex-wt-3952-codex-2';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('instance input lock: answers as shared writers (Issue #3952)', () => {
  beforeEach(() => {
    resetInstanceInputLocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  it('an answer waits for a send in progress, then reads the screen again and types', async () => {
    const events: string[] = [];
    const send = deferred();
    const readMark = instanceInputReadMark();
    const a = withInstanceInputLock(S, async () => {
      events.push('send:start');
      await send.promise;
      events.push('send:end');
    });
    const stillApplies = vi.fn(async () => true);
    const answer = answerUnderInstanceInputLock(S, readMark, stillApplies, async () => {
      events.push('answer');
      return 'typed';
    });
    await flush();
    expect(events).toEqual(['send:start']);
    send.resolve();
    await a;
    await expect(answer).resolves.toEqual({ answered: true, value: 'typed' });
    expect(events).toEqual(['send:start', 'send:end', 'answer']);
    expect(stillApplies).toHaveBeenCalledTimes(1);
  });

  it('a send waits for an answer in progress', async () => {
    const events: string[] = [];
    const answering = deferred();
    const answer = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
      events.push('answer:start');
      await answering.promise;
      events.push('answer:end');
    });
    await flush();
    const send = withInstanceInputLock(S, async () => {
      events.push('send');
    });
    await flush();
    expect(events).toEqual(['answer:start']);
    answering.resolve();
    await answer;
    await send;
    expect(events).toEqual(['answer:start', 'answer:end', 'send']);
  });

  it('negative control: two answers do not wait for each other', async () => {
    const events: string[] = [];
    const first = deferred();
    const a = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
      events.push('b');
    });
    await b;
    expect(events).toEqual(['a:start', 'b']);
    first.resolve();
    await a;
  });

  it('a send queued before an answer is not overtaken by it', async () => {
    const events: string[] = [];
    const answering = deferred();
    const a = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
      events.push('a');
      await answering.promise;
    });
    await flush();
    const send = withInstanceInputLock(S, async () => {
      events.push('send');
    });
    const b = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
      events.push('b');
    });
    await flush();
    expect(events).toEqual(['a']);
    answering.resolve();
    await Promise.all([a, send, b]);
    expect(events).toEqual(['a', 'send', 'b']);
  });

  it('the screen moved while the answer waited: nothing is typed', async () => {
    const send = deferred();
    const readMark = instanceInputReadMark();
    const a = withInstanceInputLock(S, () => send.promise);
    const typed = vi.fn(async () => undefined);
    const outcome = answerUnderInstanceInputLock(S, readMark, async () => false, typed);
    send.resolve();
    await a;
    await expect(outcome).resolves.toEqual({ answered: false, reason: 'target-changed' });
    expect(typed).not.toHaveBeenCalled();
  });

  it('the screen could not be read again: nothing is typed', async () => {
    const send = deferred();
    const readMark = instanceInputReadMark();
    const a = withInstanceInputLock(S, () => send.promise);
    const typed = vi.fn(async () => undefined);
    const outcome = answerUnderInstanceInputLock(
      S,
      readMark,
      async () => {
        throw new Error('no server running');
      },
      typed
    );
    send.resolve();
    await a;
    await expect(outcome).resolves.toEqual({ answered: false, reason: 'recheck-failed' });
    expect(typed).not.toHaveBeenCalled();
  });

  it('a send that came and went between the read and the answer is noticed', async () => {
    const readMark = instanceInputReadMark();
    await withInstanceInputLock(S, async () => undefined);
    const stillApplies = vi.fn(async () => false);
    const typed = vi.fn(async () => undefined);
    await expect(answerUnderInstanceInputLock(S, readMark, stillApplies, typed)).resolves.toEqual({
      answered: false,
      reason: 'target-changed',
    });
    expect(stillApplies).toHaveBeenCalledTimes(1);
    expect(typed).not.toHaveBeenCalled();
  });

  it('negative control: an answer no send preceded reads nothing again', async () => {
    const stillApplies = vi.fn(async () => false);
    await expect(
      answerUnderInstanceInputLock(S, instanceInputReadMark(), stillApplies, async () => 'typed')
    ).resolves.toEqual({ answered: true, value: 'typed' });
    expect(stillApplies).not.toHaveBeenCalled();
  });

  it('negative control: another instance’s send is not waited for', async () => {
    const send = deferred();
    const a = withInstanceInputLock(OTHER, () => send.promise);
    const stillApplies = vi.fn(async () => true);
    await expect(
      answerUnderInstanceInputLock(S, instanceInputReadMark(), stillApplies, async () => 'typed')
    ).resolves.toEqual({ answered: true, value: 'typed' });
    send.resolve();
    await a;
  });

  it('inside a send that owns the session it joins: no wait, no second read', async () => {
    const stillApplies = vi.fn(async () => false);
    let inner: InstanceInputTicket | null = null;
    let outer: InstanceInputTicket | null = null;
    await withInstanceInputLock(S, async (ticket) => {
      outer = ticket;
      const outcome = await answerUnderInstanceInputLock(S, instanceInputReadMark(), stillApplies, async (t) => {
        inner = t;
      });
      expect(outcome.answered).toBe(true);
    });
    expect(inner).toBe(outer);
    expect(stillApplies).not.toHaveBeenCalled();
  });

  it('a send that holds the composer past the wait: the answer gives up untyped', async () => {
    vi.useFakeTimers();
    const send = deferred();
    const a = withInstanceInputLock(S, () => send.promise);
    const typed = vi.fn(async () => undefined);
    const outcome = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, typed, { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toEqual({ answered: false, reason: 'input-lock-timeout' });
    expect(typed).not.toHaveBeenCalled();
    send.resolve();
    await a;
  });

  it('a session replaced while the answer waited: refused untyped', async () => {
    const send = deferred();
    const a = withInstanceInputLock(S, () => send.promise).catch(() => undefined);
    const typed = vi.fn(async () => undefined);
    const outcome = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, typed);
    await flush();
    invalidateInstanceInput(S);
    await expect(outcome).resolves.toEqual({ answered: false, reason: 'session-replaced' });
    expect(typed).not.toHaveBeenCalled();
    send.resolve();
    await a;
  });

  it('a session replaced while an answer holds it revokes the answer’s ticket', async () => {
    const gate = deferred();
    let ticket: InstanceInputTicket | null = null;
    const outcome = answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async (t) => {
      ticket = t;
      await gate.promise;
      return t.isCurrent();
    });
    await flush();
    expect(ticket!.isCurrent()).toBe(true);
    expect(ticket!.mode).toBe('shared');
    invalidateInstanceInput(S);
    gate.resolve();
    await expect(outcome).resolves.toEqual({ answered: true, value: false });
  });

  it('errors thrown by the answer itself propagate (it was admitted and may have typed)', async () => {
    const failure = Object.assign(new Error('tmux send-keys failed'), { code: 'INSTANCE_INPUT_LOCK_TIMEOUT' });
    await expect(
      answerUnderInstanceInputLock(S, instanceInputReadMark(), async () => true, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});
