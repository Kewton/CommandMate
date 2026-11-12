/**
 * G9 (#4227 G-PR5): `handoff propose` checks `--close-when` as `mem add` does. The same value gets the same
 * answer from both, in a repository with an origin and in one without (a `pr:#12` was accepted by propose and
 * refused only at the confirmation). Driven by a table: kind × value × origin.
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

import { memAddItem } from '@/lib/mem/service';
import { handoffDone, handoffPropose } from '@/lib/handoff/proposals';
import { handoffDecide } from '@/lib/handoff/decide';
import { handoffRead } from '@/lib/handoff/request';
import type { HandoffDecideResponse, HandoffReadResponse } from '@/lib/handoff/types';
import { makeHandoffWorld, screenRequest, SHA, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;
let openRequestId: string | null;
/** The one open request of the test (a second `create` is refused while it is open). */
async function requestId(): Promise<string> {
  openRequestId ??= (await w.create()).request.id;
  return openRequestId;
}
beforeEach(() => {
  openRequestId = null;
  w = makeHandoffWorld('handoff-cw-entrance-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

const KINDS = ['waiting', 'note', 'decision'] as const;
const VALUES: Array<string | undefined> = [
  undefined,
  'manual',
  'at:2026-12-01T10:00:00+09:00',
  'pr:#12',
  'issue:#7',
  'pr:Kewton/CommandMate#12',
  'branch:feature/x:merged',
  'nonsense',
];
const ORIGINS: Array<{ name: string; url: string | null }> = [
  { name: 'origin', url: 'git@github.com:Kewton/CommandMate.git' },
  { name: 'no-origin', url: null },
];

interface Answer {
  ok: boolean;
  code?: string;
  reason?: string;
}
const answerOf = (outcome: { status: number; body: unknown }): Answer => {
  const body = outcome.body as { code?: string; reason?: string };
  return outcome.status < 300 ? { ok: true } : { ok: false, code: body.code, reason: body.reason };
};

async function bothAnswers(kind: string, closeWhen: string | undefined, url: string | null): Promise<{ propose: Answer; add: Answer }> {
  const deps = { ...w.deps(), git: { originUrl: async () => url, refTip: async () => SHA } };
  const created = { request: { id: await requestId() } };
  const base = { instanceId: 'claude', kind, text: `t-${kind}`, ...(closeWhen === undefined ? {} : { closeWhen }) };
  const propose = answerOf(await handoffPropose(w.db, WT, created.request.id, { op: 'add', ...base }, deps));
  const add = answerOf(await memAddItem(w.db, WT, base, deps));
  return { propose, add };
}

describe('[#4227 G9] propose and mem add check --close-when alike', () => {
  for (const origin of ORIGINS) {
    for (const kind of KINDS) {
      for (const value of VALUES) {
        it(`${kind} / ${value ?? '(omitted)'} / ${origin.name}: same answer`, async () => {
          const { propose, add } = await bothAnswers(kind, value, origin.url);
          expect(propose).toEqual(add);
        });
      }
    }
  }

  it('(positive) pr:#12 with no origin is refused by propose as invalid_close_when, like mem add', async () => {
    const { propose, add } = await bothAnswers('waiting', 'pr:#12', null);
    expect(add.ok).toBe(false);
    expect(propose.ok).toBe(false);
    expect(propose.code).toBe('invalid_close_when');
    expect(w.count('SELECT COUNT(*) AS n FROM mem_handoff_proposals')).toBe(0);
  });

  it('(control) pr:#12 with an origin is accepted by propose and by mem add', async () => {
    const { propose, add } = await bothAnswers('waiting', 'pr:#12', 'git@github.com:Kewton/CommandMate.git');
    expect(propose.ok).toBe(true);
    expect(add.ok).toBe(true);
    expect(w.count('SELECT COUNT(*) AS n FROM mem_handoff_proposals')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// codex P2-1: values that pass the syntax, so that git's ref questions are reached
// ---------------------------------------------------------------------------

const ORIGIN_URL = 'git@github.com:Kewton/CommandMate.git';
/** What the refs answer: a local branch only, a remote-tracking one only, both, none. */
const REF_STATES: Array<{ name: string; tipOf: (ref: string) => string | null }> = [
  { name: 'local+remote', tipOf: () => SHA },
  { name: 'local-only', tipOf: (ref) => (ref.startsWith('refs/heads/') ? SHA : null) },
  { name: 'remote-only', tipOf: (ref) => (ref.startsWith('refs/remotes/origin/') ? SHA : null) },
  { name: 'no-ref', tipOf: () => null },
];
const REF_VALUES = [
  'branch:feature/x?merged=develop',
  'branch:feature/x?merged=develop&scope=remote',
  'branch:feature/x?deleted',
  'branch:feature/x?deleted&scope=remote',
  'pr:github.com/Kewton/CommandMate#12',
  'pr:github.com/Kewton/CommandMate#12?state=closed',
  'issue:github.com/Kewton/CommandMate#7',
];

async function bothAnswersWithRefs(kind: string, closeWhen: string, tipOf: (ref: string) => string | null): Promise<{ propose: Answer; add: Answer }> {
  const deps = { ...w.deps(), git: { originUrl: async () => ORIGIN_URL, refTip: async (_path: string, ref: string) => tipOf(ref) } };
  const created = { request: { id: await requestId() } };
  const base = { instanceId: 'claude', kind, text: `t-${kind}`, closeWhen };
  const propose = answerOf(await handoffPropose(w.db, WT, created.request.id, { op: 'add', ...base }, deps));
  const add = answerOf(await memAddItem(w.db, WT, base, deps));
  return { propose, add };
}

describe('[#4227 G9] (codex P2-1) valid branch / fully named values reach git’s ref questions', () => {
  for (const state of REF_STATES) {
    for (const value of REF_VALUES) {
      it(`waiting / ${value} / ${state.name}: same answer`, async () => {
        const { propose, add } = await bothAnswersWithRefs('waiting', value, state.tipOf);
        expect(propose).toEqual(add);
      });
    }
  }

  it('(reached) merged with no ref is refused, with a ref accepted: the value passes the syntax and git decides', async () => {
    const none = await bothAnswersWithRefs('waiting', 'branch:feature/x?merged=develop', () => null);
    const some = await bothAnswersWithRefs('waiting', 'branch:feature/x?merged=develop', () => SHA);
    expect(none.propose).toMatchObject({ ok: false, code: 'invalid_close_when' });
    expect(some.propose).toEqual({ ok: true });
  });

  it('(reached) merged scope=remote is found from the remote ref, falling back to the local one', async () => {
    const remote = await bothAnswersWithRefs('waiting', 'branch:feature/x?merged=develop&scope=remote', REF_STATES[2].tipOf);
    const local = await bothAnswersWithRefs('waiting', 'branch:feature/x?merged=develop&scope=remote', REF_STATES[1].tipOf);
    expect(remote.propose).toEqual({ ok: true });
    expect(local.propose).toEqual({ ok: true });
    const localScope = await bothAnswersWithRefs('waiting', 'branch:feature/x?merged=develop', REF_STATES[2].tipOf);
    expect(localScope.propose).toMatchObject({ ok: false });
  });

  it('(control) a fully named PR needs no origin, in propose and in mem add', async () => {
    const deps = { ...w.deps(), git: { originUrl: async () => null, refTip: async () => SHA } };
    const created = await w.create();
    const base = { instanceId: 'claude', kind: 'waiting', text: 't', closeWhen: 'pr:github.com/Kewton/CommandMate#12' };
    expect(answerOf(await handoffPropose(w.db, WT, created.request.id, { op: 'add', ...base }, deps))).toEqual({ ok: true });
    expect(answerOf(await memAddItem(w.db, WT, base, deps))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// codex P2-2: through to the confirmation (the original symptom: accepted, then dropped at the decide)
// ---------------------------------------------------------------------------

const storedCloseWhen = (text: string): string | null =>
  (w.db.prepare('SELECT close_when AS c FROM mem_items WHERE text = ?').get(text) as { c: string | null } | undefined)?.c ?? null;

describe('[#4227 G9] (codex P2-2) propose → done → approve → decide → applied, the stored condition is the proposed one', () => {
  const read = (rid: string) => handoffRead(w.db, WT, rid, w.deps()).body as HandoffReadResponse;

  it('(control) pr:#12 with an origin goes through to the stored item, equal to what mem add stores', async () => {
    const deps = { ...w.deps(), git: { originUrl: async () => ORIGIN_URL, refTip: async () => SHA } };
    const created = await w.create();
    const rid = created.request.id;
    const proposed = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'add', kind: 'waiting', text: 'via-handoff', closeWhen: 'pr:#12' }, deps);
    expect(proposed.status).toBe(201);
    const proposal = (proposed.body as { proposal: { id: string; fingerprint: string } }).proposal;
    expect((await handoffDone(w.db, WT, rid, { instanceId: 'claude' }, deps)).status).toBe(200);
    const decided = await handoffDecide(
      w.db,
      screenRequest(),
      WT,
      rid,
      { ifVersion: read(rid).request.version, decisions: [{ proposalId: proposal.id, fingerprint: proposal.fingerprint, action: 'approve' }] },
      deps
    );
    expect((decided.body as HandoffDecideResponse).results).toEqual([{ proposalId: proposal.id, result: 'applied' }]);

    await memAddItem(w.db, WT, { instanceId: 'claude', kind: 'waiting', text: 'via-mem-add', closeWhen: 'pr:#12' }, deps);
    const stored = storedCloseWhen('via-handoff');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({ type: 'pr', host: 'github.com', owner: 'Kewton', repo: 'CommandMate', number: 12, state: 'merged' });
    expect(stored).toEqual(storedCloseWhen('via-mem-add'));
  });

  it('(positive) pr:#12 with no origin is refused at propose; nothing reaches the decide, nothing is stored', async () => {
    const deps = { ...w.deps(), git: { originUrl: async () => null, refTip: async () => SHA } };
    const created = await w.create();
    const rid = created.request.id;
    const proposed = await handoffPropose(w.db, WT, rid, { instanceId: 'claude', op: 'add', kind: 'waiting', text: 'via-handoff', closeWhen: 'pr:#12' }, deps);
    expect(answerOf(proposed)).toMatchObject({ ok: false, code: 'invalid_close_when' });
    expect((await handoffDone(w.db, WT, rid, { instanceId: 'claude' }, deps)).status).toBe(200);
    expect(read(rid).proposals ?? []).toHaveLength(0);
    expect(w.count('SELECT COUNT(*) AS n FROM mem_handoff_proposals')).toBe(0);
    expect(storedCloseWhen('via-handoff')).toBeNull();
  });
});
