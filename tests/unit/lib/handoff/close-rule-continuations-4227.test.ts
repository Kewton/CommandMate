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
  dropMemItemsUnit,
  handoffStoreSnapshot,
  handoffUnitsOf,
  memItemsUnitsOf,
  noteHandoffHidden,
  patchHandoffOpening,
  resetHandoffStoreForTests,
  settleHandoffDecide,
  settleMemItemsWrite,
  startHandoffDecide,
  startMemItemsWrite,
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

/**
 * pr3c (review A P3-4): the store alone keeps the items units' rule (4)(e) and their identities —
 * not only the screens' own locks in front of it. Each row fails when its check in the store is
 * taken away (G2: the start not reading the hand-off's lock; G5: the settle not naming its sending;
 * G3: the drop not naming its unit).
 */
describe('[#4227 pr3c] the items units in the store', () => {
  const items = (slot: string) => ({ worktreeId: A, slot, request: { slot } });

  it('G2: a decide of the hand-off unknown → an items write is not started; (negative) none → started', () => {
    const decide = startHandoffDecide(unit(1))!;
    settleHandoffDecide(decide, 'unknown');
    expect(startMemItemsWrite(items('add'))).toBeNull();
    expect(memItemsUnitsOf(A).sending).toBeNull();
    dropHandoffUnit(decide);
    expect(startMemItemsWrite(items('add'))).not.toBeNull();
  });

  it('G2: a decide being sent → an items write is not started', () => {
    startHandoffDecide(unit(1));
    expect(startMemItemsWrite(items('add'))).toBeNull();
  });

  it('G5: an old sending’s settle × the next sending in flight: the next stays, nothing kept unknown', () => {
    const first = startMemItemsWrite(items('add'))!;
    settleMemItemsWrite(first, 'answered');
    const next = startMemItemsWrite(items('add'))!;
    settleMemItemsWrite(first, 'unknown');
    expect(memItemsUnitsOf(A).sending).toBe(next);
    expect(memItemsUnitsOf(A).unknown).toEqual({});
    // Negative control: its own settle applies.
    settleMemItemsWrite(next, 'unknown');
    expect(memItemsUnitsOf(A).sending).toBeNull();
    expect(memItemsUnitsOf(A).unknown.add).toBe(next);
  });

  it('G3: a drop of an older unit of the slot leaves the newer unknown one', () => {
    const older = startMemItemsWrite(items('close:n1'))!;
    settleMemItemsWrite(older, 'unknown');
    const newer = startMemItemsWrite(items('close:n1'))!;
    settleMemItemsWrite(newer, 'unknown');
    expect(memItemsUnitsOf(A).unknown['close:n1']).toBe(newer);
    dropMemItemsUnit(older);
    expect(memItemsUnitsOf(A).unknown['close:n1']).toBe(newer);
    // Negative control: the unit shown is dropped.
    dropMemItemsUnit(newer);
    expect(memItemsUnitsOf(A).unknown).toEqual({});
  });
});
