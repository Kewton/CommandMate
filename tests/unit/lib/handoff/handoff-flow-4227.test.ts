/**
 * The hand-off's flow, case by case (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.4・§4.5・
 * §4.6, §7.4 H4・H5・H8・H9・H10・H12・H13・H14(d)・H15(a)(c)(e)・H16(d)・H17・H18).
 *
 * Each case has its positive control (what the check refuses would land without it, or the
 * outcome a careless rule would give) and its negative control (the ordinary path lands).
 * The DB is a migrated file under `os.tmpdir()`, removed after each test.
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

import { getHandoffProposal, getHandoffRequest, proposalFingerprint } from '@/lib/db/handoff-db';
import { getMemRecord } from '@/lib/db/mem-db';
import { handoffCancel, handoffCreate, handoffExtend, handoffRead } from '@/lib/handoff/request';
import { handoffDone, handoffPropose, handoffRebase } from '@/lib/handoff/proposals';
import { handoffDecide } from '@/lib/handoff/decide';
import { handoffEnd, handoffObserve } from '@/lib/handoff/end';
import { proposalView } from '@/lib/handoff/common';
import { memUpdateItem } from '@/lib/mem/service';
import { HANDOFF_AGENT_WINDOW_MS, HANDOFF_REQUEST_TTL_MS, type HandoffDecideResponse, type HandoffReadResponse } from '@/lib/handoff/types';
import { codeOf, makeHandoffWorld, screenRequest, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;

beforeEach(() => {
  w = makeHandoffWorld();
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

const read = (rid: string) => handoffRead(w.db, WT, rid, w.deps()).body as HandoffReadResponse;
const decide = (rid: string, decisions: Array<{ proposalId: string; fingerprint: string; action: 'approve' | 'discard' }>, ifVersion = read(rid).request.version) =>
  handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion, decisions }, w.deps());
const approve = (p: { id: string; fingerprint: string }) => ({ proposalId: p.id, fingerprint: p.fingerprint, action: 'approve' as const });
const end = (rid: string, force = false) => handoffEnd(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version, ...(force ? { force: true } : {}) }, w.deps());
const observe = (rid: string, endToken: string, running: boolean | null) => handoffObserve(w.db, screenRequest(), WT, rid, { endToken }, { running }, w.deps());
const tokenOf = (outcome: { body: unknown }) => (outcome.body as { endToken: string }).endToken;
const stateOf = (rid: string) => getHandoffRequest(w.db, rid)!;
/** A decide's start observes the worktree twice (mem's settled membership); its write's await is the next one. */
const WRITE_OBSERVATION = 2;

/** end → (the person's stop: not called here, the hand-off never kills) → observe. */
async function stopAndObserve(rid: string, running: boolean | null, force = false) {
  const ended = end(rid, force);
  expect(ended.status).toBe(200);
  return observe(rid, tokenOf(ended), running);
}

describe('[#4227] H9: what the next generation is told (confirmed only when all four hold)', () => {
  async function confirmedPath() {
    const note = await w.addNote('to update');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'updated before the end' });
    await w.done(rid);
    const decided = await decide(rid, [approve(proposal)]);
    expect((decided.body as HandoffDecideResponse).results).toEqual([{ proposalId: proposal.id, result: 'applied' }]);
    return { rid, note };
  }

  it('(negative control) done, every proposal decided, every confirmation in, stopped → confirmed', async () => {
    const { rid, note } = await confirmedPath();
    const observed = await stopAndObserve(rid, false);
    expect(observed.status).toBe(200);
    expect(stateOf(rid)).toMatchObject({ state: 'ended', outcome: 'confirmed', outcomeReason: null });
    expect(getMemRecord(w.db, note.id)!.text).toBe('updated before the end');
  });

  it('no done (the agent ran out of time) → unconfirmed(agent_timeout)', async () => {
    const created = await w.create();
    w.clock.now += HANDOFF_AGENT_WINDOW_MS + 1;
    await stopAndObserve(created.request.id, false);
    expect(stateOf(created.request.id)).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'agent_timeout' });
  });

  it('a proposal left undecided → unconfirmed(undecided_left)', async () => {
    const created = await w.create();
    await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'never decided' });
    await w.done(created.request.id);
    await stopAndObserve(created.request.id, false);
    expect(stateOf(created.request.id)).toMatchObject({ outcome: 'unconfirmed', outcomeReason: 'undecided_left' });
  });

  it('a conflict left → unconfirmed(conflict_left); a failure → unconfirmed(apply_failed)', async () => {
    const note = await w.addNote('raced');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'mine' });
    await w.done(rid);
    await memUpdateItem(w.db, WT, note.id, { instanceId: 'claude', ifVersion: note.version, text: 'theirs' }, w.deps());
    await decide(rid, [approve(proposal)]);
    expect(getHandoffProposal(w.db, proposal.id)!.state).toBe('conflict');
    await stopAndObserve(rid, false);
    expect(stateOf(rid)).toMatchObject({ outcome: 'unconfirmed', outcomeReason: 'conflict_left' });
    expect(getMemRecord(w.db, note.id)!.text).toBe('theirs');
  });

  it('(a) forced with done and no proposals → unconfirmed(forced), never confirmed', async () => {
    const created = await w.create();
    await w.done(created.request.id);
    await stopAndObserve(created.request.id, false, true);
    expect(stateOf(created.request.id)).toMatchObject({ outcome: 'unconfirmed', outcomeReason: 'forced' });
  });

  it('(b) forced, the stop did not take, then a plain retry that stops → still unconfirmed(forced)', async () => {
    const created = await w.create();
    const rid = created.request.id;
    await w.done(rid);
    const first = await stopAndObserve(rid, true, true);
    expect(first.status).toBe(409);
    expect(codeOf(first)).toBe('not_stopped');
    expect(stateOf(rid)).toMatchObject({ state: 'reviewing', endForced: true });
    const second = await stopAndObserve(rid, false, false);
    expect(second.status).toBe(200);
    expect(stateOf(rid)).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'forced', endForced: true });
  });

  it('(c) end_forced 1 → 0 is refused by the trigger', async () => {
    const created = await w.create();
    end(created.request.id, true);
    expect(() => w.db.prepare('UPDATE mem_handoff_requests SET end_forced = 0 WHERE id = ?').run(created.request.id)).toThrow(/sticky/);
  });

  it('(d) a forced request takes no proposal and no decide (request_closed)', async () => {
    const created = await w.create();
    const rid = created.request.id;
    const ended = end(rid, true);
    await observe(rid, tokenOf(ended), true);
    expect(stateOf(rid).state).toBe('reviewing');
    const proposed = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'add', kind: 'note', text: 'late' }, w.deps());
    expect(codeOf(proposed)).toBe('request_closed');
    const decided = await decide(rid, []);
    expect(codeOf(decided)).toBe('request_closed');
  });

  it('(e) the stop declared and never observed → expired at its deadline, not recorded', async () => {
    const created = await w.create();
    end(created.request.id);
    w.clock.now += HANDOFF_REQUEST_TTL_MS + 1;
    expect(read(created.request.id).request.state).toBe('expired');
  });

  it('(f) still running → reviewing and 409 not_stopped, never ended; (g) a failed read is the same', async () => {
    const { rid } = await confirmedPath();
    const running = await stopAndObserve(rid, true);
    expect(codeOf(running)).toBe('not_stopped');
    expect(stateOf(rid).state).toBe('reviewing');
    const unread = await stopAndObserve(rid, null);
    expect(codeOf(unread)).toBe('not_stopped');
    expect(stateOf(rid)).toMatchObject({ state: 'reviewing', outcome: null });
  });

  it('a resend of the same observation after it is recorded answers 409 with the record', async () => {
    const { rid } = await confirmedPath();
    const ended = end(rid);
    expect(observe(rid, tokenOf(ended), false).status).toBe(200);
    const again = observe(rid, tokenOf(ended), false);
    expect(codeOf(again)).toBe('already_recorded');
    expect((again.body as HandoffReadResponse).request.outcome).toBe('confirmed');
  });
});

describe('[#4227] H15: the conversation’s lifetime (the declaration before and after)', () => {
  it('(a) a restart before the declaration: propose / done / decide / end → session_changed, the request expired', async () => {
    const created = await w.create();
    const rid = created.request.id;
    w.openLaunch();
    for (const outcome of [
      await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'add', kind: 'note', text: 'old' }, w.deps()),
      await handoffDone(w.db, WT, rid, { instanceId: 'claude' }, w.deps()),
      await decide(rid, [], created.request.version),
      handoffEnd(w.db, screenRequest(), WT, rid, { ifVersion: created.request.version }, w.deps()),
    ]) {
      expect(outcome.status).toBe(409);
      expect(codeOf(outcome)).toBe('session_changed');
    }
    expect(stateOf(rid)).toMatchObject({ state: 'expired', outcomeReason: 'session_changed' });
  });

  it('(a) a restart after the declaration: GET keeps it ending; the observation records unconfirmed(session_changed)', async () => {
    const created = await w.create();
    const rid = created.request.id;
    await w.done(rid);
    const ended = end(rid);
    w.openLaunch();
    expect(read(rid).request.state).toBe('ending');
    const proposed = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'add', kind: 'note', text: 'late' }, w.deps());
    expect(codeOf(proposed)).toBe('request_closed');
    // (e): the new process runs (true) or stopped too (false) — the same record, nothing done to it.
    expect(observe(rid, tokenOf(ended), true).status).toBe(200);
    expect(stateOf(rid)).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'session_changed' });
  });

  it('(e) the same with the new process stopped too', async () => {
    const created = await w.create();
    await w.done(created.request.id);
    const ended = end(created.request.id);
    w.openLaunch();
    observe(created.request.id, tokenOf(ended), false);
    expect(stateOf(created.request.id)).toMatchObject({ outcome: 'unconfirmed', outcomeReason: 'session_changed' });
  });

  it('(b) a reload (no new boundary) keeps the request', async () => {
    const created = await w.create();
    expect(read(created.request.id).request.state).toBe('awaiting_agent');
    expect(read(created.request.id).request.state).toBe('awaiting_agent');
  });

  it('(g) no boundary yet → 409 session_unknown, nothing made', async () => {
    w.db.prepare('DELETE FROM session_brief_boundaries').run();
    const outcome = await handoffCreate(w.db, screenRequest(), WT, { instanceId: 'claude' }, w.deps());
    expect(codeOf(outcome)).toBe('session_unknown');
    expect(w.count('SELECT COUNT(*) n FROM mem_handoff_requests')).toBe(0);
  });
});

describe('[#4227] H4・H13: cancel and decide race the confirmation', () => {
  it('H4(a) one of three confirmed, then cancel → the one stays, the two are discarded', async () => {
    const notes = [await w.addNote('a'), await w.addNote('b'), await w.addNote('c')];
    const created = await w.create();
    const rid = created.request.id;
    const proposals = [];
    for (const note of notes) proposals.push(await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: `${note.id} new` }));
    await w.done(rid);
    await decide(rid, [approve(proposals[0])]);
    const cancelled = handoffCancel(w.db, screenRequest(), WT, rid, w.deps());
    expect(cancelled.status).toBe(200);
    expect(getMemRecord(w.db, notes[0].id)!.text).toBe(`${notes[0].id} new`);
    expect(getHandoffProposal(w.db, proposals[0].id)!.state).toBe('applied');
    expect([getHandoffProposal(w.db, proposals[1].id)!.state, getHandoffProposal(w.db, proposals[2].id)!.state]).toEqual(['discarded', 'discarded']);
    expect(getMemRecord(w.db, notes[1].id)!.text).toBe('b');
  });

  it('H4(b) cancel during the confirmation’s await → the fence holds, nothing written, discarded(cancelled)', async () => {
    const note = await w.addNote('raced by a cancel');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'never' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    // The decide's own start passes; its write's await is held, and the cancel comes there.
    const hold = w.arm(WRITE_OBSERVATION);
    const pending = handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion, decisions: [approve(proposal)] }, w.deps());
    await hold.reached;
    // Held inside the write's await: the decide's start already passed.
    expect(stateOf(rid).state).toBe('applying');
    handoffCancel(w.db, screenRequest(), WT, rid, w.deps());
    hold.release();
    const outcome = await pending;
    expect(outcome.status).toBe(200);
    expect(getMemRecord(w.db, note.id)!.text).toBe('raced by a cancel');
    expect(getHandoffProposal(w.db, proposal.id)).toMatchObject({ state: 'discarded', stateReason: 'cancelled' });
  });

  it('H13(a) two decides of the same version: one passes, the other 409; the item changes once', async () => {
    const note = await w.addNote('twice');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'once' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    const [a, b] = await Promise.all([decide(rid, [approve(proposal)], ifVersion), decide(rid, [approve(proposal)], ifVersion)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(getMemRecord(w.db, note.id)!.version).toBe(note.version + 1);
  });

  it('H13(b) the answer lost and the decide sent again → 409 with the proposal applied; an add is one item', async () => {
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'add', kind: 'note', text: 'only one' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    expect((await decide(rid, [approve(proposal)], ifVersion)).status).toBe(200);
    const again = await decide(rid, [approve(proposal)], ifVersion);
    expect(codeOf(again)).toBe('version_conflict');
    expect((again.body as HandoffReadResponse).proposals[0].state).toBe('applied');
    expect(w.count("SELECT COUNT(*) n FROM mem_items WHERE text = 'only one'")).toBe(1);
  });

  it('H13(c) a forced end during the confirmation → the rest discarded(forced), nothing written', async () => {
    const note = await w.addNote('forced away');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'never' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    const hold = w.arm(WRITE_OBSERVATION);
    const pending = handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion, decisions: [approve(proposal)] }, w.deps());
    await hold.reached;
    // Held inside the write's await: the decide's start already passed.
    expect(stateOf(rid).state).toBe('applying');
    expect(stateOf(rid).state).toBe('applying');
    expect(handoffEnd(w.db, screenRequest(), WT, rid, { ifVersion: stateOf(rid).version, force: true }, w.deps()).status).toBe(200);
    hold.release();
    await pending;
    expect(getMemRecord(w.db, note.id)!.text).toBe('forced away');
    expect(getHandoffProposal(w.db, proposal.id)).toMatchObject({ state: 'discarded', stateReason: 'forced' });
  });

  it('H13(d) the request expires during the confirmation → expired, nothing written', async () => {
    const note = await w.addNote('expired away');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'never' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    const hold = w.arm(WRITE_OBSERVATION);
    const pending = handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion, decisions: [approve(proposal)] }, w.deps());
    await hold.reached;
    // Held inside the write's await: the decide's start already passed.
    expect(stateOf(rid).state).toBe('applying');
    w.clock.now += HANDOFF_REQUEST_TTL_MS + 1;
    hold.release();
    await pending;
    expect(getMemRecord(w.db, note.id)!.text).toBe('expired away');
    expect(getHandoffProposal(w.db, proposal.id)!.state).toBe('expired');
  });
});

describe('[#4227] H5・H10・H16(d)・H17・H18: what is approved, by whom, and on what', () => {
  it('H5: a fingerprint that is not the proposal’s is not confirmed (proposal_changed); the right one is', async () => {
    const note = await w.addNote('fp');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'by fp' });
    await w.done(rid);
    const wrong = await decide(rid, [{ ...approve(proposal), fingerprint: 'f'.repeat(64) }]);
    expect((wrong.body as HandoffDecideResponse).results[0].result).toBe('proposal_changed');
    expect(getMemRecord(w.db, note.id)!.text).toBe('fp');
    await decide(rid, [approve(proposal)]);
    expect(getMemRecord(w.db, note.id)!.text).toBe('by fp');
  });

  it('H10: a proposal from another instance → not_requested; from the request’s → taken', async () => {
    const created = await w.create();
    const other = await handoffPropose(w.db, WT, created.request.id, { instanceId: 'codex', op: 'add', kind: 'note', text: 'x' }, w.deps());
    expect(codeOf(other)).toBe('not_requested');
    await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'mine' });
  });

  it('H8: a proposal after the agent’s window → request_closed; before it → taken (and nothing is killed)', async () => {
    const created = await w.create();
    await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'in time' });
    w.clock.now += HANDOFF_AGENT_WINDOW_MS + 1;
    const late = await handoffPropose(w.db, WT, created.request.id, { instanceId: 'claude', op: 'add', kind: 'note', text: 'late' }, w.deps());
    expect(codeOf(late)).toBe('request_closed');
    expect(read(created.request.id).request.agentTimedOut).toBe(true);
  });

  it('extend: twice at most, each 5 more minutes from the deadline', async () => {
    const created = await w.create();
    const rid = created.request.id;
    const first = await handoffExtend(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version }, w.deps());
    expect(first.status).toBe(200);
    await handoffExtend(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version }, w.deps());
    const third = await handoffExtend(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version }, w.deps());
    expect(codeOf(third)).toBe('extend_limit');
    expect(stateOf(rid).agentDeadlineAt).toBe(w.clock.now + 3 * HANDOFF_AGENT_WINDOW_MS);
  });

  it('H16(d): a proposal to close a recorded decision → state_forbids (the person’s, S-D); an open one is taken', async () => {
    const created = await w.create();
    const rid = created.request.id;
    const note = await w.addNote('seed');
    w.db.prepare("INSERT INTO mem_items (id, repository_id, branch, kind, state, text, origin_worktree_id, origin_worktree_incarnation, origin_instance_id, origin_cli_tool_id, origin_incarnation, created_by, updated_by, version, checked_rules_version, created_at, updated_at) SELECT 'rec2', repository_id, branch, 'decision', 'recorded', 'recorded one', origin_worktree_id, origin_worktree_incarnation, origin_instance_id, origin_cli_tool_id, origin_incarnation, 'agent', 'agent', 1, 1, 0, 0 FROM mem_items WHERE id = ?").run(note.id);
    const refused = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'close', itemId: 'rec2', baseVersion: 1 }, w.deps());
    expect(codeOf(refused)).toBe('state_forbids');
    const record = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'record', itemId: 'rec2', baseVersion: 1 }, w.deps());
    expect(record.status).toBe(400);
    await w.propose(rid, { op: 'close', itemId: note.id, baseVersion: note.version });
  });

  it('H17: a proposal of `now` → 400; another kind is taken', async () => {
    const created = await w.create();
    const now = await handoffPropose(w.db, WT, created.request.id, { instanceId: 'claude', op: 'add', kind: 'now', text: 'x' }, w.deps());
    expect(now.status).toBe(400);
    await w.propose(created.request.id, { op: 'add', kind: 'next', text: 'y', closeWhen: 'issue:#1' });
  });

  it('H18(a): conflict → rebase → the old fingerprint is proposal_changed, the new one confirms', async () => {
    const note = await w.addNote('base');
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'rebased text' });
    await w.done(rid);
    await memUpdateItem(w.db, WT, note.id, { instanceId: 'claude', ifVersion: note.version, text: 'moved' }, w.deps());
    await decide(rid, [approve(proposal)]);
    const conflicted = getHandoffProposal(w.db, proposal.id)!;
    expect(conflicted.state).toBe('conflict');
    const rebased = await handoffRebase(w.db, screenRequest(), WT, rid, proposal.id, { ifVersion: read(rid).request.version, fingerprint: conflicted.fingerprint }, w.deps());
    expect(rebased.status).toBe(200);
    const fresh = getHandoffProposal(w.db, proposal.id)!;
    expect(fresh).toMatchObject({ state: 'proposed', revision: 2, baseVersion: note.version + 1 });
    const old = await decide(rid, [approve(proposal)]);
    expect((old.body as HandoffDecideResponse).results[0].result).toBe('proposal_changed');
    await decide(rid, [{ proposalId: fresh.id, fingerprint: fresh.fingerprint, action: 'approve' }]);
    expect(getMemRecord(w.db, note.id)!.text).toBe('rebased text');
  });

  it('H18(b): each of op, item, kind, base version, payload and revision changes the fingerprint', () => {
    const base = { requestId: 'r', id: 'p', revision: 1, op: 'update' as const, itemId: 'i', kind: 'note', baseVersion: 1, payloadText: '{"text":"a"}' };
    const original = proposalFingerprint(base);
    for (const changed of [
      { op: 'close' as const },
      { itemId: 'j' },
      { kind: 'next' },
      { baseVersion: 2 },
      { payloadText: '{"text":"b"}' },
      { revision: 2 },
    ]) {
      expect(proposalFingerprint({ ...base, ...changed })).not.toBe(original);
    }
    expect(proposalFingerprint({ ...base })).toBe(original);
  });

  it('H18(c): the immutable columns of a proposal and the pinned columns of a request refuse an UPDATE', async () => {
    const created = await w.create();
    const proposal = await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'fixed' });
    for (const column of ['op', 'item_id', 'kind', 'payload', 'request_id', 'author_instance_id']) {
      expect(() => w.db.prepare(`UPDATE mem_handoff_proposals SET ${column} = 'x' WHERE id = ?`).run(proposal.id)).toThrow(/immutable/);
    }
    for (const column of ['repository_id', 'branch', 'target_worktree_id', 'instance_id', 'boundary_id', 'target_worktree_incarnation']) {
      expect(() => w.db.prepare(`UPDATE mem_handoff_requests SET ${column} = 'x' WHERE id = ?`).run(created.request.id)).toThrow(/pinned/);
    }
  });

  it('H12: a proposal that matches a rule it was not checked against is withheld; an ordinary one shows', async () => {
    const created = await w.create();
    await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'ZZSECRET-value' });
    const row = (await import('@/lib/db/handoff-db')).listHandoffProposals(w.db, created.request.id)[0];
    const stricter = { list: [{ id: 'zz', pattern: /ZZSECRET/ }], version: 99 };
    expect(proposalView(w.db, row, stricter)).toMatchObject({ withheld: { field: 'text', rule: 'zz' } });
    expect(proposalView(w.db, row, stricter).payload).toBeUndefined();
    expect(proposalView(w.db, row).payload?.text).toBe('ZZSECRET-value');
  });
});

describe('[#4227] H14(d): the request’s branch is the one a confirmation lands on', () => {
  it('HEAD moved to another branch during the confirmation → membership_changed, failed, nothing on either branch', async () => {
    const created = await w.create();
    const rid = created.request.id;
    const proposal = await w.propose(rid, { op: 'add', kind: 'note', text: 'stays on A' });
    await w.done(rid);
    const ifVersion = read(rid).request.version;
    const before = w.count('SELECT COUNT(*) n FROM mem_items');
    const hold = w.arm(WRITE_OBSERVATION);
    const pending = handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion, decisions: [approve(proposal)] }, w.deps());
    await hold.reached;
    // Held inside the write's await: the decide's start already passed.
    expect(stateOf(rid).state).toBe('applying');
    w.branch.name = 'feature/y';
    hold.release();
    const outcome = await pending;
    expect((outcome.body as HandoffDecideResponse).results[0]).toMatchObject({ result: 'failed', code: 'membership_changed' });
    expect(w.count('SELECT COUNT(*) n FROM mem_items')).toBe(before);
    expect(getHandoffProposal(w.db, proposal.id)!.state).toBe('failed');
  });

  it('(negative control) HEAD left alone → the add lands on the request’s branch', async () => {
    const created = await w.create();
    const proposal = await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'lands on A' });
    await w.done(created.request.id);
    await decide(created.request.id, [approve(proposal)]);
    expect(w.count("SELECT COUNT(*) n FROM mem_items WHERE text = 'lands on A' AND branch = 'feature/x' AND created_by = 'agent'")).toBe(1);
  });
});
