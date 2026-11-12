/**
 * Every entrance of the hand-off keeps the invariants (Issue #4227 G-PR2, design
 * `mem-ui-4227.md` §7.4 and its table of entrances): one table, each invariant run over
 * every row it applies to.
 *
 * - the table names every exported function of `src/lib/handoff/**` that reaches a write of
 *   `handoff-db` (read off the source, so a new way in fails here until it has a row);
 * - H6 the screen's mark: a screen entrance without it is 403 and writes nothing; the
 *   agent's entrances and the read need none (negative control);
 * - H2 the mode: `off` refuses the entrances that need `on` (nothing written); cancel, end,
 *   the observation and the read still work (negative control);
 * - H1 a re-created worktree (a new conversation): the old request's entrances are refused
 *   or record `session_changed`; nothing of the new generation and no item changes (H1a);
 *   the old request is `expired(session_changed)` (H1b) — except a declared stop, which its
 *   observation ends as `unconfirmed(session_changed)`;
 * - H3 the request's version: an `ifVersion` one below is 409 `version_conflict`, nothing written;
 * - H15(d) / H8 nothing kills: tmux's and every tool's `killSession` are counted (0) across
 *   every entrance and a read past the deadline;
 * - H7 unattended (`popup` off): no request is made.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const kills = vi.hoisted(() => ({ tmux: 0, tool: 0 }));
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killSession: async () => {
    kills.tmux += 1;
    return true;
  },
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        killSession: async () => {
          kills.tool += 1;
        },
        isRunning: async () => false,
      }),
    }),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { getHandoffRequest } from '@/lib/db/handoff-db';
import { memUpdateItem } from '@/lib/mem/service';
import { handoffCancel, handoffCreate, handoffExtend, handoffRead, handoffSendFailed, handoffSent } from '@/lib/handoff/request';
import { handoffDone, handoffPropose, handoffRebase } from '@/lib/handoff/proposals';
import { handoffDecide } from '@/lib/handoff/decide';
import { handoffEnd, handoffObserve } from '@/lib/handoff/end';
import { HANDOFF_REQUEST_TTL_MS, type HandoffReadResponse } from '@/lib/handoff/types';
import { codeOf, makeHandoffWorld, plainRequest, screenRequest, WT, type HandoffWorld } from './handoff-harness';

type Req = ReturnType<typeof screenRequest>;
type Outcome = { status: number; body: unknown };
interface Ctx {
  rid: string;
  version: number;
  proposalId?: string;
  fingerprint?: string;
  endToken?: string;
}

interface Entrance {
  fn: string;
  /** Needs the screen's mark (H6). */
  screen: boolean;
  /** Refuses unless the branch is `on` (H2). */
  mode: boolean;
  /** Takes the request's `ifVersion` (H3). */
  versioned: boolean;
  prepare: () => Promise<Ctx | null>;
  call: (ctx: Ctx | null, request: Req, versionShift?: number) => Promise<Outcome> | Outcome;
  ok: number;
}

let w: HandoffWorld;
const read = (rid: string) => handoffRead(w.db, WT, rid, w.deps()).body as HandoffReadResponse;
const created = async (): Promise<Ctx> => {
  const body = await w.create();
  return { rid: body.request.id, version: body.request.version };
};
const withVersion = (ctx: Ctx): Ctx => ({ ...ctx, version: read(ctx.rid).request.version });

async function reviewing(): Promise<Ctx> {
  const ctx = await created();
  const proposal = await w.propose(ctx.rid, { op: 'add', kind: 'note', text: 'proposed' });
  await w.done(ctx.rid);
  return withVersion({ ...ctx, proposalId: proposal.id, fingerprint: proposal.fingerprint });
}

async function inConflict(): Promise<Ctx> {
  const note = await w.addNote('base');
  const ctx = await created();
  const proposal = await w.propose(ctx.rid, { op: 'update', itemId: note.id, baseVersion: note.version, text: 'mine' });
  await w.done(ctx.rid);
  await memUpdateItem(w.db, WT, note.id, { instanceId: 'claude', ifVersion: note.version, text: 'theirs' }, w.deps());
  await handoffDecide(w.db, screenRequest(), WT, ctx.rid, { ifVersion: read(ctx.rid).request.version, decisions: [{ proposalId: proposal.id, fingerprint: proposal.fingerprint, action: 'approve' }] }, w.deps());
  const conflict = read(ctx.rid).proposals[0];
  expect(conflict.state).toBe('conflict');
  return withVersion({ ...ctx, proposalId: proposal.id, fingerprint: conflict.fingerprint });
}

async function declared(): Promise<Ctx> {
  const ctx = await created();
  await w.done(ctx.rid);
  const ended = handoffEnd(w.db, screenRequest(), WT, ctx.rid, { ifVersion: read(ctx.rid).request.version }, w.deps());
  return withVersion({ ...ctx, endToken: (ended.body as { endToken: string }).endToken });
}

const ENTRANCES: Record<string, Entrance> = {
  create: {
    fn: 'handoffCreate',
    screen: true,
    mode: true,
    versioned: false,
    prepare: async () => null,
    call: (_ctx, request) => handoffCreate(w.db, request, WT, { instanceId: 'claude' }, w.deps()),
    ok: 201,
  },
  read: {
    fn: 'handoffRead',
    screen: false,
    mode: false,
    versioned: false,
    prepare: created,
    call: (ctx) => handoffRead(w.db, WT, ctx!.rid, w.deps()),
    ok: 200,
  },
  sent: {
    fn: 'handoffSent',
    screen: true,
    mode: true,
    versioned: false,
    prepare: created,
    call: (ctx, request) => handoffSent(w.db, request, WT, ctx!.rid, w.deps()),
    ok: 200,
  },
  'send-failed': {
    fn: 'handoffSendFailed',
    screen: true,
    mode: true,
    versioned: false,
    prepare: created,
    call: (ctx, request) => handoffSendFailed(w.db, request, WT, ctx!.rid, w.deps()),
    ok: 200,
  },
  extend: {
    fn: 'handoffExtend',
    screen: true,
    mode: true,
    versioned: true,
    prepare: created,
    call: (ctx, request, shift = 0) => handoffExtend(w.db, request, WT, ctx!.rid, { ifVersion: ctx!.version + shift }, w.deps()),
    ok: 200,
  },
  cancel: {
    fn: 'handoffCancel',
    screen: true,
    mode: false,
    versioned: false,
    prepare: created,
    call: (ctx, request) => handoffCancel(w.db, request, WT, ctx!.rid, w.deps()),
    ok: 200,
  },
  propose: {
    fn: 'handoffPropose',
    screen: false,
    mode: true,
    versioned: false,
    prepare: created,
    call: (ctx) => handoffPropose(w.db, WT, ctx!.rid, { instanceId: 'claude', op: 'add', kind: 'note', text: 'a proposal' }, w.deps()),
    ok: 201,
  },
  done: {
    fn: 'handoffDone',
    screen: false,
    mode: true,
    versioned: false,
    prepare: created,
    call: (ctx) => handoffDone(w.db, WT, ctx!.rid, { instanceId: 'claude' }, w.deps()),
    ok: 200,
  },
  decide: {
    fn: 'handoffDecide',
    screen: true,
    mode: true,
    versioned: true,
    prepare: reviewing,
    call: (ctx, request, shift = 0) =>
      handoffDecide(
        w.db,
        request,
        WT,
        ctx!.rid,
        { ifVersion: ctx!.version + shift, decisions: [{ proposalId: ctx!.proposalId!, fingerprint: ctx!.fingerprint!, action: 'approve' }] },
        w.deps()
      ),
    ok: 200,
  },
  rebase: {
    fn: 'handoffRebase',
    screen: true,
    mode: true,
    versioned: true,
    prepare: inConflict,
    call: (ctx, request, shift = 0) =>
      handoffRebase(w.db, request, WT, ctx!.rid, ctx!.proposalId!, { ifVersion: ctx!.version + shift, fingerprint: ctx!.fingerprint! }, w.deps()),
    ok: 200,
  },
  end: {
    fn: 'handoffEnd',
    screen: true,
    mode: false,
    versioned: true,
    prepare: async () => {
      const ctx = await created();
      await w.done(ctx.rid);
      return withVersion(ctx);
    },
    call: (ctx, request, shift = 0) => handoffEnd(w.db, request, WT, ctx!.rid, { ifVersion: ctx!.version + shift }, w.deps()),
    ok: 200,
  },
  'end-observe': {
    fn: 'handoffObserve',
    screen: true,
    mode: false,
    versioned: false,
    prepare: declared,
    call: (ctx, request) => handoffObserve(w.db, request, WT, ctx!.rid, { endToken: ctx!.endToken }, { running: false }, w.deps()),
    ok: 200,
  },
};

/** Exported helpers every entrance runs, not entrances of their own (the table's "読みに伴う期限の判定"). */
const INTERNAL: Record<string, string> = {
  judgeRequest: 'the judgement made whenever a request is read or written (expiry, a changed session); run by every row',
  expireRequest: 'what judgeRequest writes when it ends a request; run by every row through it',
};

const HANDOFF_DIR = path.join(process.cwd(), 'src/lib/handoff');
const HANDOFF_DB = path.join(process.cwd(), 'src/lib/db/handoff-db.ts');

interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}
function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({ name: match[2] ?? match[3], exported: Boolean(match[1]), body: source.slice(match.index, starts[i + 1]?.index ?? source.length) }));
}
const calls = (body: string, names: Set<string>) => [...names].some((name) => new RegExp(`\\b${name}\\(`).test(body));
function closure(chunks: Chunk[], seed: (chunk: Chunk) => boolean): Set<string> {
  const found = new Set(chunks.filter(seed).map((chunk) => chunk.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of chunks) {
      if (!found.has(chunk.name) && calls(chunk.body.slice(chunk.body.indexOf('{')), found)) {
        found.add(chunk.name);
        grew = true;
      }
    }
  }
  return found;
}
export function handoffWriters(dbSource: string): Set<string> {
  const chunks = chunksOf(dbSource);
  const writes = closure(chunks, (chunk) => /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body));
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}
export function handoffEntrancesOf(sources: string[], writers: Set<string>): string[] {
  const chunks = sources.flatMap(chunksOf);
  const reach = closure(chunks, (chunk) => calls(chunk.body, writers));
  return chunks.filter((chunk) => chunk.exported && reach.has(chunk.name)).map((chunk) => chunk.name).sort();
}
const handoffSources = () =>
  readdirSync(HANDOFF_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(path.join(HANDOFF_DIR, name), 'utf8'));

beforeEach(() => {
  w = makeHandoffWorld('handoff-entrances-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
  kills.tmux = 0;
  kills.tool = 0;
});
afterEach(() => w.close());

const KEYS = Object.keys(ENTRANCES);

describe('[#4227] the table of the hand-off’s entrances', () => {
  it('names every entrance (a new export that writes fails here until it has a row)', () => {
    const writers = handoffWriters(readFileSync(HANDOFF_DB, 'utf8'));
    for (const known of ['insertHandoffRequest', 'changeHandoffRequest', 'insertHandoffProposal', 'raiseEndForced', 'consumeApprovalMark']) {
      expect(writers.has(known)).toBe(true);
    }
    const expected = [...new Set([...Object.values(ENTRANCES).map((entry) => entry.fn), ...Object.keys(INTERNAL)])].sort();
    expect(handoffEntrancesOf(handoffSources(), writers)).toEqual(expected);
  });

  it('(positive control) a new export that writes, directly or through a helper, is found', () => {
    const writers = handoffWriters(readFileSync(HANDOFF_DB, 'utf8'));
    const extra = 'function sneakHelper(db) {\n  raiseEndForced(db, "x", true);\n}\nexport function handoffSneak(db) {\n  sneakHelper(db);\n}\n';
    expect(handoffEntrancesOf([...handoffSources(), extra], writers)).toContain('handoffSneak');
    const reader = 'export function handoffPeek(db) {\n  return getHandoffRequest(db, "x");\n}\n';
    expect(handoffEntrancesOf([...handoffSources(), reader], writers)).not.toContain('handoffPeek');
  });
});

describe('[#4227] H6: the screen’s mark', () => {
  it.each(KEYS.filter((key) => ENTRANCES[key].screen))('%s without the mark → 403 screen_only, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    const before = w.snapshot();
    const outcome = await entry.call(ctx, plainRequest());
    expect(outcome.status).toBe(403);
    expect(codeOf(outcome)).toBe('screen_only');
    expect(w.snapshot()).toBe(before);
  });

  it.each(KEYS)('%s (control) as its caller makes it → it goes through', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    const outcome = await entry.call(ctx, entry.screen ? screenRequest() : plainRequest());
    expect(outcome.status).toBe(entry.ok);
  });
});

describe('[#4227] H2: the mode', () => {
  it.each(KEYS.filter((key) => ENTRANCES[key].mode))('%s with the branch off → 409 disabled, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    w.setMode('off', true);
    const before = w.snapshot();
    const outcome = await entry.call(ctx, screenRequest());
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('disabled');
    expect(w.snapshot()).toBe(before);
  });

  it.each(KEYS.filter((key) => !ENTRANCES[key].mode))('%s with the branch off (negative control) → still taken', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    w.setMode('off', true);
    const outcome = await entry.call(ctx, screenRequest());
    expect(outcome.status).toBe(entry.ok);
  });
});

describe('[#4227] H1: a new conversation (the worktree made again under the same id and path)', () => {
  it.each(KEYS.filter((key) => key !== 'create'))('%s of the old request: refused or recorded as session_changed; nothing of the new generation changes', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    w.recreateWorktree();
    // The new generation's own request (it judges the old one first).
    const fresh = await w.create();
    const newRow = JSON.stringify(getHandoffRequest(w.db, fresh.request.id));
    const items = w.itemsSnapshot();
    const outcome = await entry.call(ctx, screenRequest());
    // H1a: no item, and nothing of the new generation's request.
    expect(w.itemsSnapshot()).toBe(items);
    expect(JSON.stringify(getHandoffRequest(w.db, fresh.request.id))).toBe(newRow);
    const old = getHandoffRequest(w.db, ctx!.rid)!;
    if (key === 'end-observe') {
      // The stop was declared: its observation records how it ended.
      expect(outcome.status).toBe(200);
      expect(old).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'session_changed' });
      return;
    }
    if (key === 'read') expect(outcome.status).toBe(200);
    else {
      expect(outcome.status).toBe(409);
      expect(codeOf(outcome)).toBe('session_changed');
    }
    // H1b: the old request ended as expired(session_changed).
    expect(old).toMatchObject({ state: 'expired', outcomeReason: 'session_changed' });
  });

  it('create: the worktree made again while git answers → refused, no open request of the old lifetime', async () => {
    const hold = w.arm();
    const pending = handoffCreate(w.db, screenRequest(), WT, { instanceId: 'claude' }, w.deps());
    await hold.reached;
    w.recreateWorktree();
    hold.release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(w.count("SELECT COUNT(*) n FROM mem_handoff_requests WHERE state IN ('awaiting_agent','reviewing','applying')")).toBe(0);
  });

  it('(negative control) the worktree left alone → the old request’s entrances go on', async () => {
    const ctx = await created();
    expect((await handoffPropose(w.db, WT, ctx.rid, { instanceId: 'claude', op: 'add', kind: 'note', text: 'kept' }, w.deps())).status).toBe(201);
    expect(read(ctx.rid).request.state).toBe('awaiting_agent');
  });
});

describe('[#4227] H3: the request’s version', () => {
  it.each(KEYS.filter((key) => ENTRANCES[key].versioned))('%s with ifVersion one below → 409 version_conflict, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    const before = w.snapshot();
    const outcome = await entry.call(ctx, screenRequest(), -1);
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('version_conflict');
    expect(w.snapshot()).toBe(before);
  });
});

describe('[#4227] H15(d)・H8: nothing of the hand-off kills', () => {
  it.each(KEYS)('%s calls no kill (tmux’s or a tool’s)', async (key) => {
    const entry = ENTRANCES[key];
    const ctx = await entry.prepare();
    await entry.call(ctx, screenRequest());
    await entry.call(ctx, screenRequest(), 0);
    expect(kills).toEqual({ tmux: 0, tool: 0 });
  });

  it('a read past the request’s deadline ends it (expired) and kills nothing', async () => {
    const ctx = await created();
    w.clock.now += HANDOFF_REQUEST_TTL_MS + 1;
    expect(read(ctx.rid).request.state).toBe('expired');
    expect(kills).toEqual({ tmux: 0, tool: 0 });
  });
});

describe('[#4227] H7: unattended (popup off) makes no request', () => {
  it('popup off → 409 unattended, nothing made; popup on (control) → made', async () => {
    w.setMode('on', false);
    const outcome = await handoffCreate(w.db, screenRequest(), WT, { instanceId: 'claude' }, w.deps());
    expect(codeOf(outcome)).toBe('unattended');
    expect(w.count('SELECT COUNT(*) n FROM mem_handoff_requests')).toBe(0);
    w.setMode('on', true);
    expect((await handoffCreate(w.db, screenRequest(), WT, { instanceId: 'claude' }, w.deps())).status).toBe(201);
  });
});
