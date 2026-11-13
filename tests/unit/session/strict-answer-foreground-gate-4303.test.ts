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
 * and its keys reach the pane. A reader that throws (never the real one; a
 * tmux double that predates it) is no reading and goes on.
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
  it.each(['shell', 'unknown'] as const)(
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

  it.each(['other', 'throws'] as const)('positive control: %s — the answer runs', async (foreground) => {
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
