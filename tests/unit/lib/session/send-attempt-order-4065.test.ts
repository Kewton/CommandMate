/**
 * Issue #4065: which record is an instance's `lastSend`, at the record itself.
 *
 * Three kinds of record — granted (`inputGeneration` g), refused before any
 * grant (`observedGeneration` o) and excluded (neither) — are compared with the
 * instance's highest granted generation (maxG), which no record, demotion or
 * exclusion lowers.
 *
 * Nothing here touches the repository's files: the records live in process
 * memory and are cleared around every test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

import {
  clearSendAttempts,
  forgetSendAttemptsForWorktree,
  getLastSendAttempt,
  markLastSendDiscarded,
  recordSendAttempt,
  sendMessageDigest,
} from '@/lib/session/send-attempt-state';

const A = { worktreeId: 'wt-4065', cliToolId: 'claude', instanceId: 'claude' };
const B = { worktreeId: 'wt-4065', cliToolId: 'claude', instanceId: 'claude-2' };

const granted = (content: string, g: number, state: 'sent' | 'indeterminate' | 'not-sent' = 'sent') =>
  ({ state, reason: state === 'sent' ? 'submitted' : 'send-error', content, inputGeneration: g }) as const;
const refused = (content: string, o: number) =>
  ({ state: 'not-sent', reason: 'prompt-waiting', content, observedGeneration: o }) as const;
const excluded = (content: string) => ({ state: 'sent', reason: 'submitted', content }) as const;

const digestOf = (instance: typeof A): string | undefined => getLastSendAttempt(instance)?.messageDigest;

beforeEach(() => clearSendAttempts());
afterEach(() => clearSendAttempts());

describe('[#4065] maxG is kept beside the published record', () => {
  it('positive: G2 recorded, then a refusal N (o ≥ g2), then G1 late — lastSend stays N, G1 does not come back', () => {
    expect(recordSendAttempt(A, granted('G2', 2))).toBe(true);
    expect(recordSendAttempt(A, refused('N', 2))).toBe(true);
    expect(recordSendAttempt(A, granted('G1', 1, 'indeterminate'))).toBe(false);

    expect(digestOf(A)).toBe(sendMessageDigest('N'));
  });

  it('positive: an excluded record in between does not forget maxG either', () => {
    recordSendAttempt(A, granted('G2', 2));
    expect(recordSendAttempt(A, excluded('HTTP'))).toBe(true);
    expect(recordSendAttempt(A, granted('G1', 1, 'indeterminate'))).toBe(false);

    expect(digestOf(A)).toBe(sendMessageDigest('HTTP'));
  });

  it('negative: a newer grant G3 is taken after them', () => {
    recordSendAttempt(A, granted('G2', 2));
    recordSendAttempt(A, refused('N', 2));
    expect(recordSendAttempt(A, granted('G3', 3))).toBe(true);

    expect(digestOf(A)).toBe(sendMessageDigest('G3'));
    // And G2 is now older than maxG.
    expect(recordSendAttempt(A, granted('G2 again', 2))).toBe(false);
  });

  it('negative: an equal generation (the same grant told again) is taken', () => {
    recordSendAttempt(A, granted('G2', 2, 'not-sent'));
    expect(recordSendAttempt(A, granted('G2 retry', 2))).toBe(true);
  });
});

describe('[#4065] a refusal is compared with maxG only', () => {
  it('positive: a refusal observed before a recorded grant (maxG > o) is dropped', () => {
    recordSendAttempt(A, granted('R2', 5));
    expect(recordSendAttempt(A, refused('R1', 4))).toBe(false);

    expect(getLastSendAttempt(A)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
  });

  it('negative: a refusal observed at or after the grant (maxG ≤ o) is taken', () => {
    recordSendAttempt(A, granted('R2', 5));
    expect(recordSendAttempt(A, refused('R3', 5))).toBe(true);
    expect(getLastSendAttempt(A)).toMatchObject({ state: 'not-sent', reason: 'prompt-waiting' });
  });

  it('negative: refusals are not ranked against one another (no maxG: each is taken as it comes)', () => {
    expect(recordSendAttempt(A, refused('later observed', 9))).toBe(true);
    expect(recordSendAttempt(A, refused('earlier observed', 3))).toBe(true);
    expect(digestOf(A)).toBe(sendMessageDigest('earlier observed'));
  });

  it('o = 0 is a value: taken with no maxG, dropped once a grant is recorded', () => {
    expect(recordSendAttempt(A, refused('zero', 0))).toBe(true);
    recordSendAttempt(A, granted('G1', 1));
    expect(recordSendAttempt(A, refused('zero again', 0))).toBe(false);
  });

  it('another instance\'s grant does not rank this instance\'s refusal', () => {
    recordSendAttempt(B, granted('B sent', 7));
    expect(recordSendAttempt(A, refused('A refused', 2))).toBe(true);
    expect(digestOf(B)).toBe(sendMessageDigest('B sent'));
  });

  it('the inputGeneration wins when both are given', () => {
    recordSendAttempt(A, granted('G5', 5));
    expect(
      recordSendAttempt(A, { state: 'not-sent', reason: 'recheck-failed', content: 'x', inputGeneration: 6, observedGeneration: 1 })
    ).toBe(true);
  });
});

describe('[#4065] excluded records keep the order they finish in', () => {
  it('negative: two excluded records — the last to finish is kept', () => {
    recordSendAttempt(A, excluded('first'));
    recordSendAttempt(A, excluded('second'));
    expect(digestOf(A)).toBe(sendMessageDigest('second'));
  });

  it('an excluded record never sets maxG: an older grant after it is still taken', () => {
    recordSendAttempt(A, excluded('HTTP'));
    expect(recordSendAttempt(A, granted('G1', 1))).toBe(true);
  });
});

describe('[#4065] the demotion keeps the order', () => {
  it('positive: a demoted record keeps its generation, and an older grant is still dropped after it', () => {
    recordSendAttempt(A, granted('G2', 2));
    markLastSendDiscarded(A, Date.now(), sendMessageDigest('G2'));
    expect(getLastSendAttempt(A)).toMatchObject({ state: 'indeterminate', reason: 'found-in-composer', inputGeneration: 2 });

    expect(recordSendAttempt(A, granted('G1', 1, 'indeterminate'))).toBe(false);
    expect(getLastSendAttempt(A)).toMatchObject({ reason: 'found-in-composer' });
  });

  it('negative: a demotion aimed at another body changes nothing (same text resend, other attempt)', () => {
    recordSendAttempt(A, { ...granted('caption', 3), typedContent: 'caption\n![](/a.png)' });
    markLastSendDiscarded(A, Date.now(), sendMessageDigest('another body'));
    expect(getLastSendAttempt(A)).toMatchObject({ state: 'sent', inputGeneration: 3 });

    markLastSendDiscarded(A, Date.now(), sendMessageDigest('caption\n![](/a.png)'));
    expect(getLastSendAttempt(A)).toMatchObject({ state: 'indeterminate', inputGeneration: 3 });
  });
});

describe('[#4065] the boundaries of what is remembered', () => {
  it('a worktree ID migration drops the records and their maxG', () => {
    recordSendAttempt(A, granted('G9', 9));
    recordSendAttempt({ ...A, worktreeId: 'wt-other' }, granted('other', 1));

    forgetSendAttemptsForWorktree('wt-4065');

    expect(getLastSendAttempt(A)).toBeNull();
    expect(getLastSendAttempt({ ...A, worktreeId: 'wt-other' })).not.toBeNull();
    // maxG went with it: an older generation is a first record again.
    expect(recordSendAttempt(A, granted('G1', 1))).toBe(true);
  });

  it('the limit: an instance evicted past 1024 loses its maxG with its record', () => {
    recordSendAttempt(A, granted('G9', 9));
    for (let i = 0; i < 1024; i++) {
      recordSendAttempt({ worktreeId: `wt-fill-${i}`, cliToolId: 'claude', instanceId: 'claude' }, excluded('x'));
    }
    expect(getLastSendAttempt(A)).toBeNull();
    expect(recordSendAttempt(A, granted('G1', 1))).toBe(true);
  });

  it('the published shape carries no observed generation', () => {
    recordSendAttempt(A, refused('N', 4));
    expect(getLastSendAttempt(A)).not.toHaveProperty('observedGeneration');
    expect(getLastSendAttempt(A)).not.toHaveProperty('inputGeneration');
  });
});
