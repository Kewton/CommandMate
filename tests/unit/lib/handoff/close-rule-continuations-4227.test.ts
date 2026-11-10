/**
 * The store's continuations carry their own sending and opening (Issue #4227 G-PR2 pr2f, design
 * `mem-ui-4227.md` §4.1.1; PM decision in `pm-return-4227-pr2e-codex.md`).
 *
 * Table: an old continuation (a settle, a drop, a close, a hide, a patch) × a new sending / a new
 * opening → nothing changes. Negative controls: the same call on its own sending / opening applies.
 * The identities are required by the types (`SentHandoffDecide`, `HandoffOpeningToken`): the store
 * has no settle, close nor patch without them, so this table is the whole of their behaviour.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  beginHandoffOpening,
  closeHandoffOpening,
  dropHandoffUnit,
  handoffStoreSnapshot,
  handoffUnitsOf,
  noteHandoffHidden,
  patchHandoffOpening,
  resetHandoffStoreForTests,
  settleHandoffDecide,
  startHandoffDecide,
  type HandoffDecideUnit,
} from '@/lib/handoff/close-rule';

const A = 'wt-a';
const TARGET = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const unit = (ifVersion: number): HandoffDecideUnit => ({ worktreeId: A, requestId: 'r1', ifVersion, decisions: [] });

afterEach(() => resetHandoffStoreForTests());

describe('[#4227 pr2f] a sending’s settle and drop name it', () => {
  it('an old sending’s settle (its finally) × the next sending in flight: the next stays in flight, nothing pending', () => {
    const first = startHandoffDecide(unit(3))!;
    settleHandoffDecide(first, 'answered');
    const next = startHandoffDecide(unit(3))!;
    settleHandoffDecide(first, 'unknown');
    expect(handoffUnitsOf(A).inflight).toBe(next);
    expect(handoffUnitsOf(A).pending).toBeNull();
  });

  it('a pending sent again is a new sending: the first sending’s late settle leaves it', () => {
    const first = startHandoffDecide(unit(3))!;
    settleHandoffDecide(first, 'unknown');
    const again = startHandoffDecide(handoffUnitsOf(A).pending!)!;
    expect(again).not.toBe(first);
    settleHandoffDecide(first, 'answered');
    expect(handoffUnitsOf(A).inflight).toBe(again);
    expect(handoffUnitsOf(A).pending).toBe(first);
  });

  it('a drop of another sending than the pending one: the pending stays', () => {
    const first = startHandoffDecide(unit(3))!;
    settleHandoffDecide(first, 'unknown');
    dropHandoffUnit({ ...first });
    expect(handoffUnitsOf(A).pending).toBe(first);
  });

  it('(negative control) a sending settled and dropped on its own: unknown keeps it, the drop clears it', () => {
    const first = startHandoffDecide(unit(3))!;
    expect(startHandoffDecide(unit(3))).toBeNull();
    settleHandoffDecide(first, 'unknown');
    expect(handoffUnitsOf(A)).toMatchObject({ inflight: null, pending: first });
    dropHandoffUnit(first);
    expect(handoffUnitsOf(A).pending).toBeNull();
    const second = startHandoffDecide(unit(5))!;
    settleHandoffDecide(second, 'answered');
    expect(handoffUnitsOf(A)).toMatchObject({ inflight: null, pending: null });
  });
});

describe('[#4227 pr2f] a close, a hide and a patch name their opening', () => {
  it('an old opening’s close × a new opening: stale, the new one stays open, the rule is not asked', () => {
    const old = beginHandoffOpening(A, TARGET);
    const current = beginHandoffOpening('wt-b', TARGET);
    // Something held on the new opening's worktree: had the old close asked the rule, it would refuse.
    startHandoffDecide({ ...unit(3), worktreeId: 'wt-b' });
    expect(closeHandoffOpening(old.token, 'cancel-answer')).toBe('stale');
    expect(handoffStoreSnapshot().opening).toBe(current);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('an old opening’s hide × a new opening: the new one stays open', () => {
    const old = beginHandoffOpening(A, TARGET);
    beginHandoffOpening(A, TARGET);
    noteHandoffHidden(old.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('an old opening’s patch (the create’s answer) × a new opening: the new one is not written', () => {
    const old = beginHandoffOpening(A, TARGET);
    const current = beginHandoffOpening(A, TARGET);
    patchHandoffOpening(old.token, { created: 'done', text: 'old text' });
    expect(handoffStoreSnapshot().opening).toBe(current);
    expect(handoffStoreSnapshot().opening?.text).toBeNull();
  });

  it('(negative control) on its own opening: the close asks the rule and closes, the hide closes, the patch writes', () => {
    const own = beginHandoffOpening(A, TARGET);
    patchHandoffOpening(own.token, { text: 'its text' });
    expect(handoffStoreSnapshot().opening?.text).toBe('its text');
    const sending = startHandoffDecide(unit(3))!;
    expect(closeHandoffOpening(own.token, 'person')).toBe('unknown');
    settleHandoffDecide(sending, 'answered');
    expect(closeHandoffOpening(own.token, 'person')).toBeNull();
    expect(handoffStoreSnapshot().opening?.closed).toBe(true);
    const next = beginHandoffOpening(A, TARGET);
    noteHandoffHidden(next.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(true);
  });
});
