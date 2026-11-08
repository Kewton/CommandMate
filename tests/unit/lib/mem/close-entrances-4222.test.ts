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
import { memAcknowledgeNotice, memCheck, memList } from '@/lib/mem/service';
import type { MemTargetResolved } from '@/lib/mem/target';
import type { MemListResponse } from '@/types/mem';
import { MemWorld } from './mem-4222-harness';

const MEM_DB = path.join(process.cwd(), 'src/lib/db/mem-db.ts');
const MEM_CLOSE_DB = path.join(process.cwd(), 'src/lib/db/mem-close-db.ts');
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

const ROWS: Record<string, Row> = {
  'condition-close via check': evaluation('check'),
  'condition-close via list': evaluation('list'),
  reserve: {
    writers: ['reserveNotices'],
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
  'human acknowledge': {
    writers: ['acknowledgeNoticeByHuman'],
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
