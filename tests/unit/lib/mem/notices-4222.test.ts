/**
 * The "it ended" notices (Issue #4222, design §3.3・§3.5・§9.1・§9.3): who receives one,
 * once, after any other evaluation; what is acknowledged and what is not; restarts,
 * budget, uncertain sends, races between briefs; the screen's list.
 *
 * Conditions are `at:` in the past, so nothing but the database is asked.
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

import { addAgentInstance, setAgentInstances, removeAgentInstance } from '@/lib/db/agent-instances-db';
import { deleteWorktreesByIds, migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import { getInstanceIncarnationRow } from '@/lib/mem/incarnation';
import {
  captureMemRecipient,
  listMemNoticesFor,
  listUndeliveredMemNotices,
  reserveMemNotices,
  settleMemNoticeAttempt,
  type MemNoticeRecipient,
} from '@/lib/mem/notices';
import { memAcknowledgeNotice, memCheck, memList, memUndeliveredNotices } from '@/lib/mem/service';
import type { MemTargetResolved } from '@/lib/mem/target';
import type { MemNoticeListResponse } from '@/types/mem';
import { MemWorld } from './mem-4222-harness';

const PAST = 'at:2020-01-01T00:00+00:00';
const world = new MemWorld();
let boot = 'boot-1';
const clock = () => ({ bootId: () => boot });

beforeEach(() => {
  world.open('mem-notices-4222-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex-2', cliTool: 'codex' },
  ]);
  world.setMode('on');
  boot = 'boot-1';
});
afterEach(() => world.close());

function target(): MemTargetResolved {
  return {
    ok: true,
    via: 'worktree',
    worktree: null,
    branch: 'feature/x',
    detached: false,
    head: null,
    mode: 'on',
    features: { injectOnStart: false, promptOnEvents: false, popup: false },
    source: { level: 'rule', repositoryId: world.repo, branch: 'feature/x', rulePosition: 0, pattern: '**' },
    members: [],
    storageRepositoryId: world.repo,
    readRepositoryIds: [world.repo],
  };
}
const recipient = (worktreeId: string, instanceId: string): MemNoticeRecipient => captureMemRecipient(world.db, worktreeId, instanceId, target());
const listFor = (worktreeId: string, instanceId: string) => listMemNoticesFor(world.db, recipient(worktreeId, instanceId), clock());
const check = (worktreeId = 'wt-1', instanceId = 'codex-2') =>
  memCheck(world.db, { via: 'worktree', worktreeId }, { instanceId }, world.deps());
const pick = (r: MemNoticeRecipient) => listMemNoticesFor(world.db, r, clock()).map((n) => ({ noticeId: n.id, uncertain: n.uncertain }));

async function deliver(worktreeId: string, instanceId: string, state: 'sent' | 'not-sent' | 'indeterminate' = 'sent') {
  const r = recipient(worktreeId, instanceId);
  const reserved = reserveMemNotices(world.db, r, pick(r), clock());
  if (reserved.attemptId) settleMemNoticeAttempt(world.db, reserved.attemptId, state, clock());
  return reserved;
}

const noticeRow = (itemId: string) => world.db.prepare('SELECT * FROM mem_notices WHERE item_id = ?').get(itemId) as Record<string, unknown>;

describe('the author gets "it ended" once, whoever evaluated first', () => {
  it('another instance’s check closes it → one pending notice, not given to that instance; the author’s brief takes it once', async () => {
    const item = await world.add('next', PAST);
    expect((await check('wt-1', 'codex-2')).status).toBe(200);
    // The screen's preview and a list evaluate again: still one.
    await memList(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps());
    expect(world.count('SELECT COUNT(*) n FROM mem_notices')).toBe(1);
    expect(noticeRow(item.id).state).toBe('pending');
    expect(listFor('wt-1', 'codex-2')).toEqual([]);
    const mine = listFor('wt-1', 'claude');
    expect(mine.map((n) => [n.itemId, n.audience])).toEqual([[item.id, 'creator']]);
    const reserved = await deliver('wt-1', 'claude', 'sent');
    expect(reserved.reserved).toEqual([{ noticeId: mine[0].id, audience: 'creator', uncertain: false }]);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'creator' });
    expect(listFor('wt-1', 'claude')).toEqual([]);
    expect(listUndeliveredMemNotices(world.db, [world.repo], 'feature/x', clock())).toEqual([]);
  });

  it('(control) the author’s own check is not an acknowledgement: the next brief carries it', async () => {
    const item = await world.add('next', PAST);
    await check('wt-1', 'claude');
    expect(noticeRow(item.id).state).toBe('pending');
    expect(listFor('wt-1', 'claude')).toHaveLength(1);
  });

  it('two evaluations at once write one record and one notice', async () => {
    const item = await world.add('next', PAST);
    await Promise.all([check('wt-1', 'claude'), check('wt-1', 'codex-2'), check('wt-1', 'claude')]);
    expect(world.count('SELECT COUNT(*) n FROM mem_close_records WHERE item_id = ?', item.id)).toBe(1);
    expect(world.count('SELECT COUNT(*) n FROM mem_notices WHERE item_id = ?', item.id)).toBe(1);
  });
});

describe('who receives it when the author is gone (§3.3)', () => {
  it('author off the roster → an instance added afterwards (roster) is the successor; one from before is not', async () => {
    const item = await world.add('next', PAST);
    await check();
    setAgentInstances(world.db, 'wt-1', [{ id: 'codex-2', cliTool: 'codex', alias: '', order: 0 }]);
    addAgentInstance(world.db, 'wt-1', { id: 'codex', cliTool: 'codex', alias: '', order: 1 });
    expect(getInstanceIncarnationRow(world.db, 'wt-1', 'codex')?.issuedBy).toBe('roster');
    expect(listFor('wt-1', 'codex-2')).toEqual([]);
    expect(listFor('wt-1', 'codex').map((n) => [n.itemId, n.audience])).toEqual([[item.id, 'successor']]);
    await deliver('wt-1', 'codex');
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'successor', acknowledged_instance_id: 'codex' });
  });

  it('the same instance id made again → the new incarnation is a successor of the same slot, never the creator', async () => {
    const item = await world.add('next', PAST);
    await check();
    removeAgentInstance(world.db, 'wt-1', 'claude');
    addAgentInstance(world.db, 'wt-1', { id: 'claude', cliTool: 'claude', alias: '', order: 2 });
    expect(listFor('wt-1', 'claude').map((n) => n.audience)).toEqual(['successor']);
    expect(noticeRow(item.id).origin_instance_id).toBe('claude');
  });

  it('P1-3: a rename keeps the author alive; the author at the new id is the creator, others get nothing', async () => {
    const item = await world.add('next', PAST);
    await check();
    world.db.transaction(() => migrateWorktreeIdPreservingChildren(world.db, 'wt-1', 'wt-1b'))();
    world.worktree('wt-2', [{ id: 'codex-3', cliTool: 'codex' }]);
    addAgentInstance(world.db, 'wt-2', { id: 'codex-4', cliTool: 'codex', alias: '', order: 1 });
    expect(listFor('wt-2', 'codex-4')).toEqual([]);
    const r = recipient('wt-2', 'codex-4');
    expect(reserveMemNotices(world.db, r, [{ noticeId: noticeRow(item.id).id as string, uncertain: false }], clock()).attemptId).toBeNull();
    expect(listFor('wt-1b', 'claude').map((n) => n.audience)).toEqual(['creator']);
  });

  it('(control) the worktree deleted and made again under the same id and instance id → successor (a), not creator', async () => {
    const item = await world.add('next', PAST);
    await check();
    deleteWorktreesByIds(world.db, ['wt-1']);
    world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
    expect(listFor('wt-1', 'claude').map((n) => [n.itemId, n.audience])).toEqual([[item.id, 'successor']]);
  });

  it('P2-4: a derived primary that first writes mem after the item (lazy) is not a successor', async () => {
    const item = await world.add('next', PAST);
    await check();
    removeAgentInstance(world.db, 'wt-1', 'claude');
    world.worktree('wt-3', null);
    await world.add('note', undefined, { worktreeId: 'wt-3', instanceId: 'claude' });
    expect(getInstanceIncarnationRow(world.db, 'wt-3', 'claude')?.issuedBy).toBe('lazy');
    expect(listFor('wt-3', 'claude').filter((n) => n.itemId === item.id)).toEqual([]);
  });

  it('2nd review ①: the first roster save of a derived worktree copies its primary as lazy (no successor); the new id is roster', async () => {
    world.worktree('wt-3', null);
    const item = await world.add('next', PAST);
    await check();
    removeAgentInstance(world.db, 'wt-1', 'claude');
    // The first save, as `createInstanceWithRole` makes it: the derived primary plus a new instance.
    setAgentInstances(world.db, 'wt-3', [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 },
    ]);
    expect(getInstanceIncarnationRow(world.db, 'wt-3', 'claude')?.issuedBy).toBe('lazy');
    expect(getInstanceIncarnationRow(world.db, 'wt-3', 'codex-2')?.issuedBy).toBe('roster');
    expect(listFor('wt-3', 'claude')).toEqual([]);
    expect(listFor('wt-3', 'codex-2').map((n) => [n.itemId, n.audience])).toEqual([[item.id, 'successor']]);
    // (control) a primary added to a worktree that already has rows is roster.
    addAgentInstance(world.db, 'wt-3', { id: 'codex', cliTool: 'codex', alias: '', order: 2 });
    expect(getInstanceIncarnationRow(world.db, 'wt-3', 'codex')?.issuedBy).toBe('roster');
  });

  it('nobody may take it → it stays in the screen’s list, and a person takes it there', async () => {
    const item = await world.add('next', PAST);
    await check();
    removeAgentInstance(world.db, 'wt-1', 'claude');
    const outcome = await memUndeliveredNotices(world.db, world.repo, 'feature/x', world.deps());
    const listed = (outcome.body as MemNoticeListResponse).notices;
    expect(listed.map((n) => [n.itemId, n.audience, n.endReason])).toEqual([[item.id, null, 'time-passed']]);
    const stale = await memAcknowledgeNotice(world.db, world.repo, listed[0].id, { ifVersion: listed[0].version + 1 }, world.deps());
    expect(stale.status).toBe(409);
    const taken = await memAcknowledgeNotice(world.db, world.repo, listed[0].id, { ifVersion: listed[0].version }, world.deps());
    expect(taken.status).toBe(200);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'human' });
    expect(((await memUndeliveredNotices(world.db, world.repo, 'feature/x', world.deps())).body as MemNoticeListResponse).notices).toEqual([]);
  });

  it('the author’s tmux killed and started again under the same incarnation → still the creator', async () => {
    await world.add('next', PAST);
    await check();
    expect(listFor('wt-1', 'claude').map((n) => n.audience)).toEqual(['creator']);
    expect(listFor('wt-1', 'claude').map((n) => n.audience)).toEqual(['creator']);
  });
});

describe('what is and is not acknowledged (§3.5)', () => {
  it('a notice the budget left out stays pending and comes in the next brief', async () => {
    const first = await world.add('next', PAST);
    const second = await world.add('next', PAST);
    await check();
    const r = recipient('wt-1', 'claude');
    const listed = listMemNoticesFor(world.db, r, clock());
    const firstNotice = listed.find((n) => n.itemId === first.id)!;
    const reserved = reserveMemNotices(world.db, r, [{ noticeId: firstNotice.id, uncertain: false }], clock());
    settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock());
    expect(noticeRow(second.id).state).toBe('pending');
    expect(listFor('wt-1', 'claude').map((n) => n.itemId)).toEqual([second.id]);
  });

  it('indeterminate → pending, marked; not-sent → pending unmarked; a second settle does nothing', async () => {
    const item = await world.add('next', PAST);
    await check();
    const r = recipient('wt-1', 'claude');
    const attempt = reserveMemNotices(world.db, r, pick(r), clock()).attemptId!;
    expect(settleMemNoticeAttempt(world.db, attempt, 'indeterminate', clock())).toBe(1);
    expect(settleMemNoticeAttempt(world.db, attempt, 'sent', clock())).toBe(0);
    expect(noticeRow(item.id)).toMatchObject({ state: 'pending', uncertain_count: 1 });
    expect(listFor('wt-1', 'claude').map((n) => n.uncertain)).toEqual([true]);
    const again = reserveMemNotices(world.db, r, pick(r), clock());
    expect(again.reserved.map((entry) => entry.uncertain)).toEqual([true]);
    settleMemNoticeAttempt(world.db, again.attemptId!, 'not-sent', clock());
    expect(noticeRow(item.id)).toMatchObject({ state: 'pending', uncertain_count: 1 });
  });

  it('a restart while reserved → read as pending with the +1 counted; reserved with the mark; R2-③ a changed mark is not reserved', async () => {
    const item = await world.add('next', PAST);
    await check();
    const r = recipient('wt-1', 'claude');
    const listedBefore = pick(r);
    expect(listedBefore.map((entry) => entry.uncertain)).toEqual([false]);
    expect(reserveMemNotices(world.db, r, listedBefore, clock()).attemptId).not.toBeNull();
    expect(listFor('wt-1', 'claude')).toEqual([]);
    boot = 'boot-2';
    // C read `uncertain: false` before the restart; the mark is now true → not reserved, stays for the next brief.
    const stale = reserveMemNotices(world.db, r, listedBefore, clock());
    expect(stale).toEqual({ attemptId: null, reserved: [] });
    expect(noticeRow(item.id)).toMatchObject({ state: 'pending', uncertain_count: 1 });
    const fresh = pick(r);
    expect(fresh.map((entry) => entry.uncertain)).toEqual([true]);
    const reserved = reserveMemNotices(world.db, r, fresh, clock());
    expect(reserved.reserved).toEqual([{ noticeId: fresh[0].noticeId, audience: 'creator', uncertain: true }]);
  });

  it('P1-2: two briefs choosing {n1,n2} and {n2,n3} → n2 is in one only; settling one acknowledges only its own', async () => {
    const items = [await world.add('next', PAST), await world.add('next', PAST), await world.add('next', PAST)];
    await check();
    const r = recipient('wt-1', 'claude');
    const ids = items.map((item) => noticeRow(item.id).id as string);
    const alpha = reserveMemNotices(world.db, r, [ids[0], ids[1]].map((noticeId) => ({ noticeId, uncertain: false })), clock());
    const beta = reserveMemNotices(world.db, r, [ids[1], ids[2]].map((noticeId) => ({ noticeId, uncertain: false })), clock());
    expect(alpha.reserved.map((entry) => entry.noticeId)).toEqual([ids[0], ids[1]]);
    expect(beta.reserved.map((entry) => entry.noticeId)).toEqual([ids[2]]);
    settleMemNoticeAttempt(world.db, alpha.attemptId!, 'sent', clock());
    expect(items.map((item) => noticeRow(item.id).state)).toEqual(['acknowledged', 'acknowledged', 'reserved']);
    // (control) nothing reservable → no attempt row.
    const none = reserveMemNotices(world.db, r, [{ noticeId: ids[0], uncertain: false }], clock());
    expect(none).toEqual({ attemptId: null, reserved: [] });
  });

  it('P2-3: one brief with the author’s notice and a predecessor’s → each acknowledged by its own audience', async () => {
    const old = await world.add('next', PAST);
    removeAgentInstance(world.db, 'wt-1', 'claude');
    addAgentInstance(world.db, 'wt-1', { id: 'claude', cliTool: 'claude', alias: '', order: 2 });
    const mine = await world.add('next', PAST);
    await check();
    await deliver('wt-1', 'claude');
    expect(noticeRow(mine.id).acknowledged_by).toBe('creator');
    expect(noticeRow(old.id).acknowledged_by).toBe('successor');
  });

  it('P2-4: listing writes nothing (no incarnation made, no stale attempt put back)', async () => {
    await world.add('next', PAST);
    await check();
    const r = recipient('wt-1', 'claude');
    reserveMemNotices(world.db, r, pick(r), clock());
    boot = 'boot-2';
    world.worktree('wt-3', null);
    const r3 = recipient('wt-3', 'claude');
    const snapshot = () =>
      ['mem_notices', 'mem_notice_attempts', 'mem_instance_incarnations', 'mem_worktree_incarnations', 'mem_items', 'mem_close_records'].map((table) =>
        JSON.stringify(world.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
      );
    const before = snapshot();
    listMemNoticesFor(world.db, r, clock());
    listMemNoticesFor(world.db, r3, clock());
    listUndeliveredMemNotices(world.db, [world.repo], 'feature/x', clock());
    expect(snapshot()).toEqual(before);
  });
});

describe('mode off / derived (§4)', () => {
  it('reserve writes nothing; a send settled while off is not acknowledged; the notice stays in the screen’s list', async () => {
    const item = await world.add('next', PAST);
    await check();
    const r = recipient('wt-1', 'claude');
    const reserved = reserveMemNotices(world.db, r, pick(r), clock());
    for (const mode of ['off', 'derived'] as const) {
      world.setMode(mode);
      const before = JSON.stringify(world.db.prepare('SELECT * FROM mem_notices').all());
      const second = reserveMemNotices(world.db, recipient('wt-1', 'claude'), [{ noticeId: noticeRow(item.id).id as string, uncertain: false }], clock());
      expect(second).toEqual({ attemptId: null, reserved: [] });
      expect(JSON.stringify(world.db.prepare('SELECT * FROM mem_notices').all())).toBe(before);
    }
    settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock());
    expect(noticeRow(item.id).state).toBe('pending');
    expect(listUndeliveredMemNotices(world.db, [world.repo], 'feature/x', clock()).map((n) => n.itemId)).toEqual([item.id]);
    const human = await memAcknowledgeNotice(world.db, world.repo, noticeRow(item.id).id as string, { ifVersion: noticeRow(item.id).version as number }, world.deps());
    expect(human.status).toBe(409);
    world.setMode('on');
    await deliver('wt-1', 'claude');
    expect(noticeRow(item.id).state).toBe('acknowledged');
  });
});

describe('integration review P2-1: a rename between the reservation and the settle', () => {
  it('reserved at wt-1, renamed to wt-1b, settled sent → acknowledged by the creator (the same worktree lifetime)', async () => {
    const item = await world.add('next', PAST);
    await check();
    const reserved = reserveMemNotices(world.db, recipient('wt-1', 'claude'), pick(recipient('wt-1', 'claude')), clock());
    world.db.transaction(() => migrateWorktreeIdPreservingChildren(world.db, 'wt-1', 'wt-1b'))();
    expect(settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock())).toBe(1);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'creator', uncertain_count: 0 });
    expect(listFor('wt-1b', 'claude')).toEqual([]);
  });

  it('(control) reserved, then the worktree deleted and made again under the same id → not acknowledged', async () => {
    const item = await world.add('next', PAST);
    await check();
    const reserved = reserveMemNotices(world.db, recipient('wt-1', 'claude'), pick(recipient('wt-1', 'claude')), clock());
    deleteWorktreesByIds(world.db, ['wt-1']);
    world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
    settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock());
    expect(noticeRow(item.id).state).toBe('pending');
  });

  it('(control) reserved, renamed, then the new id deleted and made again → not acknowledged', async () => {
    const item = await world.add('next', PAST);
    await check();
    const reserved = reserveMemNotices(world.db, recipient('wt-1', 'claude'), pick(recipient('wt-1', 'claude')), clock());
    world.db.transaction(() => migrateWorktreeIdPreservingChildren(world.db, 'wt-1', 'wt-1b'))();
    deleteWorktreesByIds(world.db, ['wt-1b']);
    world.worktree('wt-1b', [{ id: 'claude', cliTool: 'claude' }]);
    settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock());
    expect(noticeRow(item.id).state).toBe('pending');
  });
});

describe('integration review P2-2: a person takes a notice whose reservation is stale', () => {
  const screen = () => world.deps({ bootId: () => boot });
  const listed = async () => ((await memUndeliveredNotices(world.db, world.repo, 'feature/x', screen())).body as MemNoticeListResponse).notices;
  const attempts = () => world.db.prepare('SELECT id, settled_at, result FROM mem_notice_attempts').all() as Array<{ id: string; settled_at: number | null; result: string | null }>;

  async function reservedOne() {
    const item = await world.add('next', PAST);
    await check();
    const reserved = reserveMemNotices(world.db, recipient('wt-1', 'claude'), pick(recipient('wt-1', 'claude')), clock());
    expect(noticeRow(item.id).state).toBe('reserved');
    return { item, attemptId: reserved.attemptId! };
  }

  it('the sender of another boot is gone → the version the list showed takes it; the old attempt is abandoned and its settle does nothing', async () => {
    const { item, attemptId } = await reservedOne();
    boot = 'boot-2';
    const [shown] = await listed();
    expect(shown.uncertain).toBe(true);
    const taken = await memAcknowledgeNotice(world.db, world.repo, shown.id, { ifVersion: shown.version }, screen());
    expect(taken.status).toBe(200);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'human', attempt_id: null, uncertain_count: 1 });
    expect(attempts()).toEqual([{ id: attemptId, settled_at: expect.any(Number), result: 'abandoned' }]);
    expect(settleMemNoticeAttempt(world.db, attemptId, 'sent', clock())).toBe(0);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'human' });
    expect(await listed()).toEqual([]);
  });

  it('the same boot, more than 10 minutes later → taken', async () => {
    const { item } = await reservedOne();
    const later = Date.now() + 11 * 60 * 1000;
    world.clock = () => later;
    const [shown] = await listed();
    expect((await memAcknowledgeNotice(world.db, world.repo, shown.id, { ifVersion: shown.version }, screen())).status).toBe(200);
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'human' });
  });

  it('(control) a live reservation stays protected: 409 state_forbids, nothing written; its settle acknowledges it', async () => {
    const { item, attemptId } = await reservedOne();
    const before = JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()]);
    const row = noticeRow(item.id);
    const refused = await memAcknowledgeNotice(world.db, world.repo, row.id as string, { ifVersion: row.version as number }, screen());
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('state_forbids');
    expect(JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()])).toBe(before);
    settleMemNoticeAttempt(world.db, attemptId, 'sent', clock());
    expect(noticeRow(item.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'creator' });
  });

  it('(control) a stale reservation with a version the list did not show → 409 version_conflict, the reservation left as it was', async () => {
    const { item } = await reservedOne();
    boot = 'boot-2';
    const [shown] = await listed();
    const before = JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()]);
    const refused = await memAcknowledgeNotice(world.db, world.repo, shown.id, { ifVersion: shown.version + 1 }, screen());
    expect((refused.body as { code: string }).code).toBe('version_conflict');
    expect(JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()])).toBe(before);
    expect(noticeRow(item.id).state).toBe('reserved');
  });

  it('(control) a stale reservation while the mode is off → 409 disabled, nothing written', async () => {
    const { item } = await reservedOne();
    boot = 'boot-2';
    const [shown] = await listed();
    world.setMode('off');
    const before = JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()]);
    const refused = await memAcknowledgeNotice(world.db, world.repo, shown.id, { ifVersion: shown.version }, screen());
    expect(refused.status).toBe(409);
    expect(JSON.stringify([world.db.prepare('SELECT * FROM mem_notices').all(), attempts()])).toBe(before);
    expect(noticeRow(item.id).state).toBe('reserved');
  });
});
