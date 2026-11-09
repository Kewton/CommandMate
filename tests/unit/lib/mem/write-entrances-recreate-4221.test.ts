/**
 * The invariant every write of mem keeps (Issue #4221, 2nd・3rd integration review):
 * a request read before the worktree was deleted and made again under the same id
 * and path is refused, whatever the entrance and the mode; one the worktree was
 * left alone for lands.
 *
 * One table, one test each way. The table is checked against the entrances
 * themselves, enumerated from the store's side (4th review): the exported functions
 * of `src/lib/db/mem-db.ts` that INSERT / UPDATE / DELETE, and every exported
 * function of `src/lib/mem/service.ts` that reaches one of them, with or without an
 * actor. Each must be a row or a named exception; each mode of the screen's save and
 * the condition's save have rows too — so a new way in fails the first test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
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
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import {
  memAddItem,
  memCloseItem,
  memPurge,
  memSettleDecisionTransition,
  memUpdateItem,
  memWriteFromScreen,
  memWriteNow,
  writeSessionNoteFromScreen,
  type MemServiceDeps,
} from '@/lib/mem/service';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { MemWriteResponse } from '@/types/mem';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-r';
const SERVICE = path.join(process.cwd(), 'src/lib/mem/service.ts');

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
/** Holds the next await of the request (git's `observe`, or the condition's `origin`) until released. */
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

const head: WorktreeHeadObservation = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
const deps = (): MemServiceDeps => ({
  resolveCommonDir: async () => '/common/.git',
  pathExists: () => true,
  observe: async () => {
    await held();
    return { ...head };
  },
  git: {
    originUrl: async () => {
      await held();
      return 'git@github.com:Kewton/CommandMate.git';
    },
    refTip: async () => SHA,
  },
});

const wtPath = () => path.join(dir, 'wt-r');
function makeWorktree(): void {
  mkdirSync(wtPath(), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
    WT,
    WT,
    wtPath(),
    rootA
  );
}
function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const noteIs = (text: string) => count('SELECT COUNT(*) n FROM session_notes WHERE worktree_id = ? AND note = ?', WT, text) === 1;
const itemIs = (where: string, ...params: unknown[]) => count(`SELECT COUNT(*) n FROM mem_items WHERE ${where}`, ...params) === 1;

interface Entrance {
  /** The exported function of the service this row drives. */
  fn: string;
  mode: 'off' | 'derived' | 'on';
  /** Made before the request is read (an item to update or close). */
  before?: () => Promise<{ id: string; version: number }>;
  request: (made: { id: string; version: number } | undefined) => Promise<{ status: number; body: unknown }>;
  /** Done while the request waits, after the re-creation when there is one (mem the new worktree writes). */
  during?: () => Promise<void>;
  /** Whether the request's write is in the store. */
  landed: (made: { id: string; version: number } | undefined) => boolean;
}

const addNote = async (text: string) => {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text }, deps());
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
const screen = (mode: Entrance['mode']): Entrance => ({
  fn: 'writeSessionNoteFromScreen',
  mode,
  request: () => writeSessionNoteFromScreen(db, WT, { instanceId: 'claude', text: `screen ${mode}` }, deps()),
  landed: () => noteIs(`screen ${mode}`),
});

/** Every way in that writes mem. */
/**
 * Issue #4225 (§0.1 S1・PM): a decision recorded / promoted through A's one entrance.
 * The lifetime is read when the request arrives (before the await), as the promote
 * service does; the entrance compares it and never fixes it again.
 */
const addDecision = async (text: string) => {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text, promoteTo: 'issue:#4225' }, deps());
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
const settleDecision = (made: { id: string; version: number }, transition: 'record' | 'promote' | 'promote-record-only', version = made.version) =>
  memSettleDecisionTransition(
    db,
    { worktreeId: WT, expectedWorktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT), itemId: made.id, expectedVersion: version, transition },
    deps()
  );
const recordedDecision = async (text: string) => {
  const made = await addDecision(text);
  const outcome = await settleDecision(made, 'record');
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
/** Issue #4227 (S-A): a request that carries the screen's mark, as the screen's routes pass it on. */
const screenRequest = () => ({
  headers: new Headers({ 'X-CommandMate-Client': 'screen', origin: 'http://localhost', host: 'localhost' }),
  url: 'http://localhost/api/worktrees/wt-r/mem/screen/items',
});
const screenWrite = (op: 'add' | 'update' | 'close', body: Record<string, unknown>, itemId?: string) =>
  memWriteFromScreen(db, screenRequest(), WT, { op, author: 'human', ...(itemId ? { itemId } : {}), body: { instanceId: 'claude', ...body } }, deps());
const decisionIs = (state: string) => (made: { id: string; version: number } | undefined) =>
  itemIs('id = ? AND state = ? AND version = ?', made!.id, state, made!.version + 1);

const ENTRANCES: Record<string, Entrance> = {
  'cli-now': {
    fn: 'memWriteNow',
    mode: 'on',
    request: () => memWriteNow(db, WT, { instanceId: 'claude', text: 'cli now' }, deps()),
    landed: () => noteIs('cli now'),
  },
  'cli-add': {
    fn: 'memAddItem',
    mode: 'on',
    request: () => memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'cli add' }, deps()),
    landed: () => itemIs("text = 'cli add'"),
  },
  'cli-update': {
    fn: 'memUpdateItem',
    mode: 'on',
    before: () => addNote('to update'),
    request: (made) => memUpdateItem(db, WT, made!.id, { instanceId: 'claude', ifVersion: made!.version, text: 'cli updated' }, deps()),
    landed: (made) => itemIs("id = ? AND text = 'cli updated'", made!.id),
  },
  'cli-close': {
    fn: 'memCloseItem',
    mode: 'on',
    before: () => addNote('to close'),
    request: (made) => memCloseItem(db, WT, made!.id, { instanceId: 'claude' }, deps()),
    landed: (made) => itemIs("id = ? AND state = 'closed'", made!.id),
  },
  'screen-on': screen('on'),
  'screen-off': screen('off'),
  'screen-derived': screen('derived'),
  // The condition's save: git is asked for `origin` before the write binds it.
  'condition-add': {
    fn: 'memAddItem',
    mode: 'on',
    request: () => memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'cond add', closeWhen: 'issue:#4221' }, deps()),
    landed: () => itemIs("text = 'cond add'"),
  },
  'condition-update': {
    fn: 'memUpdateItem',
    mode: 'on',
    before: async () => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'cond', closeWhen: 'manual' }, deps());
      const item = (outcome.body as MemWriteResponse).item;
      return { id: item.id, version: item.version };
    },
    request: (made) => memUpdateItem(db, WT, made!.id, { instanceId: 'claude', ifVersion: made!.version, closeWhen: 'issue:#4221' }, deps()),
    landed: (made) => itemIs("id = ? AND close_when LIKE '%\"issue\"%'", made!.id),
  },
  // A purge named through the worktree (`commandmate mem purge`): it must not delete
  // what the worktree made again under the same id and path writes (4th review・PM).
  // Issue #4225: the three transitions of a decision (A's entrance for E).
  'decision-record': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => addDecision('to record'),
    request: (made) => settleDecision(made!, 'record'),
    landed: decisionIs('recorded'),
  },
  'decision-promote': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => recordedDecision('to promote'),
    request: (made) => settleDecision(made!, 'promote'),
    landed: decisionIs('promoted'),
  },
  'decision-record-only': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => addDecision('record only'),
    request: (made) => settleDecision(made!, 'promote-record-only'),
    landed: decisionIs('promoted'),
  },
  // Issue #4227 (S-A・S-D): a person's add / edit / close from the screen, and the close
  // of a recorded decision a person confirmed is not reflected (`withdraw-recorded`).
  'screen-add': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    request: () => screenWrite('add', { kind: 'note', text: 'screen add', key: 'screen-add-1', expectBranch: 'feature/x' }),
    landed: () => itemIs("text = 'screen add' AND created_by = 'human'"),
  },
  'screen-update': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to screen update'),
    request: (made) => screenWrite('update', { ifVersion: made!.version, text: 'screen updated' }, made!.id),
    landed: (made) => itemIs("id = ? AND text = 'screen updated' AND updated_by = 'human'", made!.id),
  },
  'screen-close': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to screen close'),
    request: (made) => screenWrite('close', { ifVersion: made!.version }, made!.id),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND updated_by = 'human'", made!.id),
  },
  'screen-close-recorded': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => recordedDecision('to withdraw'),
    request: (made) => screenWrite('close', { ifVersion: made!.version, confirmUnreflected: true }, made!.id),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND close_reason = 'withdrawn'", made!.id),
  },
  'cli-purge': {
    fn: 'memPurge',
    mode: 'on',
    request: () => memPurge(db, { via: 'worktree', worktreeId: WT, branch: 'feature/x' }, { confirm: true }, deps()),
    during: async () => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'written after the request' }, deps());
      expect(outcome.status).toBe(201);
    },
    landed: () => !itemIs("text = 'written after the request'"),
  },
};

const MEM_DB = path.join(process.cwd(), 'src/lib/db/mem-db.ts');

/**
 * Ways into the service that write mem but are not refused by a re-creation of the
 * worktree, each with its reason. Kept in step with the source like the table.
 */
const NOT_BOUND_TO_A_WORKTREE_LIFETIME: Record<string, string> = {
  // None: `memPurge` was considered and is bound (an old purge named through the
  // worktree deleted what the re-created worktree wrote), so it is a row of the table.
};

interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}

/** Top-level `function` / `const … =` declarations of a source, each with its text. */
function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({
    name: match[2] ?? match[3],
    exported: Boolean(match[1]),
    body: source.slice(match.index, starts[i + 1]?.index ?? source.length),
  }));
}

const calls = (body: string, names: Set<string>) => [...names].some((name) => new RegExp(`\\b${name}\\(`).test(body));

/** Names of `chunks` that do `seed`, or call (within the file) one that does. */
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

/** The store's exported writes: functions of mem-db that INSERT / UPDATE / DELETE, directly or through its own helpers. */
function storeWriters(memDbSource: string): Set<string> {
  const chunks = chunksOf(memDbSource);
  const writes = closure(chunks, (chunk) => /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body));
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}

/** The service's exported functions that reach one of the store's writes. */
function writeEntrancesOf(serviceSource: string, writers: Set<string>): string[] {
  const chunks = chunksOf(serviceSource);
  const reach = closure(chunks, (chunk) => calls(chunk.body, writers));
  return chunks.filter((chunk) => chunk.exported && reach.has(chunk.name)).map((chunk) => chunk.name).sort();
}

const tableAndExceptions = () =>
  [...new Set([...Object.values(ENTRANCES).map((entry) => entry.fn), ...Object.keys(NOT_BOUND_TO_A_WORKTREE_LIFETIME)])].sort();

function sourcesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

beforeEach(() => {
  dir = makeTempDir('mem-entrances-4221-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  hold = null;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('every write of mem refuses a request the worktree’s re-creation overtook', () => {
  it('the table names every entrance (a new one fails here until it has a row)', () => {
    const writers = storeWriters(readFileSync(MEM_DB, 'utf8'));
    // The source of the check is the store's writes, not the actor (4th review P2).
    for (const known of ['replaceNowSlot', 'createMemItem', 'updateMemItem', 'closeMemItem', 'writeScreenNote', 'purgeMem']) {
      expect(writers.has(known)).toBe(true);
    }
    expect(writeEntrancesOf(readFileSync(SERVICE, 'utf8'), writers)).toEqual(tableAndExceptions());
    // A way is in the table or an exception, never both.
    const inTable = new Set(Object.values(ENTRANCES).map((entry) => entry.fn));
    expect(Object.keys(NOT_BOUND_TO_A_WORKTREE_LIFETIME).filter((name) => inTable.has(name))).toEqual([]);
    const screenModes = Object.values(ENTRANCES)
      .filter((entry) => entry.fn === 'writeSessionNoteFromScreen')
      .map((entry) => entry.mode)
      .sort();
    expect(screenModes).toEqual(['derived', 'off', 'on']);
    expect(Object.keys(ENTRANCES).filter((key) => key.startsWith('condition-')).length).toBeGreaterThan(0);
    // No way around the service: the store's writes are called from it alone.
    const storeCalls = /\b(replaceNowSlot|createMemItem|updateMemItem|closeMemItem|writeScreenNote)\(/;
    const callers = sourcesUnder(path.join(process.cwd(), 'src'))
      .filter((file) => !file.endsWith(path.join('lib', 'db', 'mem-db.ts')) && file !== SERVICE)
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => storeCalls.test(line) && !/^\s*(\/\/|\*)/.test(line)));
    expect(callers).toEqual([]);
  });

  it('the check catches a new way in that writes without an actor (and one through a helper)', () => {
    const writers = storeWriters(readFileSync(MEM_DB, 'utf8'));
    const service = readFileSync(SERVICE, 'utf8');
    const direct = `${service}\nexport async function memSweep(db: Database.Database): Promise<void> {\n  purgeMem(db, scope, {}, true);\n}\n`;
    expect(writeEntrancesOf(direct, writers)).toEqual([...tableAndExceptions(), 'memSweep'].sort());
    const viaHelper = `${service}\nfunction sweepHelper(db: Database.Database): void {\n  closeMemItem(db, actor, 'x', null);\n}\nexport function memSweepAll(db: Database.Database): void {\n  sweepHelper(db);\n}\n`;
    expect(writeEntrancesOf(viaHelper, writers)).toContain('memSweepAll');
    // And a new write of the store itself is a writer the check follows.
    const store = `${readFileSync(MEM_DB, 'utf8')}\nexport function eraseAll(db: Database.Database): void {\n  db.prepare('DELETE FROM mem_items').run();\n}\n`;
    expect(storeWriters(store).has('eraseAll')).toBe(true);
    // (control) a new read-only export is not a way to write.
    const reader = `${service}\nexport async function memPeek(db: Database.Database): Promise<unknown> {\n  return getMemRecord(db, 'x');\n}\n`;
    expect(writeEntrancesOf(reader, writers)).toEqual(tableAndExceptions());
  });

  it.each(Object.keys(ENTRANCES))('%s: deleted and made again (same id and path) during the await → refused, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = entry.before ? await entry.before() : undefined;
    setMode(entry.mode);
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    deleteWorktreesByIds(db, [WT]);
    makeWorktree();
    await entry.during?.();
    release();
    const outcome = await pending;
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(entry.landed(made)).toBe(false);
  });

  it.each(Object.keys(ENTRANCES))('%s (control): the worktree left as it was → the request lands', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = entry.before ? await entry.before() : undefined;
    setMode(entry.mode);
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    await entry.during?.();
    release();
    const outcome = await pending;
    expect(outcome.status).toBeLessThan(300);
    expect(entry.landed(made)).toBe(true);
  });
});

/**
 * Issue #4225 (§0.1 S1, the PM's condition): the decision rows keep the other two
 * invariants too — no write while the branch is `off` / `derived`, and a version that
 * is not the current one is refused. Each fails if the entrance's check is removed.
 */
describe('a decision moves only when the branch is on and the version is the one approved (Issue #4225)', () => {
  const decisionRows = Object.keys(ENTRANCES).filter((key) => key.startsWith('decision-'));

  it('has the three decision rows', () => {
    expect(decisionRows.sort()).toEqual(['decision-promote', 'decision-record', 'decision-record-only']);
  });

  it.each(decisionRows.flatMap((key) => [[key, 'off'] as const, [key, 'derived'] as const]))(
    '%s with the branch %s → refused (disabled), the row unchanged',
    async (key, mode) => {
      const entry = ENTRANCES[key];
      makeWorktree();
      setMode('on');
      const made = await entry.before!();
      setMode(mode);
      const outcome = await entry.request(made);
      expect(outcome.status).toBe(409);
      expect((outcome.body as { code: string }).code).toBe('disabled');
      expect(entry.landed(made)).toBe(false);
      expect(itemIs('id = ? AND version = ?', made.id, made.version)).toBe(true);
    }
  );

  it.each(decisionRows)('%s with a version one below the current → version_conflict, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = await entry.before!();
    const transition = key === 'decision-record' ? 'record' : key === 'decision-promote' ? 'promote' : 'promote-record-only';
    const outcome = await settleDecision(made, transition, made.version - 1);
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('version_conflict');
    expect(itemIs('id = ? AND version = ?', made.id, made.version)).toBe(true);
  });

  it.each(decisionRows)('%s: the item updated (version + 1) during the await → version_conflict, the state unchanged', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = await entry.before!();
    const state = (db.prepare('SELECT state FROM mem_items WHERE id = ?').get(made.id) as { state: string }).state;
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    // A person's edit (or any write) raises the version while the request waits on git.
    db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(made.id);
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('version_conflict');
    expect(itemIs('id = ? AND state = ? AND version = ?', made.id, state, made.version + 1)).toBe(true);
  });

  it('a transition the table forbids (promote an open decision) → state_forbids', async () => {
    makeWorktree();
    setMode('on');
    const made = await addDecision('open still');
    const outcome = await settleDecision(made, 'promote');
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('state_forbids');
  });

  it('a null lifetime is refused before anything is read', async () => {
    makeWorktree();
    setMode('on');
    const made = await addDecision('no lifetime');
    const outcome = await memSettleDecisionTransition(
      db,
      { worktreeId: WT, expectedWorktreeIncarnation: null, itemId: made.id, expectedVersion: made.version, transition: 'record' },
      deps()
    );
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(itemIs("id = ? AND state = 'open'", made.id)).toBe(true);
  });
});
