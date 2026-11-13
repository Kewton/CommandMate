/**
 * Issue #4303 (#4303-A): the strict `respond` types nothing into a pane whose
 * agent is not known to hold it.
 *
 * Two reads of PR1's `readPaneForeground` (#4300), both before any key:
 *
 * - at admission (`answerStrictlyAsInputWriter`): `shell` / `unknown` is a
 *   refusal (`agent_not_in_foreground`) — the route answers 409, which the CLI
 *   reads as exit 40 (nothing sent, may be sent again). The answer itself (its
 *   read, its token) never runs.
 * - right before each key (`createStrictRespondDeps().sendKey`): closes the
 *   window of the strict read in between, and the waits between keys. Refused,
 *   that key is not sent.
 *
 * Positive control: with the agent in the foreground (`other`) the answer runs
 * and its keys reach the pane.
 *
 * Review P2: a reader that throws has not shown who holds the pane — refused
 * as `unknown` (the first version let it go on; `throws` moved from the
 * positive control to the refusals). A key refused after keys went out leaves
 * the answer's count at the keys actually sent (`strict-respond` counts the
 * refused one as possibly sent). The route end to end:
 * `tests/unit/api/prompt-response-strict-foreground-4303.test.ts`.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  foreground: 'other' as 'shell' | 'other' | 'unknown' | 'throws',
}));

const sendSessionAnswerKey = vi.hoisted(() =>
  vi.fn(async (_worktreeId: string, _cliToolId: string, _key: string, _instanceId?: string) => undefined)
);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(),
  readSessionPaneCommand: vi.fn(),
  sendSessionAnswerKey,
}));

vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  readPaneForeground: vi.fn(async () => {
    if (h.foreground === 'throws') throw new Error('reader failed (test)');
    return h.foreground;
  }),
}));

import type Database from 'better-sqlite3';
import { answerStrictlyAsInputWriter, createStrictRespondDeps } from '@/lib/session/strict-prompt-answer-io';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { readPaneForeground } from '@/lib/tmux/tmux';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';

const SESSION = 'mcbd-antigravity-wt-4303-strict';
const TARGET = {
  worktreeId: 'wt-4303-strict',
  cliToolId: 'antigravity' as const,
  instanceId: undefined,
  sessionName: SESSION,
  resolvedBy: null,
};
const RESULT = { strictRespond: 1, code: 0 } as unknown as StrictRespondResult;
const DB = null as unknown as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  resetInstanceInputLocks();
  h.foreground = 'other';
});

describe('[#4303] strict respond: refused at admission unless the agent holds the pane', () => {
  it.each(['shell', 'unknown', 'throws'] as const)(
    '%s: nothing runs, no key, refusal agent_not_in_foreground',
    async (foreground) => {
      h.foreground = foreground;
      const answer = vi.fn(async () => RESULT);
      const result = await answerStrictlyAsInputWriter(SESSION, answer);

      expect(result).toEqual({ refused: 'agent_not_in_foreground', message: expect.stringContaining('Nothing was sent') });
      expect(answer).not.toHaveBeenCalled();
      expect(sendSessionAnswerKey).not.toHaveBeenCalled();
      expect(readPaneForeground).toHaveBeenCalledWith(SESSION);
    }
  );

  it.each(['other'] as const)('positive control: %s — the answer runs', async (foreground) => {
    h.foreground = foreground;
    const answer = vi.fn(async () => RESULT);
    await expect(answerStrictlyAsInputWriter(SESSION, answer)).resolves.toBe(RESULT);
    expect(answer).toHaveBeenCalledTimes(1);
  });
});

describe('[#4303] strict respond: each key is gated too', () => {
  it.each(['shell', 'unknown'] as const)('%s: the first key is not sent', async (foreground) => {
    h.foreground = foreground;
    const deps = createStrictRespondDeps(DB, TARGET);
    await expect(deps.sendKey('Down')).rejects.toThrow(/no key was sent \(Issue #4303\)/);
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
  });

  it('positive control: other — every key reaches the pane, the foreground read before each', async () => {
    const deps = createStrictRespondDeps(DB, TARGET);
    await deps.sendKey('Down');
    await deps.sendKey('Enter');
    expect(vi.mocked(sendSessionAnswerKey).mock.calls).toEqual([
      ['wt-4303-strict', 'antigravity', 'Down', undefined],
      ['wt-4303-strict', 'antigravity', 'Enter', undefined],
    ]);
    expect(readPaneForeground).toHaveBeenCalledTimes(2);
  });

  it('an arrow sent, then the agent gone: the Enter is not left for the shell', async () => {
    const deps = createStrictRespondDeps(DB, TARGET);
    await deps.sendKey('Down');
    h.foreground = 'shell';
    await expect(deps.sendKey('Enter')).rejects.toThrow(/no key was sent/);
    expect(vi.mocked(sendSessionAnswerKey).mock.calls.map((call) => call[2])).toEqual(['Down']);
  });
});

describe('[#4303 review P2] a key refused after keys went out: the count is the keys actually sent', () => {
  it('Down sent, then the shell: the gate says 1 key, and the result is settled to 1', async () => {
    // What strict-respond returns for a throw of sendKey: the refused key counted.
    const counted = { strictRespond: 1, code: 41, keysSent: 2, replayed: false } as unknown as StrictRespondResult;
    const result = await answerStrictlyAsInputWriter(SESSION, async (ticket, gate) => {
      const deps = createStrictRespondDeps(DB, TARGET, ticket, gate);
      await deps.sendKey('Down');
      h.foreground = 'shell';
      await expect(deps.sendKey('Enter')).rejects.toThrow(/no key was sent/);
      expect(gate).toEqual({ refusedBeforeKey: { refused: 'agent_not_in_foreground', foreground: 'shell' }, keysSent: 1 });
      return counted;
    });
    expect(result).toMatchObject({ code: 41, keysSent: 1 });
    expect(vi.mocked(sendSessionAnswerKey).mock.calls.map((call) => call[2])).toEqual(['Down']);
  });

  it('the first key refused with none sent: a refusal, not a result (nothing sent)', async () => {
    const counted = { strictRespond: 1, code: 41, keysSent: 1, replayed: false } as unknown as StrictRespondResult;
    const result = await answerStrictlyAsInputWriter(SESSION, async (ticket, gate) => {
      const deps = createStrictRespondDeps(DB, TARGET, ticket, gate);
      h.foreground = 'unknown';
      await expect(deps.sendKey('Enter')).rejects.toThrow(/no key was sent/);
      return counted;
    });
    expect(result).toEqual({ refused: 'agent_not_in_foreground', message: expect.stringContaining('Nothing was sent') });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
  });

  it('negative control: no refusal — the result as strict-respond gave it', async () => {
    const result = await answerStrictlyAsInputWriter(SESSION, async (ticket, gate) => {
      const deps = createStrictRespondDeps(DB, TARGET, ticket, gate);
      await deps.sendKey('Enter');
      expect(gate).toEqual({ refusedBeforeKey: null, keysSent: 1 });
      return RESULT;
    });
    expect(result).toBe(RESULT);
  });
});
