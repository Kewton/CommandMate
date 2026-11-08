/**
 * The invariant every write of mem keeps (Issue #4221, 2nd・3rd integration review):
 * a request read before the worktree was deleted and made again under the same id
 * and path is refused, whatever the entrance and the mode; one the worktree was
 * left alone for lands.
 *
 * One table, one test each way. The table's keys are checked against the entrances
 * themselves: every exported function of `src/lib/mem/service.ts` that fixes an
 * actor (`lookupActor`), each mode of the screen's save, and the condition's save
 * — so a new entrance without a row here fails the first test.
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
import {
  memAddItem,
  memCloseItem,
  memUpdateItem,
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
};

/** The exported functions of the service that fix an actor: each is a way to write. */
function writeEntrancesOfService(): string[] {
  const source = readFileSync(SERVICE, 'utf8');
  const starts = [...source.matchAll(/^export async function (\w+)\(/gm)];
  return starts
    .filter((match, i) => source.slice(match.index, starts[i + 1]?.index ?? source.length).includes('lookupActor('))
    .map((match) => match[1])
    .sort();
}

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
    expect([...new Set(Object.values(ENTRANCES).map((entry) => entry.fn))].sort()).toEqual(writeEntrancesOfService());
    const screenModes = Object.values(ENTRANCES)
      .filter((entry) => entry.fn === 'writeSessionNoteFromScreen')
      .map((entry) => entry.mode)
      .sort();
    expect(screenModes).toEqual(['derived', 'off', 'on']);
    expect(Object.keys(ENTRANCES).filter((key) => key.startsWith('condition-')).length).toBeGreaterThan(0);
    // No way around the service: the store's writes are called from it alone.
    const writers = /\b(replaceNowSlot|createMemItem|updateMemItem|closeMemItem|writeScreenNote)\(/;
    const callers = sourcesUnder(path.join(process.cwd(), 'src'))
      .filter((file) => !file.endsWith(path.join('lib', 'db', 'mem-db.ts')) && file !== SERVICE)
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => writers.test(line) && !/^\s*(\/\/|\*)/.test(line)));
    expect(callers).toEqual([]);
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
    release();
    const outcome = await pending;
    expect(outcome.status).toBeLessThan(300);
    expect(entry.landed(made)).toBe(true);
  });
});
