/**
 * The decide's fence keeps a confirmation to the conversation it was asked in (Issue #4227
 * pr2c, review A P3-1; design `mem-ui-4227.md` §0.1 G6・§4.5, H4(b)・H13(d) for the shape).
 *
 * A new D1 boundary (the same instance restarted, the roster unchanged) opened during the
 * confirmation's await: mem's own checks (the worktree's incarnation, the instance's
 * lifetime) do not see the boundary's id, so it is the fence's `sameConversation` that
 * refuses — `fenced`, nothing written, the proposal `expired`. The positive control drops
 * that one call in the fence (the module's own judgement left as it is) and the item is
 * written; the negative control opens no boundary and it is written.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

/** The positive control's mutation: the decide's fence reads every conversation as the same. */
const fenceMutation = { sameAlways: false };
vi.mock('@/lib/handoff/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/common')>();
  return {
    ...actual,
    sameConversation: (...args: Parameters<typeof actual.sameConversation>) => (fenceMutation.sameAlways ? true : actual.sameConversation(...args)),
  };
});

import { getHandoffProposal, getHandoffRequest } from '@/lib/db/handoff-db';
import { getMemRecord } from '@/lib/db/mem-db';
import { handoffRead } from '@/lib/handoff/request';
import { handoffDecide } from '@/lib/handoff/decide';
import type { HandoffDecideResponse, HandoffReadResponse } from '@/lib/handoff/types';
import { makeHandoffWorld, screenRequest, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;

beforeEach(() => {
  w = makeHandoffWorld('handoff-fence-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => {
  fenceMutation.sameAlways = false;
  w.close();
});

/** A decide's start observes the worktree twice; its write's await is the next one. */
const WRITE_OBSERVATION = 2;

async function decideWithBoundaryDuringAwait(openBoundary: boolean) {
  const note = await w.addNote('before the restart');
  const created = await w.create();
  const rid = created.request.id;
  const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'written after a restart?' });
  await w.done(rid);
  const ifVersion = (handoffRead(w.db, WT, rid, w.deps()).body as HandoffReadResponse).request.version;
  const hold = w.arm(WRITE_OBSERVATION);
  const pending = handoffDecide(
    w.db,
    screenRequest(),
    WT,
    rid,
    { ifVersion, decisions: [{ proposalId: proposal.id, fingerprint: proposal.fingerprint, action: 'approve' }] },
    w.deps()
  );
  await hold.reached;
  // Held inside the write's await: the decide's start already passed.
  expect(getHandoffRequest(w.db, rid)!.state).toBe('applying');
  if (openBoundary) w.openLaunch();
  hold.release();
  const outcome = await pending;
  return { outcome, note, proposal, rid };
}

describe('[#4227] A P3-1: the decide’s fence refuses a confirmation whose conversation changed during its await', () => {
  it('a new boundary during the confirmation’s await → fenced, nothing written, the proposal expired(session_changed)', async () => {
    const { outcome, note, proposal, rid } = await decideWithBoundaryDuringAwait(true);
    expect(outcome.status).toBe(200);
    expect((outcome.body as HandoffDecideResponse).results).toEqual([{ proposalId: proposal.id, result: 'expired', code: 'session_changed' }]);
    expect(getMemRecord(w.db, note.id)!.text).toBe('before the restart');
    expect(getHandoffProposal(w.db, proposal.id)!.state).toBe('expired');
    expect(getHandoffRequest(w.db, rid)).toMatchObject({ state: 'expired', outcomeReason: 'session_changed' });
  });

  it('(positive control) without `sameConversation` in the fence, the same race writes the item', async () => {
    fenceMutation.sameAlways = true;
    const { outcome, note, proposal } = await decideWithBoundaryDuringAwait(true);
    expect((outcome.body as HandoffDecideResponse).results).toEqual([{ proposalId: proposal.id, result: 'applied' }]);
    expect(getMemRecord(w.db, note.id)!.text).toBe('written after a restart?');
  });

  it('(negative control) no new boundary → the approved proposal is written', async () => {
    const { outcome, note, proposal } = await decideWithBoundaryDuringAwait(false);
    expect((outcome.body as HandoffDecideResponse).results).toEqual([{ proposalId: proposal.id, result: 'applied' }]);
    expect(getMemRecord(w.db, note.id)!.text).toBe('written after a restart?');
  });
});
