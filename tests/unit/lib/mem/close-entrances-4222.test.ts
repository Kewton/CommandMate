/**
 * The invariants every way into what #4222 writes keeps (Issue #4222, PM decision of
 * the contract; the same shape as `write-entrances-recreate-4221.test.ts`):
 *
 * (a) a request read before the worktree was deleted and made again under the same id
 *     and path is refused — nothing is closed, reserved or acknowledged;
 * (b) while the mode is `off` / `derived`, nothing is evaluated, closed, noticed or
 *     acknowledged;
 * (c) a version (or state) that changed under the request refuses it.
 *
 * The table is checked against the store itself: every exported function of
 * `src/lib/db/mem-db.ts` and `src/lib/db/mem-close-db.ts` that INSERT / UPDATE / DELETE
 * (directly or through its own helpers) is a row's writer, or a named exception with
 * its reason. A new write fails the first test until it has a row.
 *
 * The ways in are checked too (integration review P2-3): every exported function of the
 * public layer (`src/lib/mem/evaluate.ts`, `src/lib/mem/notices.ts`) that reaches a
 * writer is a row's `entrance`, and every function elsewhere in `src/` that calls one of
 * those entrances is a row's `callers` entry. A new entrance, or a new caller of an
 * existing one (the brief, the preview), fails here until a row runs (a)〜(c) through it.
 * The public layer is read as one source, so a chain across its files (a new export of
 * `notices.ts` calling `evaluateMemConditions`) is an entrance too (re-review P2).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import {
  captureMemRecipient,
  listMemNoticesFor,
  reserveMemNotices,
  settleMemNoticeAttempt,
} from '@/lib/mem/notices';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { evaluateMemConditions, fixMemEvalLifetime, type MemEvalContext } from '@/lib/mem/evaluate';
import { memAcknowledgeNotice, memCheck, memList } from '@/lib/mem/service';
import type { MemTargetResolved } from '@/lib/mem/target';
import type { MemListResponse } from '@/types/mem';
import { getInstanceIncarnation } from '@/lib/mem/incarnation';
import { briefForRoute } from '@/lib/brief/service';
import { createMemBriefProvider } from '@/lib/brief/provider';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { MemWorld } from './mem-4222-harness';

const MEM_DB = path.join(process.cwd(), 'src/lib/db/mem-db.ts');
const MEM_CLOSE_DB = path.join(process.cwd(), 'src/lib/db/mem-close-db.ts');
/** The public layer: the only files that may call the writers (the test "no way around"). */
const PUBLIC_LAYER = ['src/lib/mem/evaluate.ts', 'src/lib/mem/notices.ts'];
const PAST = 'at:2020-01-01T00:00+00:00';

interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}

function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({
    name: match[2] ?? match[3],
    exported: Boolean(match[1]),
    body: source.slice(match.index, starts[i + 1]?.index ?? source.length),
  }));
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

/** Exported functions of a store source that write (SQL), directly or through its helpers or another writer. */
function storeWriters(source: string, outside: Set<string> = new Set()): Set<string> {
  const chunks = chunksOf(source);
  const writes = closure(chunks, (chunk) => /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body) || calls(chunk.body.slice(chunk.body.indexOf('{')), outside));
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}

function allWriters(memDb = readFileSync(MEM_DB, 'utf8'), memCloseDb = readFileSync(MEM_CLOSE_DB, 'utf8')): string[] {
  const a = storeWriters(memDb);
  const b = storeWriters(memCloseDb, a);
  return [...new Set([...a, ...b])].sort();
}

/** Exported functions of a source that reach (call, directly or through its own helpers) one of `targets`. */
function reachers(source: string, targets: Set<string>): Set<string> {
  const chunks = chunksOf(source);
  const found = closure(chunks, (chunk) => calls(chunk.body.slice(chunk.body.indexOf('{')), targets));
  return new Set(chunks.filter((chunk) => chunk.exported && found.has(chunk.name)).map((chunk) => chunk.name));
}

const codeLines = (source: string) => source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

/** The public layer's exported functions that reach a writer of the table. */
/**
 * The public layer's exported functions that reach a writer of the table, across its
 * files (re-review P2): the layer is read as one source, so a function of
 * `notices.ts` that calls `evaluateMemConditions` of `evaluate.ts` (directly or through
 * a helper of either file) is an entrance too, and needs its own row.
 */
function publicEntrances(writers: Set<string>, sources: Record<string, string> = readAll(PUBLIC_LAYER)): string[] {
  return [...reachers(Object.values(sources).join('\n'), writers)].sort();
}

const rowEntrances = () => [...new Set(Object.values(ROWS).map((row) => row.entrance))].sort();

/**
 * Who calls the public entrances, as `file:function` (exported, or reaching one through
 * a helper). A file that calls one where no top-level function can be named (a class
 * method, a default export) is `file:<unattributed>`, which no row can claim.
 */
function entranceCallers(entrances: Set<string>, sources: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    if (!calls(codeLines(source), entrances)) continue;
    const named = reachers(source, entrances);
    if (named.size === 0) out.push(`${file}:<unattributed>`);
    for (const name of named) out.push(`${file}:${name}`);
  }
  return out.sort();
}

function readAll(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file, readFileSync(path.join(process.cwd(), file), 'utf8')]));
}

/** Every source of `src/` outside the store and the public layer. */
function callerSources(): Record<string, string> {
  const skip = new Set([MEM_DB, MEM_CLOSE_DB, ...PUBLIC_LAYER.map((file) => path.join(process.cwd(), file))]);
  return readAll(
    sourcesUnder(path.join(process.cwd(), 'src'))
      .filter((file) => !skip.has(file))
      .map((file) => path.relative(process.cwd(), file))
  );
}

/** Writers of #4221's entrances and settings: fixed by `write-entrances-recreate-4221.test.ts` and the screen-only guard. */
const EXCEPTIONS: Record<string, string> = {
  saveMemSettings: '#4221 の設定の書き込み（画面だけ、mem-mode-write-screen-only が固定。項目・知らせを書かない）',
  saveMemBranchOverride: '#4221 の設定の書き込み（同上）',
  deleteMemBranchOverride: '#4221 の設定の書き込み（同上）',
  nextSlotVersion: '#4221 の枠の版の数（項目・知らせを書かない。呼び手は A の入口）',
  archiveNowSlots: '#4221 の roster の削除の前の退避（A の §10.4、roster の書き手から呼ばれる）',
  createMemItem: '#4221 の入口（write-entrances-recreate-4221 が (a)〜(c) を固定）',
  replaceNowSlot: '#4221 の入口（同上）',
  updateMemItem: '#4221 の入口（同上）',
  closeMemItem: '#4221 の入口（同上）',
  writeScreenNote: '#4221 の入口（同上）',
  purgeMem: '#4221 の入口（同上。知らせは CASCADE で項目と一緒に消える）',
};

const world = new MemWorld();
let boot = 'boot-1';
const clock = () => ({ bootId: () => boot });

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
const recipient = () => captureMemRecipient(world.db, 'wt-1', 'claude', target());
const pick = () => listMemNoticesFor(world.db, recipient(), clock()).map((n) => ({ noticeId: n.id, uncertain: n.uncertain }));
const recreate = () => {
  deleteWorktreesByIds(world.db, ['wt-1']);
  world.worktree('wt-1');
};
const closedCount = () => world.count("SELECT COUNT(*) n FROM mem_items WHERE state = 'closed'");
const writtenB = () =>
  world.count('SELECT COUNT(*) n FROM mem_close_records') +
  world.count('SELECT COUNT(*) n FROM mem_notices') +
  world.count('SELECT COUNT(*) n FROM mem_notice_attempts');
const noticeState = () => (world.db.prepare('SELECT state FROM mem_notices').get() as { state: string } | undefined)?.state;
const noticeRow = () => world.db.prepare('SELECT id, version FROM mem_notices').get() as { id: string; version: number };

/** Close one item by its condition, as a check does (the set-up of the notice rows). */
async function closedOne(): Promise<void> {
  await world.add('next', PAST);
  expect((await memCheck(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps())).status).toBe(200);
  expect(noticeState()).toBe('pending');
}

interface Row {
  /** The store writers this entrance reaches. */
  writers: string[];
  /** The public layer's function the row goes through (evaluate.ts / notices.ts). */
  entrance: string;
  /** The functions elsewhere in `src/` that call the entrance and are run by this row, as `file:function`. */
  callers: string[];
  /** (a): the request is read, the worktree deleted and made again, then the request lands. */
  recreated: (() => Promise<void>) | { exempt: string };
  /** (b): run in `off` and in `derived`; nothing of #4222 may be written. */
  modeOff: (mode: 'off' | 'derived') => Promise<void>;
  /** (c): the version / state changed under the request. */
  conflict: () => Promise<void>;
}

const evaluation = (via: 'check' | 'list'): Row => {
  const run = () =>
    via === 'check'
      ? memCheck(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps())
      : memList(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps());
  return {
    writers: ['closeItemByCondition', 'closeMemItemByCondition'],
    entrance: 'evaluateMemConditions',
    callers: [via === 'check' ? 'src/lib/mem/service.ts:memCheck' : 'src/lib/mem/service.ts:memList'],
    recreated: async () => {
      await world.add('next', PAST);
      const release = world.arm();
      const pending = run();
      await Promise.resolve();
      recreate();
      release();
      await pending;
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    modeOff: async (mode) => {
      await world.add('next', PAST);
      world.setMode(mode);
      const outcome = await run();
      if (via === 'check' || mode === 'off') expect(outcome.status).toBe(409);
      else expect((outcome.body as MemListResponse).conditions).toBeUndefined();
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    conflict: async () => {
      // The version changes while the condition's query is out (the await the snapshot spans).
      const item = await world.add('next', 'issue:#1');
      world.fake.handler = () => {
        world.db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(item.id);
        return { code: 0, stdout: JSON.stringify({ state: 'closed', state_reason: 'completed' }) };
      };
      await run();
      expect(world.fake.calls.length).toBeGreaterThan(0);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
  };
};

const ISSUE_CLOSED = () => ({ code: 0, stdout: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
const openCount = () => world.count("SELECT COUNT(*) n FROM mem_items WHERE state != 'closed'");

/** The public evaluation as the brief (#4223) and the preview (#4227) will call it: the lifetime fixed first. */
function evaluateDirectly(trigger: 'brief' | 'preview', overrides: Partial<MemEvalContext> = {}, mode: 'on' | 'off' | 'derived' = 'on') {
  const lifetime = fixMemEvalLifetime(world.db, { via: 'worktree', worktreeId: 'wt-1' });
  return (run: () => void = () => undefined) => {
    run();
    return evaluateMemConditions(world.db, { ...target(), mode, worktree: getWorktreeById(world.db, 'wt-1') }, {
      trigger,
      lifetime,
      deps: { exec: world.fake.exec },
      ...overrides,
    });
  };
}

/** The brief's route (#4223): `buildBrief` evaluates through `evaluateMemConditions`. */
function briefRoute() {
  const deps = world.deps();
  return briefForRoute(
    world.db,
    'wt-1',
    { instance: 'claude', budget: null, format: 'json', all: '1' },
    { target: deps, evaluation: deps.evaluation }
  );
}

/** The brief's provider (#4223): `reserve` and `settleBriefAttempt` reach #4222's reservation and receipt. */
function briefProvider() {
  const deps = world.deps();
  return createMemBriefProvider(() => world.db, { target: deps, evaluation: deps.evaluation, notices: clock() });
}

function briefRequest(boundaryId = 'b-1'): BriefRequest {
  return {
    target: {
      worktreeId: 'wt-1',
      cliToolId: 'claude',
      instanceId: 'claude',
      instanceIncarnation: getInstanceIncarnation(world.db, 'wt-1', 'claude')?.incarnation ?? null,
    },
    membership: { repositoryId: world.repo, readRepositoryIds: [world.repo], branch: 'feature/x', detached: false, mode: 'on' },
    boundary: { id: boundaryId, kind: 'launch', late: false, openedAt: Date.now() },
    budget: { maxBytes: 4096, maxLines: 240 },
    now: Date.now(),
  };
}

/** Build a brief with the pending notice in it, and reserve it as D1's claim would. */
async function briefReserved(provider: ReturnType<typeof briefProvider>, boundaryId = 'b-1') {
  const built = await provider.provider.build(briefRequest(boundaryId));
  expect(built.includedNoticeIds).toHaveLength(1);
  return { built, reserve: () => provider.provider.reserve!({ boundaryId, claimToken: `t-${boundaryId}`, includedNoticeIds: built.includedNoticeIds, body: built.body }) };
}
const attemptCount = () => world.count('SELECT COUNT(*) n FROM mem_notice_attempts');

const ROWS: Record<string, Row> = {
  'condition-close via check': evaluation('check'),
  'condition-close via list': evaluation('list'),
  'condition-close via evaluateMemConditions (brief / preview)': {
    writers: ['closeItemByCondition', 'closeMemItemByCondition'],
    entrance: 'evaluateMemConditions',
    callers: [],
    recreated: async () => {
      // The worktree is deleted and made again while the condition's query is out.
      await world.add('next', 'issue:#1');
      const start = evaluateDirectly('brief');
      world.fake.handler = () => {
        recreate();
        return ISSUE_CLOSED();
      };
      const report = await start();
      expect(world.fake.calls.length).toBeGreaterThan(0);
      expect(report.results.map((result) => result.condition.result)).toEqual(['met']);
      expect(openCount()).toBe(1);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    modeOff: async (mode) => {
      await world.add('next', PAST);
      world.setMode(mode);
      const report = await evaluateDirectly('preview', {}, mode)();
      expect(report.evaluated).toBe(false);
      expect(world.fake.calls).toEqual([]);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    conflict: async () => {
      const item = await world.add('next', 'issue:#1');
      world.fake.handler = () => {
        world.db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(item.id);
        return ISSUE_CLOSED();
      };
      await evaluateDirectly('brief')();
      expect(world.fake.calls.length).toBeGreaterThan(0);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
  },
  reserve: {
    writers: ['reserveNotices'],
    entrance: 'reserveMemNotices',
    callers: [],
    recreated: async () => {
      await closedOne();
      const r = recipient();
      const selection = pick();
      recreate();
      expect(reserveMemNotices(world.db, r, selection, clock())).toEqual({ attemptId: null, reserved: [] });
      expect(noticeState()).toBe('pending');
      expect(world.count('SELECT COUNT(*) n FROM mem_notice_attempts')).toBe(0);
    },
    modeOff: async (mode) => {
      await closedOne();
      const selection = pick();
      world.setMode(mode);
      expect(reserveMemNotices(world.db, recipient(), selection, clock())).toEqual({ attemptId: null, reserved: [] });
      expect(world.count('SELECT COUNT(*) n FROM mem_notice_attempts')).toBe(0);
    },
    conflict: async () => {
      await closedOne();
      const selection = pick();
      expect(reserveMemNotices(world.db, recipient(), selection, clock()).attemptId).not.toBeNull();
      // The same notice, already taken by the first brief.
      expect(reserveMemNotices(world.db, recipient(), selection, clock())).toEqual({ attemptId: null, reserved: [] });
    },
  },
  settle: {
    writers: ['settleNoticeAttempt'],
    entrance: 'settleMemNoticeAttempt',
    callers: [],
    recreated: async () => {
      await closedOne();
      const attempt = reserveMemNotices(world.db, recipient(), pick(), clock()).attemptId!;
      recreate();
      settleMemNoticeAttempt(world.db, attempt, 'sent', clock());
      expect(noticeState()).toBe('pending');
    },
    modeOff: async (mode) => {
      await closedOne();
      const attempt = reserveMemNotices(world.db, recipient(), pick(), clock()).attemptId!;
      world.setMode(mode);
      settleMemNoticeAttempt(world.db, attempt, 'sent', clock());
      expect(noticeState()).toBe('pending');
    },
    conflict: async () => {
      await closedOne();
      const attempt = reserveMemNotices(world.db, recipient(), pick(), clock()).attemptId!;
      expect(settleMemNoticeAttempt(world.db, attempt, 'not-sent', clock())).toBe(1);
      expect(settleMemNoticeAttempt(world.db, attempt, 'sent', clock())).toBe(0);
      expect(noticeState()).toBe('pending');
    },
  },
  'condition-close via the brief (buildBrief, #4223)': {
    writers: ['closeItemByCondition', 'closeMemItemByCondition'],
    entrance: 'evaluateMemConditions',
    callers: ['src/lib/brief/build.ts:buildBrief'],
    recreated: async () => {
      // The worktree is deleted and made again once, while the first build's query is out
      // (review P1 2026-11-09: a rebuild must not carry the request to the new worktree).
      await world.add('next', 'issue:#1');
      let first = true;
      world.fake.handler = () => {
        if (first) recreate();
        first = false;
        return ISSUE_CLOSED();
      };
      const outcome = await briefRoute();
      expect(world.fake.calls.length).toBe(1);
      expect(outcome.status).toBe(404);
      expect(openCount()).toBe(1);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    modeOff: async (mode) => {
      await world.add('next', PAST);
      world.setMode(mode);
      const outcome = await briefRoute();
      if (mode === 'off') expect(outcome.status).toBe(409);
      else expect(outcome.body).toMatchObject({ mode: 'derived' });
      expect(world.fake.calls).toEqual([]);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    conflict: async () => {
      const item = await world.add('next', 'issue:#1');
      world.fake.handler = () => {
        world.db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(item.id);
        return ISSUE_CLOSED();
      };
      await briefRoute();
      expect(world.fake.calls.length).toBeGreaterThan(0);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
  },
  'reserve via the brief provider (#4223)': {
    writers: ['reserveNotices'],
    entrance: 'reserveMemNotices',
    callers: ['src/lib/brief/provider.ts:createMemBriefProvider'],
    recreated: async () => {
      await closedOne();
      const { reserve } = await briefReserved(briefProvider());
      recreate();
      expect(reserve()).toBeNull();
      expect(noticeState()).toBe('pending');
      expect(attemptCount()).toBe(0);
    },
    modeOff: async (mode) => {
      await closedOne();
      const provider = briefProvider();
      const { reserve } = await briefReserved(provider);
      world.setMode(mode);
      expect(reserve()).toBeNull();
      expect(attemptCount()).toBe(0);
      // Built in that mode, the brief carries no notice at all.
      const built = await Promise.resolve(provider.provider.build({ ...briefRequest('b-2'), membership: { ...briefRequest().membership, mode: 'derived' } })).catch(() => null);
      expect(built?.includedNoticeIds ?? []).toEqual([]);
      expect(noticeState()).toBe('pending');
      expect(attemptCount()).toBe(0);
    },
    conflict: async () => {
      await closedOne();
      const provider = briefProvider();
      const first = await briefReserved(provider, 'b-1');
      const second = await briefReserved(provider, 'b-2');
      expect(first.reserve()).not.toBeNull();
      // The same notice, already taken by the first brief.
      expect(second.reserve()).toBeNull();
      expect(noticeState()).toBe('reserved');
      expect(attemptCount()).toBe(1);
    },
  },
  'settle via the brief provider (#4223)': {
    writers: ['settleNoticeAttempt'],
    entrance: 'settleMemNoticeAttempt',
    // The caller is createMemBriefProvider's settle, claimed by the reserve row above.
    callers: [],
    recreated: async () => {
      await closedOne();
      const provider = briefProvider();
      const reserved = (await briefReserved(provider)).reserve()!;
      recreate();
      provider.settle({ boundaryId: 'b-1', outcome: 'sent', includedNoticeIds: reserved.includedNoticeIds });
      expect(noticeState()).toBe('pending');
    },
    modeOff: async (mode) => {
      await closedOne();
      const provider = briefProvider();
      const reserved = (await briefReserved(provider)).reserve()!;
      world.setMode(mode);
      provider.settle({ boundaryId: 'b-1', outcome: 'sent', includedNoticeIds: reserved.includedNoticeIds });
      expect(noticeState()).toBe('pending');
    },
    conflict: async () => {
      await closedOne();
      const provider = briefProvider();
      const reserved = (await briefReserved(provider)).reserve()!;
      provider.settle({ boundaryId: 'b-1', outcome: 'not_sent', includedNoticeIds: reserved.includedNoticeIds });
      expect(noticeState()).toBe('pending');
      // A late `sent` for the attempt already settled acknowledges nothing.
      provider.settle({ boundaryId: 'b-1', outcome: 'sent', includedNoticeIds: reserved.includedNoticeIds });
      expect(noticeState()).toBe('pending');
    },
  },
  'human acknowledge': {
    writers: ['acknowledgeNoticeByHuman'],
    entrance: 'acknowledgeMemNoticeByHuman',
    callers: ['src/lib/mem/service.ts:memAcknowledgeNotice'],
    recreated: { exempt: '画面の経路で worktree を経ない（要求は知らせの ID と版で結び、版の照合 (c) が古い要求を断る）' },
    modeOff: async (mode) => {
      await closedOne();
      const row = noticeRow();
      world.setMode(mode);
      const outcome = await memAcknowledgeNotice(world.db, world.repo, row.id, { ifVersion: row.version }, world.deps());
      expect(outcome.status).toBe(409);
      expect(noticeState()).toBe('pending');
    },
    conflict: async () => {
      await closedOne();
      const row = noticeRow();
      const outcome = await memAcknowledgeNotice(world.db, world.repo, row.id, { ifVersion: row.version + 1 }, world.deps());
      expect(outcome.status).toBe(409);
      expect(noticeState()).toBe('pending');
    },
  },
};

const tableWriters = () => [...new Set(Object.values(ROWS).flatMap((row) => row.writers))];

function sourcesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

beforeEach(() => {
  world.open('mem-entrances-4222-');
  world.worktree('wt-1');
  world.setMode('on');
  boot = 'boot-1';
});
afterEach(() => world.close());

describe('every write of #4222 keeps (a) re-creation, (b) mode, (c) version', () => {
  it('the table names every writer of the store (a new one fails here until it has a row or a reason)', () => {
    const writers = allWriters();
    for (const known of ['closeItemByCondition', 'reserveNotices', 'settleNoticeAttempt', 'acknowledgeNoticeByHuman', 'createMemItem']) {
      expect(writers).toContain(known);
    }
    expect(writers).toEqual([...new Set([...tableWriters(), ...Object.keys(EXCEPTIONS)])].sort());
    expect(tableWriters().filter((name) => name in EXCEPTIONS)).toEqual([]);
  });

  it('the check catches a new writer of the close store (and leaves a reader alone)', () => {
    const extra = `${readFileSync(MEM_CLOSE_DB, 'utf8')}\nexport function forgetNotices(db: Database.Database): void {\n  db.prepare('DELETE FROM mem_notices').run();\n}\n`;
    expect(allWriters(undefined, extra)).toContain('forgetNotices');
    const viaStore = `${readFileSync(MEM_CLOSE_DB, 'utf8')}\nexport function closeQuietly(db: Database.Database): void {\n  closeMemItemByCondition(db, 'x', { version: 1, closeWhen: null }, 0);\n}\n`;
    expect(allWriters(undefined, viaStore)).toContain('closeQuietly');
    const reader = `${readFileSync(MEM_CLOSE_DB, 'utf8')}\nexport function peek(db: Database.Database): unknown {\n  return db.prepare('SELECT 1').get();\n}\n`;
    expect(allWriters(undefined, reader)).not.toContain('peek');
  });

  it('no way around the entrances: the writers of #4222 are called from evaluate.ts and notices.ts only', () => {
    const pattern = /\b(closeItemByCondition|closeMemItemByCondition|reserveNotices|settleNoticeAttempt|acknowledgeNoticeByHuman)\(/;
    const callers = sourcesUnder(path.join(process.cwd(), 'src'))
      .filter((file) => file !== MEM_DB && file !== MEM_CLOSE_DB)
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => pattern.test(line) && !/^\s*(\/\/|\*)/.test(line)))
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(callers).toEqual(['src/lib/mem/evaluate.ts', 'src/lib/mem/notices.ts']);
  });

  it('integration review P2-3: every entrance of the public layer that reaches a writer is a row’s entrance', () => {
    const entrances = publicEntrances(new Set(tableWriters()));
    for (const known of ['evaluateMemConditions', 'reserveMemNotices', 'settleMemNoticeAttempt', 'acknowledgeMemNoticeByHuman']) {
      expect(entrances).toContain(known);
    }
    expect(entrances).toEqual(rowEntrances());
  });

  it('(control) re-review P2: a chain across the public layer\'s files is an entrance, and the table comparison fails on it', () => {
    const writers = new Set(tableWriters());
    const layer = readAll(PUBLIC_LAYER);
    expect(publicEntrances(writers, layer)).toEqual(rowEntrances());
    // A new export of notices.ts that evaluates (evaluate.ts's entrance), directly …
    const direct = {
      ...layer,
      'src/lib/mem/notices.ts': `${layer['src/lib/mem/notices.ts']}\nexport async function briefNotices(db: Database.Database, target: never) {\n  return evaluateMemConditions(db, target, { trigger: 'brief' } as never);\n}\n`,
    };
    expect(publicEntrances(writers, direct)).toContain('briefNotices');
    expect(publicEntrances(writers, direct)).not.toEqual(rowEntrances());
    // … or through a helper of notices.ts that calls a helper of evaluate.ts.
    const chained = {
      'src/lib/mem/evaluate.ts': `${layer['src/lib/mem/evaluate.ts']}\nfunction evaluateQuietly(db: Database.Database, target: never) {\n  return evaluateMemConditions(db, target, { trigger: 'preview' } as never);\n}\n`,
      'src/lib/mem/notices.ts': `${layer['src/lib/mem/notices.ts']}\nfunction previewOf(db: Database.Database) {\n  return evaluateQuietly(db, db as never);\n}\nexport function previewNotices(db: Database.Database) {\n  return previewOf(db);\n}\n`,
    };
    expect(publicEntrances(writers, chained)).toContain('previewNotices');
    expect(publicEntrances(writers, chained)).not.toEqual(rowEntrances());
    // (control) a new export of notices.ts that only reads is not an entrance.
    const reader = {
      ...layer,
      'src/lib/mem/notices.ts': `${layer['src/lib/mem/notices.ts']}\nexport function noticeCount(db: Database.Database): number {\n  return (db.prepare('SELECT COUNT(*) n FROM mem_notices').get() as { n: number }).n;\n}\n`,
    };
    expect(publicEntrances(writers, reader)).toEqual(rowEntrances());
  });

  it('integration review P2-3: every caller of those entrances elsewhere in src/ is run by a row', () => {
    const entrances = new Set(Object.values(ROWS).map((row) => row.entrance));
    expect(entranceCallers(entrances, callerSources())).toEqual(Object.values(ROWS).flatMap((row) => row.callers).sort());
  });

  it('(control) the entrance checks catch a new entrance, a new caller, and one in a class; a reader is left alone', () => {
    const writers = new Set(tableWriters());
    const layer = readAll(PUBLIC_LAYER);
    const extraEntrance = {
      ...layer,
      'src/lib/mem/evaluate.ts': `${layer['src/lib/mem/evaluate.ts']}\nfunction quiet(db: Database.Database): boolean {\n  return closeItemByCondition(db, {} as never);\n}\nexport function previewAndClose(db: Database.Database): boolean {\n  return quiet(db);\n}\n`,
    };
    expect(publicEntrances(writers, extraEntrance)).toContain('previewAndClose');
    const entrances = new Set(Object.values(ROWS).map((row) => row.entrance));
    const brief = {
      'src/lib/mem/brief.ts': `import { evaluateMemConditions } from './evaluate';\nexport async function buildBrief(db: Database.Database, target: never) {\n  return evaluateMemConditions(db, target, { trigger: 'brief' } as never);\n}\n`,
    };
    expect(entranceCallers(entrances, brief)).toEqual(['src/lib/mem/brief.ts:buildBrief']);
    const inClass = {
      'src/lib/mem/brief.ts': `export class Brief {\n  run(db: never) {\n    return evaluateMemConditions(db, db, db);\n  }\n}\n`,
    };
    expect(entranceCallers(entrances, inClass)).toEqual(['src/lib/mem/brief.ts:<unattributed>']);
    const reader = { 'src/lib/mem/brief.ts': `// evaluateMemConditions(db) is called by the brief\nexport const NOTE = 'evaluateMemConditions';\n` };
    expect(entranceCallers(entrances, reader)).toEqual([]);
  });

  it('integration review P2-3: the public evaluation refuses a worktree target without its lifetime fixed (nothing asked, nothing written)', async () => {
    await world.add('next', PAST);
    const wt = getWorktreeById(world.db, 'wt-1');
    const base = { ...target(), worktree: wt };
    const deps = { exec: world.fake.exec };
    const missing = await evaluateMemConditions(world.db, base, { trigger: 'brief', deps } as unknown as MemEvalContext);
    expect(missing.evaluated).toBe(false);
    world.worktree('wt-2');
    const other = await evaluateMemConditions(world.db, base, { trigger: 'brief', deps, lifetime: fixMemEvalLifetime(world.db, { via: 'worktree', worktreeId: 'wt-2' }) });
    expect(other.evaluated).toBe(false);
    const viaRepository = await evaluateMemConditions(world.db, base, { trigger: 'brief', deps, lifetime: { via: 'repository' } });
    expect(viaRepository.evaluated).toBe(false);
    expect(closedCount()).toBe(0);
    expect(writtenB()).toBe(0);
    // (control) its own lifetime, the worktree left alone → closed.
    const fixed = await evaluateDirectly('brief')();
    expect(fixed.evaluated).toBe(true);
    expect(closedCount()).toBe(1);
  });

  it('the writers of `issued_by` (S6): every call of startInstanceIncarnation names how it was issued', () => {
    const found: string[] = [];
    for (const file of sourcesUnder(path.join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bstartInstanceIncarnation\(([\s\S]*?)\);/g)) {
        if (/export function startInstanceIncarnation/.test(source.slice(Math.max(0, match.index - 20), match.index + 30))) continue;
        found.push(`${path.relative(process.cwd(), file)}:${/rosterIssue\(|'lazy'/.test(match[1]) ? 'named' : 'unnamed'}`);
      }
    }
    expect(found.sort()).toEqual([
      'src/lib/db/agent-instances-db.ts:named',
      'src/lib/db/agent-instances-db.ts:named',
      'src/lib/db/mem-db.ts:named',
    ]);
  });

  for (const [key, row] of Object.entries(ROWS)) {
    if (typeof row.recreated === 'function') {
      const run = row.recreated;
      it(`${key} (a): the worktree deleted and made again under the request → refused`, async () => run());
    } else {
      const reason = row.recreated.exempt;
      it(`${key} (a): exempt with a reason`, () => expect(reason.length).toBeGreaterThan(10));
    }
    it.each(['off', 'derived'] as const)(`${key} (b): mode %s → nothing of #4222 written`, async (mode) => row.modeOff(mode));
    it(`${key} (c): a changed version or state → refused`, async () => row.conflict());
  }

  it('(control) the worktree left alone and the mode on → the close, the reservation and the acknowledgement land', async () => {
    await closedOne();
    const reserved = reserveMemNotices(world.db, recipient(), pick(), clock());
    expect(reserved.attemptId).not.toBeNull();
    settleMemNoticeAttempt(world.db, reserved.attemptId!, 'sent', clock());
    expect(noticeState()).toBe('acknowledged');
  });
});
