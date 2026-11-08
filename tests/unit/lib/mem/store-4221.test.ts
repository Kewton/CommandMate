/**
 * The mem store through its service (Issue #4221): modes, ownership, versions, keys,
 * incarnations, membership and what survives what (design §13.3 and the 2nd review).
 *
 * A file DB under `os.tmpdir()`, removed after each test; git is replaced by the
 * resolver's deps and an `observe` that the tests can hold at an `await`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

const logged: Array<[string, unknown]> = [];
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const record = (event: string, data?: unknown) => logged.push([event, data]);
    return { info: record, warn: record, error: record, debug: record, withContext: () => ({}) };
  },
}));

import { createRepository, setRepositoryEnabled } from '@/lib/db/db-repository';
import { addAgentInstance, removeAgentInstance, setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  branchGlobMatches,
  decideRootMode,
  getMemSettings,
  replaceNowSlot,
  saveMemBranchOverride,
  saveMemSettings,
  type MemActor,
} from '@/lib/db/mem-db';
import { deleteWorktreesByIds, migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import { getInstanceIncarnation } from '@/lib/mem/incarnation';
import {
  memAddItem,
  memCloseItem,
  memList,
  memMode,
  memPurge,
  memUpdateItem,
  memWriteNow,
  writeSessionNoteFromScreen,
  type MemServiceDeps,
} from '@/lib/mem/service';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { MEM_EXIT_BY_CODE, type MemBranchRule, type MemErrorCode, type MemListResponse, type MemWriteResponse } from '@/types/mem';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const GHP = `ghp_${'b'.repeat(36)}`;

let dir: string;
let dbFile: string;
let db: Database.Database;
let rootA: string;
let wtPath: string;
let repoA: string;
let head: WorktreeHeadObservation;
let commonDirs: Record<string, string | null>;
/** Set to hold the next `observe` until released. */
let gate: { wait: Promise<void>; release: () => void; armed: boolean } | null;

function arm(): () => void {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  gate = { wait, release, armed: true };
  return release;
}

const deps = (): MemServiceDeps => ({
  resolveCommonDir: async (p) => (p in commonDirs ? commonDirs[p] : '/common/.git'),
  pathExists: () => true,
  observe: async () => {
    const seen = { ...head };
    if (gate?.armed) {
      gate.armed = false;
      await gate.wait;
    }
    return seen;
  },
  git: { originUrl: async () => 'git@github.com:Kewton/CommandMate.git', refTip: async () => SHA },
});

function insertWorktree(id: string, worktreePath: string, repositoryPath: string): void {
  mkdirSync(worktreePath, { recursive: true });
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, worktreePath, repositoryPath);
}

function rules(repositoryId: string, list: MemBranchRule[]): void {
  const current = getMemSettings(db, repositoryId);
  saveMemSettings(db, repositoryId, { version: current.version, features: current.features, rules: list });
}

const on = (repositoryId = repoA) => rules(repositoryId, [{ match: 'glob', pattern: '**', mode: 'on' }]);
const setMode = (mode: 'off' | 'derived' | 'on', repositoryId = repoA) =>
  rules(repositoryId, [{ match: 'glob', pattern: '**', mode }]);

const codeOf = (outcome: { body: unknown }) => (outcome.body as { code?: MemErrorCode }).code;
const exitOf = (outcome: { body: unknown }) => {
  const code = codeOf(outcome);
  return code ? MEM_EXIT_BY_CODE[code] : 0;
};
const itemOf = (outcome: { body: unknown }) => (outcome.body as MemWriteResponse).item;
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

beforeEach(() => {
  dir = makeTempDir('mem-store-4221-');
  dbFile = path.join(dir, 'cm.db');
  db = openMigratedFileDb(dbFile, { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  wtPath = path.join(dir, 'wt');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  insertWorktree('wt-1', wtPath, rootA);
  setAgentInstances(db, 'wt-1', [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 },
  ]);
  head = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
  commonDirs = {};
  gate = null;
  logged.length = 0;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('modes (受入: 初期は off、off/derived は書かない)', () => {
  it('refuses every write with disabled (exit 50) and stores nothing when no rule exists', async () => {
    expect(exitOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'x' }, deps()))).toBe(50);
    expect(exitOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, deps()))).toBe(50);
    expect(exitOf(await memUpdateItem(db, 'wt-1', 'nope', { instanceId: 'claude', ifVersion: 1 }, deps()))).toBe(52);
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM session_notes')).toBe(0);
    expect((await memMode(db, { via: 'worktree', worktreeId: 'wt-1' }, deps())).body).toMatchObject({
      mode: 'off',
      source: { level: 'fallback' },
    });
  });

  it('refuses writes in derived too, and accepts them in on', async () => {
    setMode('derived');
    expect(exitOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, deps()))).toBe(50);
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    setMode('on');
    const added = await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, deps());
    expect(added.status).toBe(201);
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(1);
    const closed = await memCloseItem(db, 'wt-1', itemOf(added).id, { instanceId: 'claude' }, deps());
    expect(itemOf(closed).state).toBe('closed');
  });

  it('on → off → derived → on: only allowed changes happen, and items stay (受入: mode の遷移)', async () => {
    on();
    const added = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'next', text: 'n', closeWhen: 'manual' }, deps()));
    setMode('off');
    expect(exitOf(await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps()))).toBe(50);
    expect(exitOf(await memUpdateItem(db, 'wt-1', added.id, { instanceId: 'claude', ifVersion: 1, text: 'm' }, deps()))).toBe(50);
    setMode('derived');
    const frozen = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(frozen.items.map((item) => [item.id, item.frozen, item.version])).toEqual([[added.id, true, 1]]);
    expect(exitOf(await memCloseItem(db, 'wt-1', added.id, { instanceId: 'claude' }, deps()))).toBe(50);
    setMode('on');
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(list.items.map((item) => [item.id, item.frozen, item.version, item.text])).toEqual([[added.id, false, 1, 'n']]);
    expect(itemOf(await memUpdateItem(db, 'wt-1', added.id, { instanceId: 'claude', ifVersion: 1, text: 'm' }, deps())).version).toBe(2);
  });
});

describe('rule precedence (受入: 上書き・glob・detached・規則なし)', () => {
  it('override beats the rules, the first rule wins, * stays in a segment, ** crosses', () => {
    rules(repoA, [
      { match: 'glob', pattern: 'feat/*', mode: 'on' },
      { match: 'glob', pattern: 'feat/**', mode: 'derived' },
      { match: 'glob', pattern: 'main', mode: 'on' },
    ]);
    expect(decideRootMode(db, repoA, 'feat/x').mode).toBe('on');
    expect(decideRootMode(db, repoA, 'feat/x/y').mode).toBe('derived');
    expect(decideRootMode(db, repoA, 'main').source).toMatchObject({ level: 'rule', rulePosition: 2, pattern: 'main' });
    expect(decideRootMode(db, repoA, 'other')).toMatchObject({ mode: 'off', source: { level: 'fallback' } });
    saveMemBranchOverride(db, repoA, getMemSettings(db, repoA).version, {
      branch: 'feat/x',
      mode: 'off',
      injectOnStart: null,
      promptOnEvents: null,
      popup: null,
    });
    expect(decideRootMode(db, repoA, 'feat/x')).toMatchObject({ mode: 'off', source: { level: 'override' } });
    expect(branchGlobMatches('feat/*', 'feat/a/b')).toBe(false);
    expect(branchGlobMatches('feat/**', 'feat/a/b')).toBe(true);
  });

  it('detached matches only a detached rule', async () => {
    rules(repoA, [
      { match: 'glob', pattern: '**', mode: 'derived' },
      { match: 'detached', pattern: null, mode: 'on' },
    ]);
    expect(decideRootMode(db, repoA, null).mode).toBe('on');
    head = { branch: null, detached: true, head: SHA, commonDir: '/common/.git', known: true };
    expect((await memMode(db, { via: 'worktree', worktreeId: 'wt-1' }, deps())).body).toMatchObject({ mode: 'on', detached: true });
  });
});

describe('two sessions on one branch (受入: 互いの枠を上書きしない)', () => {
  it('keeps both rows when B finishes inside A’s await (R12)', async () => {
    on();
    const release = arm();
    const a = memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'A の作業' }, deps());
    await Promise.resolve();
    const b = await memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'B の作業' }, deps());
    expect(b.status).toBe(201);
    release();
    expect((await a).status).toBe(201);
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(list.now.map((slot) => [slot.instanceId, slot.item.text])).toEqual([
      ['claude', 'A の作業'],
      ['codex-2', 'B の作業'],
    ]);
  });

  it('replaces the same instance’s now and keeps one superseded (control)', async () => {
    on();
    await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'one' }, deps());
    await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'two' }, deps());
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE instance_id = 'claude'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE close_reason = 'superseded'")).toBe(1);
  });

  it('rolls the move back with the write when the write fails (atomic)', () => {
    on();
    const actor: MemActor = { worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', capturedIncarnation: getInstanceIncarnation(db, 'wt-1', 'claude')!.incarnation, sessionGeneration: null, by: 'agent' };
    const scope = { storageRepositoryId: repoA, readRepositoryIds: [repoA], branch: 'feature/x', worktreeId: 'wt-1' };
    replaceNowSlot(db, actor, scope, { text: 'first', closeWhen: null, evidence: [] });
    expect(() =>
      replaceNowSlot(db, actor, scope, { text: 'second', closeWhen: null, evidence: [] }, Date.now(), {
        afterArchive: () => {
          throw new Error('boom');
        },
      })
    ).toThrow('boom');
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE close_reason = 'superseded'")).toBe(0);
    expect((db.prepare("SELECT note FROM session_notes WHERE instance_id = 'claude'").get() as { note: string }).note).toBe('first');
    // Without the failure both are written (control).
    replaceNowSlot(db, actor, scope, { text: 'second', closeWhen: null, evidence: [] });
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE close_reason = 'superseded'")).toBe(1);
  });
});

describe('versions and authors', () => {
  it('refuses a stale --if-version (51) with the stored item, and loses neither content', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'v1' }, deps()));
    itemOf(await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'v2' }, deps()));
    const stale = await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'lost?' }, deps());
    expect(exitOf(stale)).toBe(51);
    expect(stale.body).toMatchObject({ currentVersion: 2, item: { text: 'v2', version: 2 } });
    expect((db.prepare('SELECT text FROM mem_items WHERE id = ?').get(item.id) as { text: string }).text).toBe('v2');
  });

  it('refuses another instance, and the same id’s next incarnation (55); the author passes', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'mine' }, deps()));
    expect(exitOf(await memCloseItem(db, 'wt-1', item.id, { instanceId: 'codex-2' }, deps()))).toBe(55);
    removeAgentInstance(db, 'wt-1', 'claude');
    addAgentInstance(db, 'wt-1', { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
    expect(exitOf(await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'x' }, deps()))).toBe(55);
    // A fresh item of the new incarnation is its own (control).
    const fresh = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'new' }, deps()));
    expect(exitOf(await memUpdateItem(db, 'wt-1', fresh.id, { instanceId: 'claude', ifVersion: 1, text: 'y' }, deps()))).toBe(0);
  });

  it('keeps the incarnation and the now across an alias edit and a reorder (R5)', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'keep' }, deps()));
    const before = getInstanceIncarnation(db, 'wt-1', 'codex-2');
    setAgentInstances(db, 'wt-1', [
      { id: 'codex-2', cliTool: 'codex', alias: 'renamed', order: 0 },
      { id: 'claude', cliTool: 'claude', alias: '', order: 1 },
    ]);
    expect(getInstanceIncarnation(db, 'wt-1', 'codex-2')).toEqual(before);
    expect(exitOf(await memUpdateItem(db, 'wt-1', now.id, { instanceId: 'codex-2', ifVersion: now.version, text: 'k2' }, deps()))).toBe(0);
  });

  it('moves the now out when an id is kept with another tool, and starts a new incarnation (R5)', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'codex の作業' }, deps()));
    setAgentInstances(db, 'wt-1', [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'gemini', alias: '', order: 1 },
    ]);
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE instance_id = 'codex-2'")).toBe(0);
    expect(db.prepare('SELECT close_reason FROM mem_items WHERE id = ?').get(now.id)).toEqual({ close_reason: 'slot-removed' });
    expect(exitOf(await memUpdateItem(db, 'wt-1', now.id, { instanceId: 'codex-2', ifVersion: now.version, text: 'x' }, deps()))).toBe(55);
  });
});

describe('--key (受入: 同じ key の add は 1 件; R4・R9)', () => {
  const add = (extra: Record<string, unknown> = {}, instanceId = 'claude') =>
    memAddItem(db, 'wt-1', { instanceId, kind: 'next', text: 't', closeWhen: 'manual', key: 'k-1', ...extra }, deps());

  it('answers the first item to a retry with the same content', async () => {
    on();
    const first = await add();
    const again = await add();
    expect(again.body).toMatchObject({ replayed: true, item: { id: itemOf(first).id } });
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(1);
  });

  it('refuses the key for a different request (54) and keeps it apart per instance', async () => {
    on();
    const first = itemOf(await add({ quote: 'q', quoteAt: '2026-11-01T00:00:00Z' }));
    const other = await add({ quote: 'q', quoteAt: '2026-11-01T00:00:01Z' });
    expect(exitOf(other)).toBe(54);
    expect(other.body).toMatchObject({ itemId: first.id });
    head = { ...head, branch: 'feature/y' };
    expect(exitOf(await add({ quote: 'q', quoteAt: '2026-11-01T00:00:00Z' }))).toBe(54);
    head = { ...head, branch: 'feature/x' };
    const codex = await add({ quote: 'q', quoteAt: '2026-11-01T00:00:00Z' }, 'codex-2');
    expect(codex.status).toBe(201);
    expect(itemOf(codex).id).not.toBe(first.id);
  });

  it('still replays after a root is added in front of the first by path (R9)', async () => {
    on();
    const first = itemOf(await add());
    const front = path.join(dir, 'a-front');
    mkdirSync(front);
    const repoFront = createRepository(db, { name: 'front', path: front, cloneSource: 'local' }).id;
    on(repoFront);
    const again = await add();
    expect(again.body).toMatchObject({ replayed: true, item: { id: first.id } });
    // The front root is now where new items go; the old one stays where it was.
    const next = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'n' }, deps()));
    expect(next.owner.repositoryId).toBe(repoFront);
    setRepositoryEnabled(db, repoA, false);
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(list.items.map((item) => item.id).sort()).toEqual([first.id, next.id].sort());
  });
});

describe('what does not mix (受入: 別 repository・別ブランチ・世代)', () => {
  it('does not show another repository’s items for a branch of the same name', async () => {
    on();
    const rootB = path.join(dir, 'root-b');
    mkdirSync(rootB);
    const repoB = createRepository(db, { name: 'repo-a', path: rootB, cloneSource: 'local' }).id;
    on(repoB);
    insertWorktree('wt-b', path.join(dir, 'wt-b'), rootB);
    commonDirs = { [rootB]: '/other/.git', [path.join(dir, 'wt-b')]: '/other/.git' };
    head = { ...head, commonDir: null };
    await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'A の' }, deps());
    await memAddItem(db, 'wt-b', { instanceId: 'claude', kind: 'note', text: 'B の' }, deps());
    const listA = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(listA.items.map((item) => item.text)).toEqual(['A の']);
  });

  it('does not hand a removed instance’s now to the one that re-uses its id', async () => {
    on();
    const old = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: '前の作業' }, deps()));
    removeAgentInstance(db, 'wt-1', 'codex-2');
    addAgentInstance(db, 'wt-1', { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 });
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, { all: true }, deps())).body as MemListResponse;
    expect(list.now).toEqual([]);
    expect(list.items.find((item) => item.id === old.id)).toMatchObject({ state: 'closed', closeReason: 'slot-removed' });
  });

  it('shows the branch’s items from another worktree of it (control)', async () => {
    on();
    await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'shared' }, deps());
    insertWorktree('wt-2', path.join(dir, 'wt-2'), rootA);
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-2' }, {}, deps())).body as MemListResponse;
    expect(list.items.map((item) => item.text)).toEqual(['shared']);
  });
});

describe('holding on (受入: on→off→on・purge・再起動)', () => {
  it('moves a now out when the roster drops it while off, and on finds it again', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'x' }, deps()));
    setMode('off');
    setAgentInstances(db, 'wt-1', [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
    setMode('on');
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, { all: true }, deps())).body as MemListResponse;
    expect(list.items.find((item) => item.id === now.id)).toMatchObject({ closeReason: 'slot-removed', text: 'x' });
  });

  it('moves every now out before the worktree goes, and reads them by repository + branch (R3・R6)', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'last words' }, deps()));
    deleteWorktreesByIds(db, ['wt-1']);
    const row = db.prepare('SELECT origin_incarnation, origin_worktree_incarnation, close_reason FROM mem_items WHERE id = ?').get(now.id);
    expect(row).toEqual({
      origin_incarnation: now.owner.incarnation,
      origin_worktree_incarnation: now.owner.worktreeIncarnation,
      close_reason: 'slot-removed',
    });
    const byRepo = (await memList(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { all: true }, deps()))
      .body as MemListResponse;
    expect(byRepo.items.map((item) => item.id)).toEqual([now.id]);
  });

  it('reads the mode of the named branch, not of the worktree’s (R3)', async () => {
    rules(repoA, [
      { match: 'glob', pattern: 'feature/x', mode: 'on' },
      { match: 'glob', pattern: '**', mode: 'off' },
    ]);
    expect(exitOf(await memList(db, { via: 'repository', repositoryId: repoA, branch: 'other' }, {}, deps()))).toBe(50);
    expect(exitOf(await memList(db, { via: 'worktree', worktreeId: 'wt-1', branch: 'other' }, {}, deps()))).toBe(50);
    expect((await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).status).toBe(200);
  });

  it('purge counts without --confirm, deletes with it, and keeps recorded decisions unless asked', async () => {
    on();
    const note = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'n' }, deps()));
    const decision = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'decision', text: 'd' }, deps()));
    db.prepare("UPDATE mem_items SET state = 'recorded' WHERE id = ?").run(decision.id);
    const dry = await memPurge(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, {}, deps());
    expect(dry.body).toEqual({ ok: true, dryRun: true, counts: { note: 1 } });
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(2);
    await memPurge(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { confirm: true }, deps());
    expect(db.prepare('SELECT id FROM mem_items').all()).toEqual([{ id: decision.id }]);
    expect(note.id).not.toBe(decision.id);
    await memPurge(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { confirm: true, includeDecisions: true }, deps());
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });

  it('keeps items, versions and incarnations across a restart (受入: 再起動)', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'n' }, deps()));
    const updated = itemOf(await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'n2' }, deps()));
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'now' }, deps()));
    db.close();
    db = openMigratedFileDb(dbFile, { foreignKeys: true });
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(list.items.find((entry) => entry.id === item.id)).toMatchObject({ version: 2, text: 'n2', owner: updated.owner });
    expect(list.now[0].item).toMatchObject({ id: now.id, owner: now.owner, version: now.version });
  });
});

describe('membership (受入: 所属の解決)', () => {
  let rootB: string;
  let repoB: string;
  beforeEach(() => {
    rootB = path.join(dir, 'root-b');
    mkdirSync(rootB);
    repoB = createRepository(db, { name: 'repo-b', path: rootB, cloneSource: 'local' }).id;
  });

  it('two roots of one repository with different settings: ambiguous (53), nothing written', async () => {
    on(repoA);
    const outcome = await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, deps());
    expect(exitOf(outcome)).toBe(53);
    expect(outcome.body).toMatchObject({ reason: 'root-settings-differ' });
    expect(JSON.stringify(outcome.body)).not.toContain(rootA);
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });

  it('a root git cannot identify and whose settings differ: ambiguous (membership-undetermined)', async () => {
    on(repoA);
    commonDirs = { [rootB]: null };
    expect((await memMode(db, { via: 'worktree', worktreeId: 'wt-1' }, deps())).body).toMatchObject({
      code: 'ambiguous',
      reason: 'membership-undetermined',
    });
  });

  it('two roots that agree pass; the scan order does not change the answer', async () => {
    on(repoA);
    on(repoB);
    const first = await memMode(db, { via: 'worktree', worktreeId: 'wt-1' }, deps());
    db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(rootB, 'wt-1');
    const second = await memMode(db, { via: 'worktree', worktreeId: 'wt-1' }, deps());
    expect(first.body).toMatchObject({ mode: 'on' });
    expect((second.body as { repositoryIds: string[] }).repositoryIds).toEqual((first.body as { repositoryIds: string[] }).repositoryIds);
  });

  it('not registered (52) when no root is this repository', async () => {
    insertWorktree('wt-x', path.join(dir, 'wt-x'), path.join(dir, 'unregistered'));
    commonDirs = { [path.join(dir, 'wt-x')]: '/elsewhere/.git', [path.join(dir, 'unregistered')]: '/elsewhere/.git' };
    head = { ...head, commonDir: '/elsewhere/.git' };
    expect(exitOf(await memMode(db, { via: 'worktree', worktreeId: 'wt-x' }, deps()))).toBe(52);
  });
});

describe('one attempt binds branch, HEAD and the common dir (R2・2nd review 4)', () => {
  it('writes under the branch seen after a change during the await, never the old one', async () => {
    on();
    let calls = 0;
    const moving: MemServiceDeps = {
      ...deps(),
      observe: async () => {
        calls += 1;
        return { ...head, branch: calls === 1 ? 'feature/old' : 'feature/new' };
      },
    };
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, moving));
    expect(item.owner.branch).toBe('feature/new');
  });

  it('a common dir that changes with the same HEAD is stale; one that keeps changing is 53', async () => {
    on();
    let calls = 0;
    const flipping: MemServiceDeps = {
      ...deps(),
      observe: async () => ({ ...head, commonDir: (calls++ % 2 === 0 ? '/common/.git' : '/swapped/.git') }),
    };
    const outcome = await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, flipping);
    expect(outcome.body).toMatchObject({ code: 'ambiguous', reason: 'registration_changed' });
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    // An observation of another git than the membership judged by is stale too.
    const other: MemServiceDeps = { ...deps(), observe: async () => ({ ...head, commonDir: '/swapped/.git' }) };
    expect(exitOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, other))).toBe(53);
    // The same git all along writes at once (control).
    expect((await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x' }, deps())).status).toBe(201);
  });
});

describe('the incarnation is fixed when the request arrives (2nd review 3・8)', () => {
  it('refuses a now / add whose instance was removed and re-added during the await', async () => {
    on();
    for (const write of [
      () => memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'x' }, deps()),
      () => memAddItem(db, 'wt-1', { instanceId: 'codex-2', kind: 'note', text: 'x' }, deps()),
    ]) {
      const release = arm();
      const pending = write();
      await Promise.resolve();
      removeAgentInstance(db, 'wt-1', 'codex-2');
      addAgentInstance(db, 'wt-1', { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 });
      release();
      const outcome = await pending;
      expect(outcome.body).toMatchObject({ code: 'instance_not_found', reason: 'incarnation_changed' });
    }
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM session_notes')).toBe(0);
  });

  it('lets an alias edit or a reorder during the await through', async () => {
    on();
    const release = arm();
    const pending = memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'x' }, deps());
    await Promise.resolve();
    setAgentInstances(db, 'wt-1', [
      { id: 'codex-2', cliTool: 'codex', alias: 'renamed', order: 0 },
      { id: 'claude', cliTool: 'claude', alias: '', order: 1 },
    ]);
    release();
    expect((await pending).status).toBe(201);
  });

  it('a derived primary saved into the roster keeps its now and its ownership', async () => {
    on();
    insertWorktree('wt-d', path.join(dir, 'wt-d'), rootA);
    const now = itemOf(await memWriteNow(db, 'wt-d', { instanceId: 'claude', text: 'primary' }, deps()));
    // What the management route does when an instance is added to a derived roster.
    setAgentInstances(db, 'wt-d', [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 },
    ]);
    const updated = await memUpdateItem(db, 'wt-d', now.id, { instanceId: 'claude', ifVersion: now.version, text: 'still mine' }, deps());
    expect(exitOf(updated)).toBe(0);
    expect(itemOf(updated).owner.incarnation).toBe(now.owner.incarnation);
  });
});

describe('the screen note and the slot version (§10.2・2nd review 2)', () => {
  it('never repeats a version across a delete, so an old screen is told (409)', async () => {
    const write = (text: string, baseVersion?: number) =>
      writeSessionNoteFromScreen(db, 'wt-1', { instanceId: 'claude', text, ...(baseVersion !== undefined ? { baseVersion } : {}) }, deps());
    const first = (await write('one')).body as { note: { version: number } };
    const read = first.note.version;
    await write('', read);
    const again = (await write('two')).body as { note: { version: number } };
    expect(again.note.version).toBeGreaterThan(read);
    const stale = await write('stale', read);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { text: 'two' } });
    expect((await write('fresh', again.note.version)).status).toBe(200);
  });

  it('3rd review P2-1: after another deleted the note, the 409 says no row and baseVersion 0 saves the draft', async () => {
    const write = (text: string, baseVersion?: number) =>
      writeSessionNoteFromScreen(db, 'wt-1', { instanceId: 'claude', text, ...(baseVersion !== undefined ? { baseVersion } : {}) }, deps());
    const read = ((await write('one')).body as { note: { version: number } }).note.version;
    expect((await write('', read)).status).toBe(200);
    const stale = await write('draft', read);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: null });
    const saved = await write('draft', 0);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ note: { text: 'draft' } });
    expect(((saved.body as { note: { version: number } }).note.version)).toBeGreaterThan(read);
  });

  it('3rd review P2-1 (control): baseVersion 0 while a row exists, or a stale version, is still 409', async () => {
    on();
    const write = (text: string, baseVersion?: number) =>
      writeSessionNoteFromScreen(db, 'wt-1', { instanceId: 'claude', text, ...(baseVersion !== undefined ? { baseVersion } : {}) }, deps());
    const first = ((await write('one')).body as { note: { version: number } }).note.version;
    const zero = await write('over', 0);
    expect(zero.status).toBe(409);
    expect(zero.body).toMatchObject({ code: 'version_conflict', current: { text: 'one', version: first } });
    const second = ((await write('two', first)).body as { note: { version: number } }).note.version;
    expect((await write('stale', first)).body).toMatchObject({ code: 'version_conflict', current: { text: 'two', version: second } });
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE note = 'two'")).toBe(1);
  });

  it('a person may change a now of mem from the screen (受入: 画面（人）で 0)', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'agent wrote' }, deps()));
    const outcome = await writeSessionNoteFromScreen(db, 'wt-1', { instanceId: 'claude', text: 'person wrote', baseVersion: now.version }, deps());
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ note: { text: 'person wrote', mem: { createdBy: 'human' } } });
  });
});

describe('what was refused is never repeated (受入・§7)', () => {
  it('a secret in a write: 400 with field and rule, nothing stored, not in the answer or the log', async () => {
    on();
    const outcome = await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: `leak ${GHP}` }, deps());
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ code: 'secret_like', field: 'text', rule: 'github-token' });
    expect(JSON.stringify(outcome.body)).not.toContain(GHP);
    expect(JSON.stringify(logged)).not.toContain(GHP);
    expect(JSON.stringify(logged)).toContain('secret_like');
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });

  it('an absolute evidence path: refused and not repeated; a free-text absolute path is kept (R11)', async () => {
    on();
    const refused = await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'x', evidence: ['path:/etc/passwd'] }, deps());
    expect(refused.body).toMatchObject({ code: 'absolute_path', field: 'evidence' });
    expect(JSON.stringify(refused.body) + JSON.stringify(logged)).not.toContain('/etc/passwd');
    const kept = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: '/tmp/mem-example' }, deps()));
    expect(kept.text).toBe('/tmp/mem-example');
  });

  it('limits the open items per kind (56) and warns before', async () => {
    on();
    for (let i = 0; i < 30; i += 1) {
      db.prepare(
        `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, origin_worktree_id, origin_worktree_incarnation,
           origin_instance_id, origin_cli_tool_id, origin_incarnation, created_by, updated_by, version, checked_rules_version,
           created_at, updated_at) VALUES (?, ?, 'feature/x', 'next', 'open', 't', 'wt-1', 'w', 'claude', 'claude', 'i', 'agent', 'agent', 1, 1, 0, 0)`
      ).run(`n-${i}`, repoA);
    }
    expect(exitOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'next', text: 'x', closeWhen: 'manual' }, deps()))).toBe(56);
    const list = (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;
    expect(list.warnings).toContainEqual({ code: 'open_count', kind: 'next', count: 30, threshold: 10 });
  });
});

describe('integration review fixes (P1・P2-1・P2-4・P3)', () => {
  const dropIncarnation = (instanceId: string) =>
    db.prepare("DELETE FROM mem_instance_incarnations WHERE worktree_id = 'wt-1' AND instance_id = ?").run(instanceId);

  it('P1: a v65 instance (no incarnation) deleted while its first now / add waits is not stored', async () => {
    on();
    for (const write of [
      () => memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'x' }, deps()),
      () => memAddItem(db, 'wt-1', { instanceId: 'codex-2', kind: 'note', text: 'x' }, deps()),
    ]) {
      setAgentInstances(db, 'wt-1', [
        { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
        { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 },
      ]);
      dropIncarnation('codex-2');
      const release = arm();
      const pending = write();
      await Promise.resolve();
      removeAgentInstance(db, 'wt-1', 'codex-2');
      release();
      expect((await pending).body).toMatchObject({ code: 'instance_not_found' });
    }
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM session_notes')).toBe(0);
    expect(getInstanceIncarnation(db, 'wt-1', 'codex-2')).toBeNull();
  });

  it('P1 (control): the same v65 instance, not deleted during the wait, is stored', async () => {
    on();
    dropIncarnation('codex-2');
    const release = arm();
    const pending = memWriteNow(db, 'wt-1', { instanceId: 'codex-2', text: 'kept' }, deps());
    await Promise.resolve();
    release();
    expect((await pending).status).toBe(201);
    dropIncarnation('claude');
    expect((await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'kept' }, deps())).status).toBe(201);
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE instance_id = 'codex-2'")).toBe(1);
  });

  const listed = async () => (await memList(db, { via: 'worktree', worktreeId: 'wt-1' }, {}, deps())).body as MemListResponse;

  it('P2-1: a partial update with the right version keeps a field the current rules withhold hidden', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'v1' }, deps()));
    // What a rule update leaves: a stored field the current rules now match, checked under an older set.
    db.prepare('UPDATE mem_items SET evidence = ?, checked_rules_version = 0 WHERE id = ?').run(JSON.stringify([GHP]), item.id);
    const updated = await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'v2' }, deps());
    expect(exitOf(updated)).toBe(0);
    expect(JSON.stringify(updated.body)).not.toContain(GHP);
    expect((db.prepare('SELECT checked_rules_version v FROM mem_items WHERE id = ?').get(item.id) as { v: number }).v).toBe(0);
    const view = (await listed()).items.find((entry) => entry.id === item.id)!;
    expect(view.withheld).toMatchObject({ field: 'evidence' });
    expect(JSON.stringify(await listed())).not.toContain(GHP);
  });

  it('P2-1 (control): a partial update over clean fields raises the checked version and shows them', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'v1' }, deps()));
    db.prepare('UPDATE mem_items SET evidence = ?, checked_rules_version = 0 WHERE id = ?').run(JSON.stringify(['src/a.ts']), item.id);
    expect(exitOf(await memUpdateItem(db, 'wt-1', item.id, { instanceId: 'claude', ifVersion: 1, text: 'v2' }, deps()))).toBe(0);
    expect((db.prepare('SELECT checked_rules_version v FROM mem_items WHERE id = ?').get(item.id) as { v: number }).v).toBe(1);
    const view = (await listed()).items.find((entry) => entry.id === item.id)!;
    expect(view.withheld).toBeUndefined();
    expect(view.evidence).toEqual(['src/a.ts']);
  });

  it('P2-1: a person’s edit of a now while off checks the fields it keeps too (and passes clean ones)', async () => {
    on();
    for (const [evidence, expected] of [
      [GHP, 0],
      ['src/a.ts', 1],
    ] as const) {
      const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'agent' }, deps()));
      db.prepare("UPDATE session_notes SET mem_evidence = ?, mem_checked_rules_version = 0 WHERE mem_item_id = ?").run(
        JSON.stringify([evidence]),
        now.id
      );
      setMode('off');
      const slot = db.prepare("SELECT version FROM session_notes WHERE mem_item_id = ?").get(now.id) as { version: number };
      const outcome = await writeSessionNoteFromScreen(db, 'wt-1', { instanceId: 'claude', text: 'person', baseVersion: slot.version }, deps());
      expect(outcome.status).toBe(200);
      expect(
        (db.prepare('SELECT mem_checked_rules_version v FROM session_notes WHERE mem_item_id = ?').get(now.id) as { v: number }).v
      ).toBe(expected);
      on();
    }
  });

  it('P2-4: after a plain rename the same author may update and close an item made before it; another gets 55', async () => {
    on();
    const item = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'before' }, deps()));
    const other = itemOf(await memAddItem(db, 'wt-1', { instanceId: 'claude', kind: 'note', text: 'other' }, deps()));
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, 'wt-1', 'wt-2'))();
    // The provenance keeps the old id; the author is the incarnation that moved.
    expect(db.prepare('SELECT origin_worktree_id o FROM mem_items WHERE id = ?').get(item.id)).toEqual({ o: 'wt-1' });
    expect(exitOf(await memCloseItem(db, 'wt-2', item.id, { instanceId: 'codex-2' }, deps()))).toBe(55);
    expect(exitOf(await memUpdateItem(db, 'wt-2', item.id, { instanceId: 'codex-2', ifVersion: 1, text: 'x' }, deps()))).toBe(55);
    expect(exitOf(await memUpdateItem(db, 'wt-2', item.id, { instanceId: 'claude', ifVersion: 1, text: 'after' }, deps()))).toBe(0);
    expect(exitOf(await memCloseItem(db, 'wt-2', other.id, { instanceId: 'claude' }, deps()))).toBe(0);
  });

  it('P3: a collision rename moves the source’s now to mem_items (slot-removed); a plain note goes as before', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'source now' }, deps()));
    db.prepare("INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version) VALUES ('wt-1', 'codex-2', 'plain', 0, 1)").run();
    insertWorktree('wt-2', path.join(dir, 'wt-2'), rootA);
    for (const instanceId of ['claude', 'codex-2']) {
      db.prepare("INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version) VALUES ('wt-2', ?, 'dest', 0, 1)").run(
        instanceId
      );
    }
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, 'wt-1', 'wt-2'))();
    expect(db.prepare('SELECT state, close_reason, text FROM mem_items WHERE id = ?').get(now.id)).toEqual({
      state: 'closed',
      close_reason: 'slot-removed',
      text: 'source now',
    });
    // The destination's rows win; the plain note is dropped and does not become mem.
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE note = 'dest'")).toBe(2);
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE text = 'plain'")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE worktree_id = 'wt-1'")).toBe(0);
    const all = (await memList(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { all: true }, deps()))
      .body as MemListResponse;
    expect(all.items.map((entry) => entry.id)).toContain(now.id);
  });

  it('P3 (control): a plain rename keeps the now in its slot, not archived', async () => {
    on();
    const now = itemOf(await memWriteNow(db, 'wt-1', { instanceId: 'claude', text: 'moves' }, deps()));
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, 'wt-1', 'wt-2'))();
    expect(count('SELECT COUNT(*) n FROM mem_items WHERE id = ?', now.id)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE worktree_id = 'wt-2' AND mem_item_id = ?", now.id)).toBe(1);
  });
});

describe('2nd integration review P1: the worktree lifetime is fixed when the request arrives', () => {
  const wtD = () => path.join(dir, 'wt-d');
  const writes = [
    () => memWriteNow(db, 'wt-d', { instanceId: 'claude', text: 'before the delete' }, deps()),
    () => memAddItem(db, 'wt-d', { instanceId: 'claude', kind: 'note', text: 'before the delete' }, deps()),
  ];

  it('a first now / add of a derived primary is not stored when the worktree is deleted and made again (same id and path) during the wait', async () => {
    on();
    for (const write of writes) {
      insertWorktree('wt-d', wtD(), rootA);
      const release = arm();
      const pending = write();
      await Promise.resolve();
      deleteWorktreesByIds(db, ['wt-d']);
      insertWorktree('wt-d', wtD(), rootA);
      release();
      expect((await pending).body).toMatchObject({ code: 'instance_not_found' });
      deleteWorktreesByIds(db, ['wt-d']);
    }
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM session_notes')).toBe(0);
  });

  it('(control) the same first now / add, with the worktree left as it was, is stored', async () => {
    on();
    insertWorktree('wt-d', wtD(), rootA);
    for (const write of writes) {
      const release = arm();
      const pending = write();
      await Promise.resolve();
      release();
      expect((await pending).status).toBe(201);
    }
    expect(count("SELECT COUNT(*) n FROM session_notes WHERE worktree_id = 'wt-d'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM mem_items WHERE origin_worktree_id = 'wt-d' AND state = 'open'")).toBe(1);
  });
});
