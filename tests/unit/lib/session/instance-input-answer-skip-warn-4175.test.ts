/**
 * Issue #4175 (2): `answerUnderInstanceInputLock`'s warns for a declined answer
 * (`instance-input-answer-not-admitted`, `instance-input-answer-recheck-failed`)
 * are written once while the same reason goes on for the session, and again after
 * an answer went through, another reason, or a new process for the session. An
 * answer that started before the session was replaced neither reads nor writes
 * the new process's record.
 *
 * The real lock; no tmux.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => log,
}));

import {
  ANSWER_SKIP_RECORD_MAX,
  answerUnderInstanceInputLock,
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InstanceInputAnswerOutcome,
} from '@/lib/session/instance-input-lock';

const S = 'mcbd-codex-wt-4175';
const OTHER = 'mcbd-codex-wt-4175-codex-2';
/** A read mark no current mark equals: the screen is read again under the lock. */
const STALE = -1;

const NOT_ADMITTED = 'instance-input-answer-not-admitted';
const RECHECK = 'instance-input-answer-recheck-failed';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const warned = (event: string, session = S): unknown[][] =>
  log.warn.mock.calls.filter((call) => call[0] === event && (call[1] as { sessionName: string }).sessionName === session);
const debugged = (event: string): unknown[][] => log.debug.mock.calls.filter((call) => call[0] === event);

/** One launch wait's scope; a new one per test. */
let WAIT: object = {};

const recheckFails = (session = S, scope: object | null = WAIT): Promise<InstanceInputAnswerOutcome<string>> =>
  answerUnderInstanceInputLock(session, STALE, async () => {
    throw new Error('capture failed');
  }, async () => 'typed', { repeatScope: scope ?? undefined });
const targetChanged = (session = S, scope: object | null = WAIT): Promise<InstanceInputAnswerOutcome<string>> =>
  answerUnderInstanceInputLock(session, STALE, async () => false, async () => 'typed', { repeatScope: scope ?? undefined });
const goesThrough = (session = S, scope: object | null = WAIT): Promise<InstanceInputAnswerOutcome<string>> =>
  answerUnderInstanceInputLock(session, STALE, async () => true, async () => 'typed', { repeatScope: scope ?? undefined });

/** An answer that waits behind a send past its (short) wait. */
async function timesOut(session = S, scope: object | null = WAIT): Promise<InstanceInputAnswerOutcome<string>> {
  const send = deferred();
  const held = withInstanceInputLock(session, () => send.promise);
  const outcome = answerUnderInstanceInputLock(session, STALE, async () => true, async () => 'typed', {
    waitMs: 5,
    repeatScope: scope ?? undefined,
  });
  await vi.advanceTimersByTimeAsync(10);
  send.resolve();
  await held;
  return outcome;
}

const lives = (): Map<string, number> | undefined => globalThis.__instanceInputAnswerSkipLives?.bySession;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetInstanceInputLocks();
  WAIT = {};
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('once while the same reason goes on', () => {
  it('recheck-failed three times in a row: one warn, then debug', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(recheckFails()).resolves.toEqual({ answered: false, reason: 'recheck-failed' });
    }
    expect(warned(RECHECK)).toHaveLength(1);
    expect((warned(RECHECK)[0][1] as { error: string }).error).toBe('capture failed');
    expect(debugged(RECHECK)).toHaveLength(2);
  });

  it('input-lock-timeout twice in a row: one warn, with its reason', async () => {
    await expect(timesOut()).resolves.toEqual({ answered: false, reason: 'input-lock-timeout' });
    await expect(timesOut()).resolves.toEqual({ answered: false, reason: 'input-lock-timeout' });
    expect(warned(NOT_ADMITTED).map((call) => (call[1] as { reason: string }).reason)).toEqual(['input-lock-timeout']);
  });

  it('A, B, A: each change of reason is a warn', async () => {
    await recheckFails();
    await timesOut();
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(2);
    expect(warned(NOT_ADMITTED)).toHaveLength(1);
  });

  it('a decline after an answer that went through is a warn again, for the same reason', async () => {
    await recheckFails();
    await expect(goesThrough()).resolves.toEqual({ answered: true, value: 'typed' });
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('target-changed (an info) ends the streak too', async () => {
    await recheckFails();
    await targetChanged();
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(2);
    expect(log.info.mock.calls.filter((call) => call[0] === 'instance-input-answer-target-changed')).toHaveLength(1);
  });

  it('another session has its own record', async () => {
    await recheckFails(S);
    await recheckFails(OTHER);
    await recheckFails(S);
    expect(warned(RECHECK, S)).toHaveLength(1);
    expect(warned(RECHECK, OTHER)).toHaveLength(1);
  });

  it('an answer of another kind at the same session (Auto-Yes, no scope) is a warn of its own', async () => {
    // Positive: the launch wait's streak must not hold back the warn of an answer
    // whose own record of a decline is an info.
    await recheckFails();
    await answerUnderInstanceInputLock(S, STALE, async () => {
      throw new Error('auto-yes recheck');
    }, async () => 'typed');
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('an answer with no scope: every decline is a warn, as before', async () => {
    await recheckFails(S, null);
    await recheckFails(S, null);
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('another wait at the same session has its own streak', async () => {
    await recheckFails(S, WAIT);
    await recheckFails(S, {});
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('the same wait, the same reason, after another kind of answer declined: still a debug', async () => {
    await recheckFails();
    await recheckFails(S, null);
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(2); // the launch's first and the unscoped one
    expect(debugged(RECHECK)).toHaveLength(1);
  });
});

describe('a new process for the session', () => {
  it('its first decline is a warn, even for the reason the old one was declined for', async () => {
    await recheckFails();
    invalidateInstanceInput(S);
    await recheckFails();
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('a decline of the old process, finishing after the new one began, is written and leaves the new record alone', async () => {
    const reading = deferred<boolean>();
    let readCalled = false;
    const old = answerUnderInstanceInputLock(
      S,
      STALE,
      async () => {
        readCalled = true;
        await reading.promise;
        throw new Error('old pane gone');
      },
      async () => 'typed'
    );
    await flush();
    expect(readCalled).toBe(true);
    invalidateInstanceInput(S); // the session is recreated under the same name
    await recheckFails(); // the new process's first decline: a warn, recorded
    expect(warned(RECHECK)).toHaveLength(1);
    reading.resolve(true);
    await expect(old).resolves.toEqual({ answered: false, reason: 'recheck-failed' });
    expect(warned(RECHECK)).toHaveLength(2); // the old one is not held back by the new record
    await recheckFails(); // and did not disturb it: still the new streak
    expect(warned(RECHECK)).toHaveLength(2);
  });

  it('an answer of the old process that went through late does not end the new streak', async () => {
    const typing = deferred<string>();
    const old = answerUnderInstanceInputLock(S, STALE, async () => true, () => typing.promise);
    await flush();
    invalidateInstanceInput(S);
    await recheckFails();
    typing.resolve('typed');
    await expect(old).resolves.toEqual({ answered: true, value: 'typed' });
    await recheckFails();
    expect(warned(RECHECK)).toHaveLength(1);
  });

  it('an answer waiting when the session was replaced: its session-replaced is a warn', async () => {
    const send = deferred();
    const held = withInstanceInputLock(S, () => send.promise);
    const waiting = answerUnderInstanceInputLock(S, STALE, async () => true, async () => 'typed');
    await flush();
    invalidateInstanceInput(S);
    await expect(waiting).resolves.toEqual({ answered: false, reason: 'session-replaced' });
    send.resolve();
    await held;
    expect(warned(NOT_ADMITTED).map((call) => (call[1] as { reason: string }).reason)).toEqual(['session-replaced']);
  });
});

describe('bounded', () => {
  it(`keeps the lives of at most ${ANSWER_SKIP_RECORD_MAX} sessions`, async () => {
    for (let i = 0; i < ANSWER_SKIP_RECORD_MAX + 20; i++) invalidateInstanceInput(`mcbd-codex-wt-4175-${i}`);
    expect(lives()?.size).toBe(ANSWER_SKIP_RECORD_MAX);
  });

  it('answers alone leave no life behind', async () => {
    await recheckFails();
    await goesThrough();
    await goesThrough(OTHER, null);
    expect(lives()?.size).toBe(0);
  });

  it('an old answer of a life that was dropped is not taken for the new one', async () => {
    // Positive: life 0 read again later -> recreated -> 256 others push it out ->
    // the old read declines. Before, the old answer matched "no life = 0" again and
    // wrote the new process's record, which held back its first warn.
    const reading = deferred<boolean>();
    let readCalled = false;
    const old = answerUnderInstanceInputLock(
      S,
      STALE,
      async () => {
        readCalled = true;
        await reading.promise;
        throw new Error('old pane gone');
      },
      async () => 'typed',
      { repeatScope: WAIT }
    );
    await flush();
    expect(readCalled).toBe(true);
    invalidateInstanceInput(S);
    for (let i = 0; i < ANSWER_SKIP_RECORD_MAX; i++) invalidateInstanceInput(`mcbd-codex-wt-4175-${i}`);
    expect(lives()?.has(S) ?? false).toBe(false);
    reading.resolve(true);
    await expect(old).resolves.toEqual({ answered: false, reason: 'recheck-failed' });
    expect(warned(RECHECK)).toHaveLength(1);
    await recheckFails(); // the new process's first decline, in the same wait
    expect(warned(RECHECK)).toHaveLength(2);
    await recheckFails(); // and its streak is kept from here on
    expect(warned(RECHECK)).toHaveLength(2);
  });
});
