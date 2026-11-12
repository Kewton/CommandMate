/**
 * C's provider for D1's port (Issue #4223, design §5): the contract of the port, the
 * membership checked again (I11), the reservation attempts never confused or lost
 * (I12), and one deadline from the start (I15).
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

import { addAgentInstance, removeAgentInstance } from '@/lib/db/agent-instances-db';
import { endInstanceIncarnation, getInstanceIncarnation, getOrCreateWorktreeIncarnation, startInstanceIncarnation } from '@/lib/mem/incarnation';
import { readInstanceLifetime } from '@/lib/db/session-brief-db';
import { memCheck } from '@/lib/mem/service';
import { EMPTY_BRIEF_PROVIDER, getBriefProvider, type BriefRequest } from '@/lib/session/brief-provider';
import { createMemBriefProvider, MEM_BRIEF_PORT, MEM_BRIEF_PROVIDER, settleBriefAttempt, type MemBriefProviderState } from '@/lib/brief/provider';
import { BriefMembershipChangedError } from '@/lib/brief/build';
import { BriefDeadlineExpiredError } from '@/lib/brief/deadline';
import type { BriefSourceReader } from '@/lib/brief/sources';
import { fail } from '../mem/mem-4222-harness';
import { BriefWorld, bytes, resetBriefMemory } from './brief-4223-harness';

const world = new BriefWorld();
let state: MemBriefProviderState;

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-provider-4223-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex', cliTool: 'codex' },
  ]);
  world.setMode('on');
  state = createMemBriefProvider(() => world.db, world.briefDeps());
});
afterEach(() => {
  vi.useRealTimers();
  world.close();
  resetBriefMemory();
});

function request(over: { boundaryId?: string; branch?: string; mode?: 'on' | 'derived'; maxLines?: number; maxBytes?: number } = {}): BriefRequest {
  return {
    target: {
      worktreeId: 'wt-1',
      // Issue #4224: the lifetimes a send's entrance fixes (D2 design §2.4), as of now.
      worktreeIncarnation: getOrCreateWorktreeIncarnation(world.db, 'wt-1'),
      cliToolId: 'claude',
      instanceId: 'claude',
      instanceIncarnation: getInstanceIncarnation(world.db, 'wt-1', 'claude')?.incarnation ?? null,
      instanceOnRoster: readInstanceLifetime(world.db, 'wt-1', 'claude').onRoster,
    },
    membership: {
      repositoryId: world.repo,
      readRepositoryIds: [world.repo],
      branch: over.branch ?? 'feature/x',
      detached: false,
      mode: over.mode ?? 'on',
    },
    boundary: { id: over.boundaryId ?? 'b-1', kind: 'launch', late: false, openedAt: Date.now() },
    budget: { maxBytes: over.maxBytes ?? 4096, maxLines: over.maxLines ?? 240 },
    now: Date.now(),
  };
}

const noticeState = (id: string): string => (world.db.prepare('SELECT state FROM mem_notices WHERE id = ?').get(id) as { state: string }).state;

async function twoNotices(): Promise<void> {
  await world.add('waiting', 'at:2020-01-01T00:00+00:00', { text: 'first' });
  await world.add('waiting', 'at:2020-01-01T00:00+00:00', { text: 'second' });
  await memCheck(world.db, { via: 'worktree', worktreeId: 'wt-1' }, { instanceId: 'codex' }, world.deps());
}

describe('the port’s contract', () => {
  it('id, minimum and default; no settle (D2 connects settleBriefAttempt); not wired into getBriefProvider', () => {
    expect(MEM_BRIEF_PROVIDER).toMatchObject({ id: 'mem-brief', minBytes: 1024, defaultBytes: 4096 });
    expect(MEM_BRIEF_PROVIDER.settle).toBeUndefined();
    expect(typeof MEM_BRIEF_PROVIDER.reserve).toBe('function');
    // Issue #4224 (D2 design §10 T-1): D2 connects it — the default is MEM_BRIEF_PORT, which is
    // this provider with settleBriefAttempt as its settle; MEM_BRIEF_PROVIDER keeps none (above).
    expect(getBriefProvider()).toBe(MEM_BRIEF_PORT);
    expect(getBriefProvider()).not.toBe(EMPTY_BRIEF_PROVIDER);
    expect(MEM_BRIEF_PORT).toMatchObject({ id: 'mem-brief', minBytes: 1024, defaultBytes: 4096, build: MEM_BRIEF_PROVIDER.build, reserve: MEM_BRIEF_PROVIDER.reserve, settle: settleBriefAttempt });
  });

  it('maxLines below the fixed 5 lines builds an empty body', async () => {
    expect(await state.provider.build(request({ maxLines: 4 }))).toEqual({ body: '', includedNoticeIds: [], mode: 'on' });
  });

  it('the body is within bytes and lines, has no trailing newline, and names the notices it carries', async () => {
    await twoNotices();
    const built = await state.provider.build(request({ maxLines: 12 }));
    expect(bytes(built.body)).toBeLessThanOrEqual(4096);
    expect(built.body.split('\n').length).toBeLessThanOrEqual(12);
    expect(built.body.endsWith('\n')).toBe(false);
    expect(built.mode).toBe('on');
    for (const id of built.includedNoticeIds) expect(built.body).toContain(`src=notice id=${id}`);
  });

  it('two builds close a met condition once', async () => {
    await world.add('waiting', 'at:2020-01-01T00:00+00:00', { text: 'once' });
    await state.provider.build(request());
    await state.provider.build(request({ boundaryId: 'b-2' }));
    expect(world.count("SELECT COUNT(*) AS n FROM mem_close_records")).toBe(1);
  });
});

describe('I11 a build whose membership changed is not attached', () => {
  it('another branch than the request’s (the same mode) throws', async () => {
    await expect(state.provider.build(request({ branch: 'feature/y' }))).rejects.toBeInstanceOf(BriefMembershipChangedError);
  });

  it('the mode only is not the membership: X asked, Y built (same mode) throws', async () => {
    world.head = { ...world.head, branch: 'feature/y' };
    await expect(state.provider.build(request({ branch: 'feature/x' }))).rejects.toBeInstanceOf(BriefMembershipChangedError);
  });

  async function changeDuringEvaluation(change: () => void) {
    await world.add('waiting', 'issue:#12', { text: 'waits on gh' });
    world.fake.handler = () => {
      change();
      return fail(1, 'offline');
    };
  }

  it.each([
    ['on → off', () => world.setMode('off')],
    ['on → derived', () => world.setMode('derived')],
    ['the worktree made again under the same id', () => world.db.prepare("UPDATE mem_worktree_incarnations SET incarnation = 'other' WHERE worktree_id = 'wt-1'").run()],
    [
      'the instance removed and added again by the roster',
      () => {
        removeAgentInstance(world.db, 'wt-1', 'claude');
        addAgentInstance(world.db, 'wt-1', { id: 'claude', cliTool: 'claude', alias: '', order: 2 });
      },
    ],
  ])('%s while the evaluation is waited for throws', async (_name, change) => {
    await changeDuringEvaluation(change);
    await expect(state.provider.build(request())).rejects.toBeInstanceOf(BriefMembershipChangedError);
    expect(state.memoCount()).toBe(0);
  });

  it('the CLI rebuilds: off by then is exit 50, derived by then is a derived brief', async () => {
    await changeDuringEvaluation(() => world.setMode('off'));
    expect((await world.brief()).exit).toBe(50);
    world.setMode('on');
    await changeDuringEvaluation(() => world.setMode('derived'));
    const run = await world.brief();
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('mode=derived');
  });

  it('negative: no incarnation yet, and a lazy issue while waiting, is the same lifetime (D1’s rule)', async () => {
    await changeDuringEvaluation(() => {
      if (!getInstanceIncarnation(world.db, 'wt-1', 'claude')) startInstanceIncarnation(world.db, 'wt-1', 'claude', 'claude', Date.now(), 'lazy');
    });
    endInstanceIncarnation(world.db, 'wt-1', 'claude');
    const req = request();
    expect(req.target.instanceIncarnation).toBeNull();
    const built = await state.provider.build(req);
    expect(built.body).toContain('mode=on');
  });

  it('positive: no incarnation, then a roster issue while waiting, is another lifetime', async () => {
    await changeDuringEvaluation(() => {
      if (!getInstanceIncarnation(world.db, 'wt-1', 'claude')) startInstanceIncarnation(world.db, 'wt-1', 'claude', 'claude', Date.now(), 'roster');
    });
    endInstanceIncarnation(world.db, 'wt-1', 'claude');
    await expect(state.provider.build(request())).rejects.toBeInstanceOf(BriefMembershipChangedError);
  });

  it('negative: nothing changed → built, and reserve takes the notices', async () => {
    await twoNotices();
    const req = request();
    const built = await state.provider.build(req);
    expect(built.includedNoticeIds).toHaveLength(2);
    const reserved = state.provider.reserve!({ boundaryId: 'b-1', claimToken: 't', includedNoticeIds: built.includedNoticeIds, body: built.body });
    expect(reserved?.includedNoticeIds.sort()).toEqual([...built.includedNoticeIds].sort());
  });
});

describe('I12 reservation attempts are never confused or lost', () => {
  async function built(boundaryId = 'b-1') {
    const result = await state.provider.build(request({ boundaryId }));
    return result;
  }

  it.each([['B discarded first'], ['A sent first']])('A reserves; B is refused; %s — A’s notices end acknowledged', async (order) => {
    await twoNotices();
    const a = await built();
    const b = await built(); // built while A's notices were still pending: it carries them too
    const ra = state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'a', includedNoticeIds: a.includedNoticeIds, body: a.body })!;
    expect(b.includedNoticeIds).toHaveLength(2);
    expect(state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'b', includedNoticeIds: b.includedNoticeIds, body: b.body })).toBeNull();
    const settleB = () => state.settle({ boundaryId: 'b-1', outcome: 'discarded', includedNoticeIds: b.includedNoticeIds });
    const settleA = () => state.settle({ boundaryId: 'b-1', outcome: 'sent', includedNoticeIds: ra.includedNoticeIds });
    if (order === 'B discarded first') {
      settleB();
      settleA();
    } else {
      settleA();
      settleB();
    }
    for (const id of ra.includedNoticeIds) expect(noticeState(id)).toBe('acknowledged');
    expect(state.attemptOf('b-1')).toBeUndefined();
  });

  it('65 builds after the reservation do not drop the attempt', async () => {
    await twoNotices();
    const a = await built();
    state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'a', includedNoticeIds: a.includedNoticeIds, body: a.body });
    for (let i = 0; i < 65; i += 1) await built(`other-${i}`);
    expect(state.memoCount()).toBe(64);
    expect(state.attemptOf('b-1')?.attempt).not.toBeNull();
  });

  it('a partial reservation discarded with the ids reserve was handed returns the one it took', async () => {
    await twoNotices();
    const a = await built('b-1');
    const other = await built('b-2');
    const [n1, n2] = a.includedNoticeIds;
    // b-2 takes n2 first.
    expect(state.provider.reserve!({ boundaryId: 'b-2', claimToken: 'x', includedNoticeIds: [n2], body: other.body })?.includedNoticeIds).toEqual([n2]);
    const ra = state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'a', includedNoticeIds: [n1, n2], body: a.body })!;
    expect(ra.includedNoticeIds).toEqual([n1]);
    expect(ra.body).not.toContain(`id=${n2}`);
    // The omitted count says one more entry is not seen (review P3-3).
    const omittedOf = (body: string) => Number(/^omitted=(\d+)/.exec(body.split('\n')[3])![1]);
    expect(omittedOf(ra.body)).toBe(omittedOf(a.body) + 1);
    expect(bytes(ra.body)).toBeLessThan(bytes(a.body));
    expect(noticeState(n1)).toBe('reserved');
    // The claim failed: D1 answers discarded with what it handed to reserve.
    state.settle({ boundaryId: 'b-1', outcome: 'discarded', includedNoticeIds: [n1, n2] });
    expect(noticeState(n1)).toBe('pending');
    expect(state.attemptOf('b-1')).toBeUndefined();
  });

  it('a body without notices counts nothing: reserve without a memo, then discarded with no ids', async () => {
    expect(state.provider.reserve!({ boundaryId: 'b-9', claimToken: 'z', includedNoticeIds: [], body: 'unknown' })).toBeNull();
    state.settle({ boundaryId: 'b-9', outcome: 'discarded', includedNoticeIds: [] });
    expect(state.attemptOf('b-9')).toBeUndefined();
  });

  it('negative: not_sent returns the notices, and the next send reserves them again', async () => {
    await twoNotices();
    const a = await built();
    const ra = state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'a', includedNoticeIds: a.includedNoticeIds, body: a.body })!;
    state.settle({ boundaryId: 'b-1', outcome: 'not_sent', includedNoticeIds: ra.includedNoticeIds });
    for (const id of ra.includedNoticeIds) expect(noticeState(id)).toBe('pending');
    const again = await built();
    expect(state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'b', includedNoticeIds: again.includedNoticeIds, body: again.body })).not.toBeNull();
  });

  it('negative: attempts of two boundaries settle on their own', async () => {
    await twoNotices();
    const a = await built('b-1');
    const b = await built('b-2');
    const [n1, n2] = a.includedNoticeIds;
    state.provider.reserve!({ boundaryId: 'b-1', claimToken: 'a', includedNoticeIds: [n1], body: a.body });
    state.provider.reserve!({ boundaryId: 'b-2', claimToken: 'b', includedNoticeIds: [n2], body: b.body });
    state.settle({ boundaryId: 'b-2', outcome: 'sent', includedNoticeIds: [n2] });
    expect(noticeState(n2)).toBe('acknowledged');
    expect(noticeState(n1)).toBe('reserved');
  });
});

describe('I15 one deadline from the start', () => {
  const counting = () => {
    const calls = { n: 0 };
    const reader: BriefSourceReader = () => {
      calls.n += 1;
      return { status: 'ok', items: [] };
    };
    return { calls, reader };
  };

  it.each([
    ['never returns', () => new Promise<never>(() => undefined)],
    ['returns after the deadline', () => new Promise<typeof world.head>((resolve) => setTimeout(() => resolve(world.head), 2_000))],
  ])('the membership %s: throws by 1,700 ms, no source read, no memo', async (_name, observe) => {
    vi.useFakeTimers();
    const spy = counting();
    const provider = createMemBriefProvider(() => world.db, {
      ...world.briefDeps({ readers: { state: spy.reader, relay: spy.reader } }),
      target: { ...world.deps(), observe },
      now: () => Date.now(),
    });
    let settled: unknown = 'pending';
    const started = Date.now();
    Promise.resolve(provider.provider.build(request())).then(
      () => (settled = 'resolved'),
      (error: unknown) => (settled = error)
    );
    await vi.advanceTimersByTimeAsync(1_700);
    expect(settled).toBeInstanceOf(BriefDeadlineExpiredError);
    expect(Date.now() - started).toBeLessThanOrEqual(1_700);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spy.calls.n).toBe(0);
    expect(provider.memoCount()).toBe(0);
  });

  it('a slow membership (900 ms) and a source that never answers: built by 1,700 ms, that source timeout, the rest there', async () => {
    vi.useFakeTimers();
    const slow = [900];
    const provider = createMemBriefProvider(() => world.db, {
      ...world.briefDeps({ readers: { verify: () => new Promise(() => undefined) } }),
      target: { ...world.deps(), observe: () => new Promise((resolve) => setTimeout(() => resolve(world.head), slow.shift() ?? 0)) },
      now: () => Date.now(),
    });
    let result: { body: string } | null = null;
    Promise.resolve(provider.provider.build(request())).then(
      (built: { body: string }) => (result = built),
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(1_700);
    expect(result).not.toBeNull();
    expect(result!.body).toContain('[6] src=verify unavailable=timeout');
    expect(result!.body).toContain('src=state');
  });
});
