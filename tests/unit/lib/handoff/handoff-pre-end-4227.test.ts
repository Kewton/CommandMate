/**
 * S-C: the hand-off's reader of "the update before the end was confirmed" (Issue #4227
 * G-PR3, design `mem-ui-4227.md` §0.0b S-C・§4.6・H9). `recorded` only when the conversation
 * right before the new boundary ended through the hand-off as `confirmed`; each of the four
 * conditions taken away (and an earlier generation's `confirmed`) is `not_recorded`.
 *
 * Also: the reader answers what D2's own X4 takes (`previousEndLead`), so a `recorded`
 * answer draws no line and `not_recorded` draws D2's line within D2's own limit — the
 * limit imported from D2, never copied here.
 *
 * The DB is a migrated file under `os.tmpdir()`, removed after each test.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { handoffRead } from '@/lib/handoff/request';
import { handoffDecide } from '@/lib/handoff/decide';
import { handoffEnd, handoffObserve } from '@/lib/handoff/end';
import { readHandoffPreEndUpdate } from '@/lib/handoff/pre-end';
import { previousEndLead, PREVIOUS_END_LINE_MAX_BYTES } from '@/lib/brief/previous-end';
import { HANDOFF_AGENT_WINDOW_MS, type HandoffReadResponse } from '@/lib/handoff/types';
import { makeHandoffWorld, screenRequest, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;

beforeEach(() => {
  w = makeHandoffWorld('handoff-pre-end-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

const read = (rid: string) => handoffRead(w.db, WT, rid, w.deps()).body as HandoffReadResponse;
const tokenOf = (outcome: { body: unknown }) => (outcome.body as { endToken: string }).endToken;

async function endAndObserve(rid: string, running: boolean | null, force = false) {
  const ended = handoffEnd(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version, ...(force ? { force: true } : {}) }, w.deps());
  expect(ended.status).toBe(200);
  return handoffObserve(w.db, screenRequest(), WT, rid, { endToken: tokenOf(ended) }, { running }, w.deps());
}

/** done, the one proposal approved and applied: everything but the stop. */
async function readyToStop(): Promise<string> {
  const note = await w.addNote('to update');
  const created = await w.create();
  const rid = created.request.id;
  const proposal = await w.propose(rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'updated' });
  await w.done(rid);
  await handoffDecide(w.db, screenRequest(), WT, rid, { ifVersion: read(rid).request.version, decisions: [{ proposalId: proposal.id, fingerprint: proposal.fingerprint, action: 'approve' }] }, w.deps());
  return rid;
}

/** The next process: a new launch boundary, a little later. Returns its opening (the reader's `before`). */
function relaunch(): number {
  w.clock.now += 1_000;
  w.openLaunch();
  return w.clock.now;
}

const answer = (before: number) => readHandoffPreEndUpdate(w.db, { worktreeId: WT, instanceId: 'claude', before });

describe('[#4227] S-C readHandoffPreEndUpdate (H9)', () => {
  it('(negative control) all four hold, then the next launch → recorded', async () => {
    const rid = await readyToStop();
    expect((await endAndObserve(rid, false)).status).toBe(200);
    expect(answer(relaunch())).toBe('recorded');
  });

  it('no request at all → not_recorded', () => {
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('no done (agent_timeout) → not_recorded', async () => {
    const created = await w.create();
    w.clock.now += HANDOFF_AGENT_WINDOW_MS + 1;
    await endAndObserve(created.request.id, false);
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('a proposal left undecided → not_recorded', async () => {
    const created = await w.create();
    await w.propose(created.request.id, { op: 'add', kind: 'note', text: 'never decided' });
    await w.done(created.request.id);
    await endAndObserve(created.request.id, false);
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('forced (done, no proposals) → not_recorded', async () => {
    const created = await w.create();
    await w.done(created.request.id);
    await endAndObserve(created.request.id, false, true);
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('the stop not observed (still running): ending is not ended → not_recorded', async () => {
    const rid = await readyToStop();
    expect((await endAndObserve(rid, true)).status).toBe(409);
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('an earlier generation’s confirmed is not used for a later end (a conversation after it)', async () => {
    const rid = await readyToStop();
    await endAndObserve(rid, false);
    // Started again and ended without the hand-off; then the next launch.
    relaunch();
    expect(answer(relaunch())).toBe('not_recorded');
  });

  it('a request that ended after `before` is not this boundary’s', async () => {
    const rid = await readyToStop();
    const before = w.clock.now;
    w.clock.now += 1_000;
    await endAndObserve(rid, false);
    expect(answer(before)).toBe('not_recorded');
  });

  it('the worktree made again under the same id: the old confirmed is not its', async () => {
    const rid = await readyToStop();
    await endAndObserve(rid, false);
    const before = relaunch();
    expect(answer(before)).toBe('recorded');
    // The worktree's lifetime as a delete and a re-make leave it (the request keeps the old one).
    w.db.prepare('UPDATE mem_worktree_incarnations SET incarnation = ? WHERE worktree_id = ?').run('another-lifetime', WT);
    expect(answer(before)).toBe('not_recorded');
  });

  it('a read that throws is not_recorded', () => {
    w.db.exec('DROP TABLE mem_handoff_proposals; DROP TABLE mem_handoff_requests;');
    expect(answer(relaunch())).toBe('not_recorded');
  });
});

describe('[#4227] S-C what D2’s X4 does with the answer (the limit is D2’s, imported)', () => {
  const facts = { hadConversation: true, lastUpdateAt: null };
  const input = (now: number) => ({ mode: 'on' as const, kind: 'launch' as const, openedAt: now, now });

  it('recorded: no line', async () => {
    const rid = await readyToStop();
    await endAndObserve(rid, false);
    const before = relaunch();
    expect(previousEndLead(input(before), facts, answer(before))).toBeNull();
  });

  it('not_recorded: D2’s line, within PREVIOUS_END_LINE_MAX_BYTES', () => {
    const before = relaunch();
    const line = previousEndLead(input(before), facts, answer(before));
    expect(line).toMatch(/^終わる前の更新を確認できない（/);
    expect(Buffer.byteLength(line!, 'utf8')).toBeLessThanOrEqual(PREVIOUS_END_LINE_MAX_BYTES);
  });

  it('the reader is read only: no INSERT / UPDATE / DELETE, no timer, no tmux', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/handoff/pre-end.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(source).not.toMatch(/setTimeout|setInterval|tmux/);
  });
});
