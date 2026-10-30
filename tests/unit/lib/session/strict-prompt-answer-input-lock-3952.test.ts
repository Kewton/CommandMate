/**
 * Issue #3952: the strict `respond` runs as a `shared` writer of the session's
 * input (`answerStrictlyAsInputWriter`), from its first read to its last key.
 *
 * - It waits for a send that holds the composer; its own first read is then
 *   taken after the send, so the strict checks judge the screen as it is.
 * - A send waits for a strict answer in progress.
 * - A lock that does not admit it is a refusal with nothing run (the route
 *   answers 409, which the CLI reads as exit 40, `session_conflict`).
 * - A key is not sent once the session was replaced under the answer.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const sendSessionAnswerKey = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(),
  readSessionPaneCommand: vi.fn(),
  sendSessionAnswerKey,
}));

import {
  answerStrictlyAsInputWriter,
  createStrictRespondDeps,
} from '@/lib/session/strict-prompt-answer-io';
import {
  INSTANCE_INPUT_LOCK_WAIT_MS,
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';

const SESSION = 'mcbd-antigravity-wt-3952-strict';
const TARGET = {
  worktreeId: 'wt-3952-strict',
  cliToolId: 'antigravity' as const,
  instanceId: undefined,
  sessionName: SESSION,
  resolvedBy: null,
};

const RESULT = { strictRespond: 1, code: 0 } as unknown as StrictRespondResult;

function holdSend(events: string[]): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = withInstanceInputLock(SESSION, async () => {
    events.push('<send>');
    await new Promise<void>((resolve) => (release = resolve));
  });
  return { release: () => release(), done };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetInstanceInputLocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('[#3952] strict respond as a writer of the session input', () => {
  it('waits for a send in progress: its first read comes after the send', async () => {
    const events: string[] = [];
    const held = holdSend(events);
    const answering = answerStrictlyAsInputWriter(SESSION, async () => {
      events.push('strict:read');
      return RESULT;
    });
    await flush();
    expect(events).toEqual(['<send>']);
    held.release();
    await held.done;
    await expect(answering).resolves.toBe(RESULT);
    expect(events).toEqual(['<send>', 'strict:read']);
  });

  it('a send waits for a strict answer in progress', async () => {
    const events: string[] = [];
    let finish!: () => void;
    const answering = answerStrictlyAsInputWriter(SESSION, async () => {
      events.push('strict:start');
      await new Promise<void>((resolve) => (finish = resolve));
      events.push('strict:end');
      return RESULT;
    });
    await flush();
    const send = withInstanceInputLock(SESSION, async () => {
      events.push('<send>');
    });
    await flush();
    expect(events).toEqual(['strict:start']);
    finish();
    await answering;
    await send;
    expect(events).toEqual(['strict:start', 'strict:end', '<send>']);
  });

  it('not admitted within the wait: a refusal, nothing run', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const held = holdSend(events);
    const run = vi.fn(async () => RESULT);
    const answering = answerStrictlyAsInputWriter(SESSION, run);
    await vi.advanceTimersByTimeAsync(INSTANCE_INPUT_LOCK_WAIT_MS);
    await expect(answering).resolves.toMatchObject({ refused: 'input_lock_timeout' });
    expect(run).not.toHaveBeenCalled();
    held.release();
    await held.done;
  });

  it('negative: another instance’s send is not waited for', async () => {
    const other = withInstanceInputLock(`${SESSION}-2`, () => new Promise<void>(() => undefined));
    void other;
    await expect(answerStrictlyAsInputWriter(SESSION, async () => RESULT)).resolves.toBe(RESULT);
  });

  it('a key is not sent once the session was replaced under the answer', async () => {
    const db = {} as Database.Database;
    let afterFirstKey!: () => void;
    const firstKeySent = new Promise<void>((resolve) => (afterFirstKey = resolve));
    let resume!: () => void;
    const replaced = new Promise<void>((resolve) => (resume = resolve));
    let secondKey: unknown = null;
    const outcome = answerStrictlyAsInputWriter(SESSION, async (ticket) => {
      const deps = createStrictRespondDeps(db, TARGET, ticket);
      await deps.sendKey('Down');
      afterFirstKey();
      await replaced;
      secondKey = await deps.sendKey('Enter').then(() => 'sent', (error: unknown) => error);
      return RESULT;
    });
    await firstKeySent;
    // From outside the answer, as a relaunch's `beginAgentSession` would.
    invalidateInstanceInput(SESSION);
    resume();
    await outcome;
    expect(secondKey).toBeInstanceOf(Error);
    expect(String((secondKey as Error).message)).toMatch(/replaced/);
    expect(sendSessionAnswerKey).toHaveBeenCalledTimes(1);
    expect(sendSessionAnswerKey).toHaveBeenCalledWith('wt-3952-strict', 'antigravity', 'Down', undefined);
  });

  it('negative: deps made without a ticket send as before', async () => {
    const deps = createStrictRespondDeps({} as Database.Database, TARGET);
    await deps.sendKey('Enter');
    expect(sendSessionAnswerKey).toHaveBeenCalledTimes(1);
  });
});
