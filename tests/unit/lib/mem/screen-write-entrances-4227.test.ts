/**
 * A person's writes from the screen (Issue #4227, design `mem-ui-4227.md` §0.0b S-A・S-D,
 * §7.4 H1a・H2・H3・H6・H11・H14・H16・H17): one table, every invariant run over every row.
 *
 * The rows are the screen's entrances (`screen-add`・`screen-update`・`screen-close`・
 * `screen-close-recorded`), the same keys as A's `ENTRANCES`
 * (`write-entrances-recreate-4221.test.ts`). The table is checked against the source
 * from the writing side: every exported function of the service that reaches the
 * versioned close (`closeMemItemVersioned`) must be `memWriteFromScreen`, and every op
 * of it must have a row — so a new way in fails here until it has one.
 *
 * Positive controls show that each check is what refuses: the same request made
 * through the store with a person's actor (which passes A's `ownedBy`), or through A's
 * agent entrance, lands where the screen's entrance refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { createRepository } from '@/lib/db/db-repository';
import { closeMemItem, getMemSettings, saveMemSettings, updateMemItem, type MemActor } from '@/lib/db/mem-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { readInstanceLifetime } from '@/lib/db/session-brief-db';
import { endInstanceIncarnation, getOrCreateWorktreeIncarnation, startInstanceIncarnation } from '@/lib/mem/incarnation';
import {
  memAddItem,
  memCloseItem,
  memSettleDecisionTransition,
  memWriteFromScreen,
  type MemScreenWriteInput,
  type MemServiceDeps,
} from '@/lib/mem/service';
import { memTransition } from '@/lib/mem/transitions';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { MEM_EXIT_BY_CODE, type MemBranchRule, type MemWriteResponse } from '@/types/mem';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-g';
const SERVICE = path.join(process.cwd(), 'src/lib/mem/service.ts');
const MEM_DB = path.join(process.cwd(), 'src/lib/db/mem-db.ts');

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
let branchNow: string;
let hold: { wait: Promise<void>; armed: boolean } | null;

function arm(): () => void {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  hold = { wait, armed: true };
  return release;
}
async function held(): Promise<void> {
  if (hold?.armed) {
    hold.armed = false;
    await hold.wait;
  }
}

const deps = (): MemServiceDeps => ({
  resolveCommonDir: async () => '/common/.git',
  pathExists: () => true,
  observe: async (): Promise<WorktreeHeadObservation> => {
    await held();
    // Read after the await: a HEAD moved while the request waited is what the target sees.
    return { branch: branchNow, detached: false, head: SHA, commonDir: '/common/.git', known: true };
  },
  git: { originUrl: async () => 'git@github.com:Kewton/CommandMate.git', refTip: async () => SHA },
});

const screenRequest = () => ({
  headers: new Headers({ 'X-CommandMate-Client': 'screen', origin: 'http://localhost', host: 'localhost' }),
  url: 'http://localhost/api/worktrees/wt-g/mem/screen/items',
});
/** The CLI's request: no mark. */
const plainRequest = () => ({ headers: new Headers({ host: 'localhost' }), url: 'http://localhost/api/worktrees/wt-g/mem/screen/items' });

const wtPath = () => path.join(dir, 'wt-g');
function makeWorktree(): void {
  mkdirSync(wtPath(), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(WT, WT, wtPath(), rootA);
}
function setRules(rules: MemBranchRule[]): void {
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules });
}
const setMode = (mode: 'off' | 'derived' | 'on') => setRules([{ match: 'glob', pattern: '**', mode }]);
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const itemIs = (where: string, ...params: unknown[]) => count(`SELECT COUNT(*) n FROM mem_items WHERE ${where}`, ...params) === 1;
const rowOf = (id: string) => db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as Record<string, unknown>;
const codeOf = (outcome: { body: unknown }) => (outcome.body as { code?: string }).code;

type Made = { id: string; version: number };

const agentAdd = async (body: Record<string, unknown>): Promise<Made> => {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', ...body }, deps());
  expect(outcome.status).toBe(201);
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
const addNote = (text: string) => agentAdd({ kind: 'note', text });
const recordedDecision = async (text: string): Promise<Made> => {
  const made = await agentAdd({ kind: 'decision', text, promoteTo: 'issue:#4227' });
  const outcome = await memSettleDecisionTransition(
    db,
    { worktreeId: WT, expectedWorktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT), itemId: made.id, expectedVersion: made.version, transition: 'record' },
    deps()
  );
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};

const write = (input: Omit<MemScreenWriteInput, 'body'> & { body: Record<string, unknown> }, request = screenRequest()) =>
  memWriteFromScreen(db, request, WT, { ...input, body: { instanceId: 'claude', ...input.body } }, deps());

interface ScreenEntrance {
  op: MemScreenWriteInput['op'];
  before?: () => Promise<Made>;
  body: (made: Made | undefined) => Record<string, unknown>;
  /** The request's write is in the store. */
  landed: (made: Made | undefined) => boolean;
  /** Nothing of the request is in the store (the row as it was before). */
  untouched: (made: Made | undefined) => boolean;
  /** Has an item whose version is compared (H3). `add` has none: a key makes it idempotent instead. */
  versioned: boolean;
}

const unchanged = (made: Made | undefined) => itemIs("id = ? AND version = ? AND state = 'open'", made!.id, made!.version);

const SCREEN_ENTRANCES: Record<string, ScreenEntrance> = {
  'screen-add': {
    op: 'add',
    body: () => ({ kind: 'note', text: 'screen add', key: 'screen-add-1', expectBranch: 'feature/x' }),
    landed: () => itemIs("text = 'screen add' AND created_by = 'human' AND branch = 'feature/x'"),
    untouched: () => count("SELECT COUNT(*) n FROM mem_items WHERE text = 'screen add'") === 0,
    versioned: false,
  },
  'screen-update': {
    op: 'update',
    before: () => addNote('to update'),
    body: (made) => ({ ifVersion: made!.version, text: 'screen updated' }),
    landed: (made) => itemIs("id = ? AND text = 'screen updated' AND updated_by = 'human'", made!.id),
    untouched: unchanged,
    versioned: true,
  },
  'screen-close': {
    op: 'close',
    before: () => addNote('to close'),
    body: (made) => ({ ifVersion: made!.version }),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND close_reason = 'manual' AND updated_by = 'human'", made!.id),
    untouched: unchanged,
    versioned: true,
  },
  'screen-close-recorded': {
    op: 'close',
    before: () => recordedDecision('to withdraw'),
    body: (made) => ({ ifVersion: made!.version, confirmUnreflected: true }),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND close_reason = 'withdrawn' AND updated_by = 'human'", made!.id),
    untouched: (made) => itemIs("id = ? AND state = 'recorded' AND version = ?", made!.id, made!.version),
    versioned: true,
  },
};
const KEYS = Object.keys(SCREEN_ENTRANCES);
const VERSIONED = KEYS.filter((key) => SCREEN_ENTRANCES[key].versioned);
const ON_ITEMS = KEYS.filter((key) => SCREEN_ENTRANCES[key].op !== 'add');

const run = (key: string, made: Made | undefined, request = screenRequest()) => {
  const entry = SCREEN_ENTRANCES[key];
  return write({ op: entry.op, author: 'human', ...(made ? { itemId: made.id } : {}), body: entry.body(made) }, request);
};

/** Prepare a row: the worktree, mode `on`, its item. */
async function prepare(key: string): Promise<Made | undefined> {
  makeWorktree();
  setMode('on');
  return SCREEN_ENTRANCES[key].before?.();
}

beforeEach(() => {
  dir = makeTempDir('mem-screen-4227-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  branchNow = 'feature/x';
  hold = null;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

// ---------------------------------------------------------------------------
// The table and the source
// ---------------------------------------------------------------------------

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
const callsAny = (body: string, names: Set<string>) => [...names].some((name) => new RegExp(`\\b${name}\\(`).test(body));
function closure(chunks: Chunk[], seed: (chunk: Chunk) => boolean): Set<string> {
  const found = new Set(chunks.filter(seed).map((chunk) => chunk.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of chunks) {
      if (!found.has(chunk.name) && callsAny(chunk.body.slice(chunk.body.indexOf('{')), found)) {
        found.add(chunk.name);
        grew = true;
      }
    }
  }
  return found;
}
/** Exported functions of a service source that reach the versioned close (directly or through helpers). */
function versionedCloseEntrances(serviceSource: string): string[] {
  const chunks = chunksOf(serviceSource);
  const reach = closure(chunks, (chunk) => /\bcloseMemItemVersioned\(/.test(chunk.body));
  return chunks.filter((chunk) => chunk.exported && reach.has(chunk.name)).map((chunk) => chunk.name).sort();
}
/** The ops `memWriteFromScreen` dispatches on, read from its type. */
function screenOps(serviceSource: string): string[] {
  const match = /export type MemScreenWriteOp = ([^;]+);/.exec(serviceSource);
  return match ? [...match[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort() : [];
}

describe('the table of the screen’s entrances (Issue #4227)', () => {
  let fixtures: string;
  beforeEach(() => {
    fixtures = mkdtempSync(path.join(os.tmpdir(), 'mem-screen-src-4227-'));
  });
  afterEach(() => {
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('names every way to the versioned close and every op of the screen’s entrance', () => {
    const service = readFileSync(SERVICE, 'utf8');
    expect(versionedCloseEntrances(service)).toEqual(['memWriteFromScreen']);
    const ops = new Set(Object.values(SCREEN_ENTRANCES).map((entry) => entry.op));
    expect([...ops].sort()).toEqual(screenOps(service));
    expect(screenOps(service)).toEqual(['add', 'close', 'update']);
    // The recorded close is its own row (S-D), not hidden in `screen-close`.
    expect(KEYS).toContain('screen-close-recorded');
    // The versioned close is a write of the store that the check follows.
    expect(/export function closeMemItemVersioned[\s\S]*?UPDATE mem_items/.test(readFileSync(MEM_DB, 'utf8'))).toBe(true);
  });

  it('(positive control) a new export that closes around the table is caught, directly or through a helper', () => {
    const service = readFileSync(SERVICE, 'utf8');
    const direct = path.join(fixtures, 'direct.ts');
    writeFileSync(direct, `${service}\nexport function memSneakClose(db: Database.Database): void {\n  closeMemItemVersioned(db, actor, 'x', { ifVersion: 1, reason: null, transition: 'withdraw-recorded' });\n}\n`);
    expect(versionedCloseEntrances(readFileSync(direct, 'utf8'))).toEqual(['memSneakClose', 'memWriteFromScreen']);
    const helper = path.join(fixtures, 'helper.ts');
    writeFileSync(helper, `${service}\nfunction sneak(db: Database.Database): void {\n  closeMemItemVersioned(db, actor, 'x', { ifVersion: 1, reason: null, transition: 'close' });\n}\nexport function memSneakAll(db: Database.Database): void {\n  sneak(db);\n}\n`);
    expect(versionedCloseEntrances(readFileSync(helper, 'utf8'))).toContain('memSneakAll');
    // A new op of the entrance without a row is caught too.
    const op = path.join(fixtures, 'op.ts');
    writeFileSync(op, service.replace("export type MemScreenWriteOp = 'add' | 'update' | 'close';", "export type MemScreenWriteOp = 'add' | 'update' | 'close' | 'purge';"));
    expect(screenOps(readFileSync(op, 'utf8'))).not.toEqual([...new Set(Object.values(SCREEN_ENTRANCES).map((entry) => entry.op))].sort());
    // (negative control) a read-only export is not a way in.
    const reader = path.join(fixtures, 'reader.ts');
    writeFileSync(reader, `${service}\nexport function memPeek(db: Database.Database): unknown {\n  return getMemRecord(db, 'x');\n}\n`);
    expect(versionedCloseEntrances(readFileSync(reader, 'utf8'))).toEqual(['memWriteFromScreen']);
  });
});

// ---------------------------------------------------------------------------
// The invariants, per row
// ---------------------------------------------------------------------------

describe('every screen entrance keeps the invariants (Issue #4227, S-A)', () => {
  it.each(KEYS)('%s (control): mode on, nothing changed → lands as the person', async (key) => {
    const made = await prepare(key);
    const outcome = await run(key, made);
    expect(outcome.status).toBeLessThan(300);
    expect(SCREEN_ENTRANCES[key].landed(made)).toBe(true);
  });

  it.each(KEYS)('%s: without the screen’s mark → 403 screen_only, nothing written (H6, in the service)', async (key) => {
    const made = await prepare(key);
    const outcome = await run(key, made, plainRequest());
    expect(outcome.status).toBe(403);
    expect(codeOf(outcome)).toBe('screen_only');
    expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
  });

  it.each(KEYS.flatMap((key) => [[key, 'off'] as const, [key, 'derived'] as const]))(
    '%s with the branch %s → 409 disabled, nothing written (H2)',
    async (key, mode) => {
      const made = await prepare(key);
      setMode(mode);
      const outcome = await run(key, made);
      expect(outcome.status).toBe(409);
      expect(codeOf(outcome)).toBe('disabled');
      expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
    }
  );

  it.each(KEYS.flatMap((key) => [[key, 'off'] as const, [key, 'derived'] as const]))(
    '%s: the mode turns %s while the request waits → 409 disabled (decided in the final stretch)',
    async (key, mode) => {
      const made = await prepare(key);
      const release = arm();
      const pending = run(key, made);
      await Promise.resolve();
      setMode(mode);
      release();
      const outcome = await pending;
      expect(codeOf(outcome)).toBe('disabled');
      expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
    }
  );

  it.each(KEYS)('%s: the worktree deleted and made again (same id and path) during the await → 409 incarnation_changed (H1a・H14(b))', async (key) => {
    const made = await prepare(key);
    const release = arm();
    const pending = run(key, made);
    await Promise.resolve();
    deleteWorktreesByIds(db, [WT]);
    makeWorktree();
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('incarnation_changed');
    expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
  });

  it.each(KEYS)('%s: the instance removed and added again (a new roster incarnation) during the await → 409 incarnation_changed', async (key) => {
    const made = await prepare(key);
    const release = arm();
    const pending = run(key, made);
    await Promise.resolve();
    endInstanceIncarnation(db, WT, 'claude');
    startInstanceIncarnation(db, WT, 'claude', 'claude', Date.now(), 'roster');
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('incarnation_changed');
    expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
  });

  it.each(VERSIONED)('%s: a version one below the current → 409 version_conflict with the item now, nothing written (H3)', async (key) => {
    const made = await prepare(key);
    const outcome = await run(key, { ...made!, version: made!.version - 1 });
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('version_conflict');
    expect((outcome.body as { item?: { version: number } }).item?.version).toBe(made!.version);
    expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
  });

  it.each(VERSIONED)('%s: someone writes the item (version + 1) while the request waits → 409 version_conflict, their value kept (H3・H16(a))', async (key) => {
    const made = await prepare(key);
    const release = arm();
    const pending = run(key, made);
    await Promise.resolve();
    db.prepare("UPDATE mem_items SET version = version + 1, text = 'theirs' WHERE id = ?").run(made!.id);
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('version_conflict');
    expect(itemIs("id = ? AND text = 'theirs' AND version = ?", made!.id, made!.version + 1)).toBe(true);
    expect(SCREEN_ENTRANCES[key].landed(made)).toBe(false);
  });

  it.each(ON_ITEMS)('%s: an item of another branch (off) through this worktree’s on route → 409 membership_changed, unchanged (H14(a))', async (key) => {
    makeWorktree();
    setMode('on');
    branchNow = 'feature/y';
    const made = await SCREEN_ENTRANCES[key].before!();
    branchNow = 'feature/x';
    setRules([
      { match: 'glob', pattern: 'feature/y', mode: 'off' },
      { match: 'glob', pattern: '**', mode: 'on' },
    ]);
    const outcome = await run(key, made);
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('membership_changed');
    expect(SCREEN_ENTRANCES[key].untouched(made)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Positive controls: the store with a person's actor, and A's agent entrance
// ---------------------------------------------------------------------------

describe('(positive controls) without the screen entrance’s checks the write would land', () => {
  const humanActor = (): MemActor => ({
    worktreeId: WT,
    instanceId: 'claude',
    cliToolId: 'claude',
    capturedIncarnation: null,
    sessionGeneration: null,
    by: 'human',
  });

  it('the store lets a person update an item after the worktree was made again (so the lifetime is the entrance’s to ask)', async () => {
    makeWorktree();
    setMode('on');
    const made = await addNote('store control');
    deleteWorktreesByIds(db, [WT]);
    makeWorktree();
    const result = updateMemItem(db, humanActor(), made.id, made.version, { text: 'landed anyway' });
    expect(result.ok).toBe(true);
  });

  it('the store lets a person update an item of another branch (so the branch is the entrance’s to ask)', async () => {
    makeWorktree();
    setMode('on');
    branchNow = 'feature/y';
    const made = await addNote('other branch');
    const result = updateMemItem(db, humanActor(), made.id, made.version, { text: 'landed on y' });
    expect(result.ok).toBe(true);
  });

  it('A’s agent add writes to the branch HEAD moved to during the await (so `expectBranch` is what refuses it)', async () => {
    makeWorktree();
    setMode('on');
    const release = arm();
    const pending = memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'moved add' }, deps());
    await Promise.resolve();
    branchNow = 'feature/y';
    release();
    expect((await pending).status).toBe(201);
    expect(itemIs("text = 'moved add' AND branch = 'feature/y'")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The branch of the request (S-A (iv)), the lifetimes (iii), `now` and the decision
// ---------------------------------------------------------------------------

describe('the branch asked for and the lifetime (S-A (iii)・(iv))', () => {
  it('the screen’s add: HEAD moves to another on branch during the await → 409 membership_changed, no row on either (H14(e))', async () => {
    makeWorktree();
    setMode('on');
    const release = arm();
    const pending = run('screen-add', undefined);
    await Promise.resolve();
    branchNow = 'feature/y';
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('membership_changed');
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });

  it('a pinned membership (the hand-off’s request): HEAD moves during the await → 409 membership_changed, no row (H14(d))', async () => {
    makeWorktree();
    setMode('on');
    const pin = {
      worktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT),
      instanceLifetime: readInstanceLifetime(db, WT, 'claude'),
      membership: { repositoryId: repoA, branch: 'feature/x', detached: false },
    };
    const release = arm();
    const pending = write({ op: 'add', author: 'proposer', pin, body: { kind: 'note', text: 'pinned add', key: 'pinned-1' } });
    await Promise.resolve();
    branchNow = 'feature/y';
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('membership_changed');
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    // (control) HEAD back on the pinned branch: the proposal lands, written as the agent.
    branchNow = 'feature/x';
    const landed = await write({ op: 'add', author: 'proposer', pin, body: { kind: 'note', text: 'pinned add', key: 'pinned-2' } });
    expect(landed.status).toBe(201);
    expect(itemIs("text = 'pinned add' AND created_by = 'agent' AND branch = 'feature/x'")).toBe(true);
  });

  it('a lawful null → lazy issue (A’s first write) between the read and the write is not refused (H14(c))', async () => {
    makeWorktree();
    setMode('on');
    const made = await addNote('before any incarnation');
    // The instance has no incarnation when the person's request is read (a primary never written by mem since).
    endInstanceIncarnation(db, WT, 'claude');
    expect(readInstanceLifetime(db, WT, 'claude').incarnation).toBeNull();
    const release = arm();
    const pending = run('screen-update', made);
    await Promise.resolve();
    // A's agent write issues the derived primary's incarnation (`lazy`) while the screen waits.
    const agent = memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'first agent write' }, deps());
    expect((await agent).status).toBe(201);
    expect(readInstanceLifetime(db, WT, 'claude').incarnationIssuedBy).toBe('lazy');
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(201);
    expect(SCREEN_ENTRANCES['screen-update'].landed(made)).toBe(true);
  });

  it('(positive control) the same wait with a roster issue (a remove and re-add) in between is refused', async () => {
    makeWorktree();
    setMode('on');
    const made = await addNote('before any incarnation');
    endInstanceIncarnation(db, WT, 'claude');
    const release = arm();
    const pending = run('screen-update', made);
    await Promise.resolve();
    startInstanceIncarnation(db, WT, 'claude', 'claude', Date.now(), 'roster');
    release();
    expect(codeOf(await pending)).toBe('incarnation_changed');
    expect(itemIs("id = ? AND text = 'before any incarnation'", made.id)).toBe(true);
  });

  it('a fence that answers false writes nothing (asked in the same transaction)', async () => {
    makeWorktree();
    setMode('on');
    const made = await addNote('fenced');
    const outcome = await write({ op: 'update', author: 'human', itemId: made.id, fence: () => false, body: { ifVersion: made.version, text: 'never' } });
    expect(codeOf(outcome)).toBe('fenced');
    expect(itemIs("id = ? AND text = 'fenced' AND version = ?", made.id, made.version)).toBe(true);
  });

  it('the screen’s add must name its branch (expectBranch), and the same key twice is one item', async () => {
    makeWorktree();
    setMode('on');
    const missing = await write({ op: 'add', author: 'human', body: { kind: 'note', text: 'no branch', key: 'k-1' } });
    expect(missing.status).toBe(400);
    const first = await run('screen-add', undefined);
    const again = await run('screen-add', undefined);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((again.body as MemWriteResponse).replayed).toBe(true);
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE text = 'screen add'")).toBe(1);
  });
});

describe('`now` stays the #2427 note’s (H17)', () => {
  it('add of kind now → 400, nothing written', async () => {
    makeWorktree();
    setMode('on');
    const outcome = await write({ op: 'add', author: 'human', body: { kind: 'now', text: 'n', key: 'k-now', expectBranch: 'feature/x' } });
    expect(outcome.status).toBe(400);
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });
});

describe('a recorded decision and the close (S-D, H11・H16)', () => {
  it('without confirmUnreflected → 409 confirmation_required, still recorded', async () => {
    makeWorktree();
    setMode('on');
    const made = await recordedDecision('needs confirm');
    const outcome = await write({ op: 'close', author: 'human', itemId: made.id, body: { ifVersion: made.version } });
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('confirmation_required');
    expect(itemIs("id = ? AND state = 'recorded' AND version = ?", made.id, made.version)).toBe(true);
  });

  it('the CLI’s `mem close` still refuses a recorded decision (409 state_forbids → exit 55)', async () => {
    makeWorktree();
    setMode('on');
    const made = await recordedDecision('cli refuses');
    const outcome = await memCloseItem(db, WT, made.id, { instanceId: 'claude' }, deps());
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('state_forbids');
    expect(MEM_EXIT_BY_CODE.state_forbids).toBe(55);
    expect(itemIs("id = ? AND state = 'recorded'", made.id)).toBe(true);
    // The store's unversioned close (A's) refuses it whoever asks: only the screen's transition opens it.
    const store = closeMemItem(db, { worktreeId: WT, instanceId: 'claude', cliToolId: 'claude', capturedIncarnation: null, sessionGeneration: null, by: 'human' }, made.id, null);
    expect(store.ok).toBe(false);
  });

  it('a proposal (written as the agent) never closes a recorded decision, even with confirmUnreflected → 409 state_forbids', async () => {
    makeWorktree();
    setMode('on');
    const made = await recordedDecision('proposal refused');
    const outcome = await write({ op: 'close', author: 'proposer', itemId: made.id, body: { ifVersion: made.version, confirmUnreflected: true } });
    expect(outcome.status).toBe(409);
    expect(codeOf(outcome)).toBe('state_forbids');
    expect(itemIs("id = ? AND state = 'recorded'", made.id)).toBe(true);
  });

  it('(control) an open decision closes as withdrawn without any confirmation', async () => {
    makeWorktree();
    setMode('on');
    const made = await agentAdd({ kind: 'decision', text: 'open one', promoteTo: 'issue:#4227' });
    const outcome = await write({ op: 'close', author: 'human', itemId: made.id, body: { ifVersion: made.version } });
    expect(outcome.status).toBe(201);
    expect(rowOf(made.id)).toMatchObject({ state: 'closed', close_reason: 'withdrawn' });
  });

  it('the transition table: withdraw-recorded only from a recorded decision; close still refuses recorded', () => {
    expect(memTransition('decision', 'recorded', 'withdraw-recorded')).toEqual({ ok: true, next: 'closed', reason: 'withdrawn' });
    expect(memTransition('decision', 'recorded', 'close')).toEqual({ ok: false });
    for (const state of ['open', 'promoted', 'closed'] as const) {
      expect(memTransition('decision', state, 'withdraw-recorded')).toEqual({ ok: false });
    }
    expect(memTransition('note', 'open', 'withdraw-recorded')).toEqual({ ok: false });
  });
});
