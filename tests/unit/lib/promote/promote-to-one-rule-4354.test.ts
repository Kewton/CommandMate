/**
 * One check of `promote_to` for every entrance (Issue #4354, the PR1a scope added on 2026-11-21):
 *
 * - I-B1 (the rule that does not depend on the disk): the write (`validatePromoteTo`) and the
 *   preview / approval / write (`checkDocPath`) give the same answer by that rule, because both
 *   go through `checkPromoteToPath`. The table makes every parent directory first
 *   (`makeParents`) and then asks both, so the checks the preview alone makes of the disk (a
 *   parent that exists, an existing entry that is a regular file, at most 1 MiB) cannot differ
 *   there. Those the write does not make are a known gap, pinned by its own test (#4354 P2-1).
 * - I-B2: an agent's instruction file (`AGENT_INSTRUCTION_PATHS`, any case) and a destination that
 *   is not a `.md` are refused when written: `invalid_promote_to` with its reason (CLI exit 2).
 *   `.git` is refused when written as before, by the normalization (`sensitive_path`).
 * - I-B3: a row written before (an instruction file as its destination) is kept, listed and
 *   presented with the reason; its preview — so its approval — is refused.
 * - The entrances that take a `promote_to` are read from the sources (the services and the
 *   routes): a new one that does not call the shared check fails here.
 *
 * Every worktree and the database live in a `mkdtemp` sandbox under `os.tmpdir()`, removed after
 * each test. Nothing reaches GitHub, a server or the production database.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
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
import { getMemRecord, getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { memAddItem, memList, memWriteFromScreen, type MemServiceDeps } from '@/lib/mem/service';
import { presentMemItem } from '@/lib/mem/present';
import { checkPromoteToPath, validateMemFields, validatePromoteTo } from '@/lib/mem/validate';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { AGENT_INSTRUCTION_PATHS, checkDocPath } from '@/lib/promote/destination';
import { promoteToPathRule, storedPromoteToRefusal } from '@/lib/promote/promote-to-rule';
import { promoteList, promotePreview, type PromoteDeps } from '@/lib/promote/service';
import { MEM_EXIT_BY_CODE, type MemErrorCode, type MemItemView, type MemListResponse, type MemWriteResponse } from '@/types/mem';
import { FakeGh } from './fake-gh';
import { callsAny, chunksOf, sourcesUnder, SRC } from './promote-write-chain-4225.helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-b';
const BRANCH = 'feature/x';

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
let gh: FakeGh;
let head: WorktreeHeadObservation;

const memDeps = (): MemServiceDeps => ({
  resolveCommonDir: async () => '/common/.git',
  pathExists: () => true,
  observe: async () => ({ ...head }),
  git: { originUrl: async () => 'git@github.com:o/r.git', refTip: async () => SHA },
});
const deps = (): PromoteDeps => ({ gh: gh.run, originUrl: async () => 'git@github.com:o/r.git', mem: memDeps(), bootId: () => 'boot-1' });

const wtPath = () => path.join(dir, WT);
const headers = new Headers({ 'x-commandmate-client': 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' });
const SCREEN = { headers, url: 'http://localhost:3000/api/x' };

const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const promoteRows = () =>
  count('SELECT COUNT(*) n FROM mem_promote_previews') + count('SELECT COUNT(*) n FROM mem_promote_operations') + count('SELECT COUNT(*) n FROM mem_promote_attempts');
const bodyOf = (outcome: { body: unknown }) => outcome.body as { code?: MemErrorCode; reason?: string; field?: string };

/** Make `rel`'s parent directories in the worktree (the preview asks that they exist). */
function makeParents(root: string, rel: string): void {
  const parent = path.posix.dirname(rel);
  if (parent !== '.') mkdirSync(path.join(root, ...parent.split('/')), { recursive: true });
}

function setOn(): void {
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode: 'on' }] });
}

beforeEach(() => {
  dir = makeTempDir('promote-to-one-rule-4354-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  mkdirSync(path.join(wtPath(), 'docs'), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch) VALUES (?, ?, ?, ?, 'repo', ?)`).run(
    WT,
    WT,
    wtPath(),
    rootA,
    BRANCH
  );
  gh = new FakeGh();
  head = { branch: BRANCH, detached: false, head: SHA, commonDir: '/common/.git', known: true };
  setOn();
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

/** A path each row of `AGENT_INSTRUCTION_PATHS` refuses (the shape the 4225 table uses). */
function instructionPathOf(entry: (typeof AGENT_INSTRUCTION_PATHS)[number]): string {
  if (entry.match === 'dir') return `${entry.name}/x.md`;
  if (entry.match === 'file') return entry.name.toLowerCase().endsWith('.md') ? entry.name : `${entry.name}/x.md`;
  return entry.name.toLowerCase().endsWith('.md') ? entry.name : `${entry.name}/x.md`;
}

/**
 * The table: a relative path, and whether the rule that does not depend on the disk accepts it.
 * Every row makes its parent directories first (`makeParents`), then is asked of the write and of
 * the preview's check; both must answer the row.
 */
const TABLE: ReadonlyArray<readonly [string, boolean]> = [
  ['docs/d.md', true],
  ['docs/claude-notes.md', true],
  ['docs/CLAUDE.md.md', true],
  ['README.md', true],
  ['docs/x.MD', true],
  ['claude/x.md', true],
  ['CLAUDE.md', false],
  ['claude.md', false],
  ['Claude.MD', false],
  ['AGENTS.md', false],
  ['agents.md', false],
  ['docs/CLAUDE.md', false],
  ['.claude/x.md', false],
  ['.CLAUDE/x.md', false],
  ['.github/copilot-instructions.md', false],
  ['.GIT/x.md', false],
  ['docs/x.txt', false],
  ['docs/x', false],
  ['docs/.md', false],
  ...AGENT_INSTRUCTION_PATHS.map((entry) => [instructionPathOf(entry), false] as const),
];

describe('I-B1: the write and the preview give the same answer by the rule that does not depend on the disk (one table)', () => {
  it.each(TABLE)('%s → accepted=%s by the write and by the preview alike (parents made first)', (rel, accepted) => {
    // The parents exist before both are asked: only the rule that does not depend on the disk can differ.
    makeParents(wtPath(), rel);
    const written = validatePromoteTo(`path:${rel}`, wtPath());
    const previewed = checkDocPath(wtPath(), rel);
    expect(written.ok).toBe(accepted);
    expect(previewed.ok).toBe(accepted);
    expect(written.ok).toBe(previewed.ok);
    if (written.ok && previewed.ok) expect(written.value).toBe(`path:${previewed.rel}`);
  });

  it('既知の残り（#4354 P2-1）。書くときの拒否を入れたら、この試験は赤になる: a parent that does not exist is accepted when written and refused by the preview', async () => {
    const rel = 'docs/decisions/x.md';
    expect(existsSync(path.join(wtPath(), 'docs', 'decisions'))).toBe(false);
    expect(validatePromoteTo(`path:${rel}`, wtPath())).toEqual({ ok: true, value: `path:${rel}` });
    const added = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text: '方針', promoteTo: `path:${rel}` }, memDeps());
    expect(added.status).toBe(201);
    const made = (added.body as MemWriteResponse).item;
    expect(made.promoteToRefusal).toBeUndefined();
    expect(checkDocPath(wtPath(), rel)).toEqual({ ok: false, code: 'invalid_destination' });
    const previewed = await promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps());
    expect(bodyOf(previewed)).toMatchObject({ code: 'invalid_destination', reason: 'invalid_destination' });
    expect(promoteRows()).toBe(0);
  });

  it('every refusal of the shared rule is the write’s invalid_promote_to with its reason', () => {
    expect(checkPromoteToPath('CLAUDE.md', wtPath())).toEqual({ ok: false, error: { code: 'invalid_promote_to', field: 'promoteTo', reason: 'agent_instructions' } });
    mkdirSync(path.join(wtPath(), '.GIT'), { recursive: true });
    // `.git` is a sensitive name to the normalization already; the rule keeps its own line for it.
    expect(checkPromoteToPath('.GIT/x.md', wtPath())).toMatchObject({ ok: false, error: { code: 'sensitive_path' } });
    expect(promoteToPathRule('.GIT/x.md')).toBe('git_dir');
    expect(promoteToPathRule('docs/.git/x.md')).toBe('git_dir');
    expect(checkPromoteToPath('docs/x.txt', wtPath())).toMatchObject({ ok: false, error: { code: 'invalid_promote_to', reason: 'not_markdown' } });
    // The preview names them in its own words, as before (#4225 P3-8, T12).
    expect(checkDocPath(wtPath(), 'CLAUDE.md')).toEqual({ ok: false, code: 'agent_instructions' });
    expect(checkDocPath(wtPath(), '.GIT/x.md')).toEqual({ ok: false, code: 'sensitive_path' });
    expect(checkDocPath(wtPath(), 'docs/x.txt')).toEqual({ ok: false, code: 'invalid_destination' });
  });

  it('(control) an Issue / PR and no destination are the grammar’s, not the path rule’s', () => {
    expect(validatePromoteTo('issue:#1', wtPath())).toEqual({ ok: true, value: 'issue:#1' });
    expect(validatePromoteTo('pr:o/r/x#2', wtPath())).toEqual({ ok: true, value: 'pr:o/r/x#2' });
    expect(validatePromoteTo(undefined, wtPath())).toEqual({ ok: true, value: null });
    expect(storedPromoteToRefusal('issue:#1')).toBeNull();
    expect(storedPromoteToRefusal(null)).toBeNull();
    expect(promoteToPathRule('docs/d.md')).toBeNull();
  });
});

describe('I-B2: an instruction file is refused when written (exit 2, the reason)', () => {
  it.each(['CLAUDE.md', 'AGENTS.md', '.claude/x.md', 'claude.md', 'Agents.MD', 'docs/CLAUDE.md'])(
    'mem add --kind decision --promote-to path:%s → invalid_promote_to (agent_instructions), exit 2, nothing stored',
    async (rel) => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text: '方針', promoteTo: `path:${rel}` }, memDeps());
      expect(outcome.status).toBe(400);
      expect(bodyOf(outcome)).toMatchObject({ code: 'invalid_promote_to', field: 'promoteTo', reason: 'agent_instructions' });
      expect(MEM_EXIT_BY_CODE[bodyOf(outcome).code as MemErrorCode]).toBe(2);
      expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
    }
  );

  it('the screen’s add is refused the same way (the same function)', async () => {
    const outcome = await memWriteFromScreen(
      db,
      SCREEN,
      WT,
      { op: 'add', author: 'human', body: { instanceId: 'claude', kind: 'decision', text: '方針', promoteTo: 'path:CLAUDE.md', key: 'k-1', expectBranch: BRANCH } },
      memDeps()
    );
    expect(bodyOf(outcome)).toMatchObject({ code: 'invalid_promote_to', reason: 'agent_instructions' });
    expect(count('SELECT COUNT(*) n FROM mem_items')).toBe(0);
  });

  it('a handoff proposal’s check (validateMemFields) is refused the same way', () => {
    expect(validateMemFields('decision', { text: '方針', promoteTo: 'path:AGENTS.md' }, wtPath())).toMatchObject({
      ok: false,
      error: { code: 'invalid_promote_to', reason: 'agent_instructions' },
    });
  });

  it('(control) a document beside them is still stored, and its preview is made', async () => {
    const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text: '方針', promoteTo: 'path:docs/claude-notes.md' }, memDeps());
    expect(outcome.status).toBe(201);
    const made = (outcome.body as MemWriteResponse).item;
    expect(made.promoteToRefusal).toBeUndefined();
    expect((await promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps())).status).toBe(201);
  });
});

describe('I-B3: a row written before is kept and shown with its reason; its approval is refused', () => {
  /** A decision whose destination is an instruction file, as a server before this one stored it. */
  async function oldRow(rel: string): Promise<string> {
    const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text: '古い決定', promoteTo: 'path:docs/d.md' }, memDeps());
    const id = (outcome.body as MemWriteResponse).item.id;
    db.prepare('UPDATE mem_items SET promote_to = ? WHERE id = ?').run(`path:${rel}`, id);
    return id;
  }

  it('listed by mem list and by the decision list, presented with promoteToRefusal', async () => {
    const id = await oldRow('CLAUDE.md');
    const record = getMemRecord(db, id)!;
    expect(presentMemItem(record)).toMatchObject({ id, state: 'open', promoteTo: 'path:CLAUDE.md', promoteToRefusal: 'agent_instructions' });

    const listed = (await memList(db, { via: 'worktree', worktreeId: WT }, {}, memDeps())).body as MemListResponse;
    expect(listed.items.find((view) => view.id === id)).toMatchObject({ promoteToRefusal: 'agent_instructions' });

    const decisions = (await promoteList(db, repoA, BRANCH, { mem: memDeps(), bootId: () => 'boot-1' })).body as { decisions: Array<{ item: MemItemView }> };
    expect(decisions.decisions.map((entry) => entry.item)).toEqual([expect.objectContaining({ id, promoteToRefusal: 'agent_instructions' })]);
  });

  it.each(['CLAUDE.md', '.claude/commands/x.md', 'AGENTS.md'])('%s: its preview is refused with the reason; no preview, nothing written', async (rel) => {
    const id = await oldRow(rel);
    const outcome = await promotePreview(db, SCREEN, repoA, id, { worktreeId: WT }, deps());
    expect(bodyOf(outcome)).toMatchObject({ code: 'invalid_destination', reason: 'agent_instructions' });
    expect(promoteRows()).toBe(0);
    expect(existsSync(path.join(wtPath(), rel))).toBe(false);
    expect(getMemRecord(db, id)).toMatchObject({ state: 'open', promoteTo: `path:${rel}` });
  });

  it('(control) a row whose destination can be used carries no promoteToRefusal', async () => {
    const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text: '新しい決定', promoteTo: 'issue:#1' }, memDeps());
    const record = getMemRecord(db, (outcome.body as MemWriteResponse).item.id)!;
    expect('promoteToRefusal' in presentMemItem(record)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The entrances, read from the sources
// ---------------------------------------------------------------------------

/**
 * What acts on a destination: stores one (`createMemItem`), resolves one to write to
 * (`parsePromoteTo`), or writes to one (`claimPromoteOperation`, `writeDocBlock`, an `fs` write
 * under `src/lib/promote/`).
 */
const SINKS = ['createMemItem', 'parsePromoteTo', 'claimPromoteOperation', 'writeDocBlock'];
const FS_SINK = /\b(?:writeSync|linkSync)\s*\(/;
/** The calls that reach `checkPromoteToPath` (each is checked below to do so). */
const GATES = ['validateMemFields', 'validatePromoteTo', 'checkDocPath', 'checkPromoteToPath', 'prepareScreenWrite'];
/** Where a sink is defined, not used. */
const DEFINITIONS = new Set(['src/lib/db/mem-db.ts', 'src/lib/db/mem-promote-db.ts', 'src/lib/promote/destination.ts']);

/** The pinned entrances: `file#function` → the gate it calls. A new entrance fails until it has a row. */
const ENTRANCES: Record<string, string> = {
  'src/lib/mem/service.ts#memAddItem': 'validateMemFields',
  'src/lib/mem/service.ts#memWriteFromScreen': 'prepareScreenWrite',
  'src/lib/promote/service.ts#promotePreview': 'validatePromoteTo',
  'src/lib/promote/service.ts#promoteApprove': 'checkDocPath',
  'src/lib/promote/reference-diff.ts#destinationOf': 'checkDocPath',
  'src/lib/promote/doc-write.ts#writeDocBlock': 'checkDocPath',
};

/** The functions that pass a destination on to the shared check, and what they call to do it. */
const GATE_CHAIN: Array<{ file: string; name: string; calls: string }> = [
  { file: 'src/lib/mem/service.ts', name: 'prepareScreenWrite', calls: 'validateMemFields' },
  { file: 'src/lib/mem/validate.ts', name: 'validateMemFields', calls: 'validatePromoteTo' },
  { file: 'src/lib/mem/validate.ts', name: 'validatePromoteTo', calls: 'validateStructured' },
  { file: 'src/lib/mem/validate.ts', name: 'validateStructured', calls: 'checkPromoteToPath' },
  { file: 'src/lib/promote/destination.ts', name: 'checkDocPath', calls: 'checkPromoteToPath' },
  { file: 'src/lib/mem/validate.ts', name: 'checkPromoteToPath', calls: 'promoteToPathRule' },
];

const bodyAfterSignature = (body: string) => body.slice(body.indexOf('{'));

/** `file#function` of every top-level function of `sources` that reaches a sink. */
function entrancesOf(sources: ReadonlyArray<{ rel: string; source: string }>): Map<string, string> {
  const found = new Map<string, string>();
  for (const { rel, source } of sources) {
    if (DEFINITIONS.has(rel)) continue;
    const fsSinks = rel.startsWith('src/lib/promote/');
    for (const chunk of chunksOf(source)) {
      const body = bodyAfterSignature(chunk.body);
      if (callsAny(body, SINKS) || (fsSinks && FS_SINK.test(body))) found.set(`${rel}#${chunk.name}`, body);
    }
  }
  return found;
}

const ALL_SOURCES = () =>
  sourcesUnder(SRC).map((file) => ({ rel: path.relative(path.dirname(SRC), file).split(path.sep).join('/'), source: readFileSync(file, 'utf8') }));

describe('the entrances that take a promote_to all call the shared check (read from the sources)', () => {
  it('the entrances found in src/ (services and routes) are exactly the pinned ones', () => {
    expect([...entrancesOf(ALL_SOURCES()).keys()].sort()).toEqual(Object.keys(ENTRANCES).sort());
  });

  it.each(Object.entries(ENTRANCES))('%s calls %s', (key, gate) => {
    const body = entrancesOf(ALL_SOURCES()).get(key);
    expect(body).toBeDefined();
    expect(callsAny(body!, [gate])).toBe(true);
  });

  it.each(GATE_CHAIN)('$file $name reaches the shared check through $calls', ({ file, name, calls }) => {
    const chunk = chunksOf(readFileSync(path.join(path.dirname(SRC), file), 'utf8')).find((entry) => entry.name === name);
    expect(chunk).toBeDefined();
    expect(callsAny(bodyAfterSignature(chunk!.body), [calls])).toBe(true);
  });

  it('every route under src/app/api that writes or resolves a destination does it through a pinned entrance', () => {
    const routes = ALL_SOURCES().filter((entry) => entry.rel.startsWith('src/app/api/'));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect([route.rel, callsAny(route.source, SINKS) || FS_SINK.test(route.source)]).toEqual([route.rel, false]);
  });

  it('(positive control) a new function that stores a destination without the check is found and has no gate', () => {
    const service = readFileSync(path.join(SRC, 'lib/mem/service.ts'), 'utf8');
    const added = `${service}\nexport function memSideDoor(db: Database.Database, input: MemNewItem): void {\n  createMemItem(db, input);\n}\n`;
    const found = entrancesOf([{ rel: 'src/lib/mem/service.ts', source: added }]);
    expect(found.has('src/lib/mem/service.ts#memSideDoor')).toBe(true);
    expect(callsAny(found.get('src/lib/mem/service.ts#memSideDoor')!, GATES)).toBe(false);
  });

  it('(positive control) a check of the destination dropped from the preview is seen', () => {
    const service = readFileSync(path.join(SRC, 'lib/promote/service.ts'), 'utf8').replace(/validatePromoteTo\(/g, 'Object.freeze(');
    const found = entrancesOf([{ rel: 'src/lib/promote/service.ts', source: service }]);
    expect(callsAny(found.get('src/lib/promote/service.ts#promotePreview')!, [ENTRANCES['src/lib/promote/service.ts#promotePreview']])).toBe(false);
  });
});

