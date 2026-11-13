/**
 * Reading the decisions without the screen (Issue #4355, design
 * `docs/design/mem-decisions-ux-4355.md` §2・§3.4・§4.2・§6 PR1).
 *
 * The routes are called as Next calls them, against a migrated file database and real git
 * repositories made under `os.tmpdir()` (removed after each test). The states are made with
 * the promote service the screen drives (as `promote-entrances-4225.test.ts` makes T18), with
 * a fake gh. What `commandmate mem decisions` prints is then made from the routes' real
 * answers — not from a body written here.
 *
 * - I2: a read writes nothing (every row of every table, versions included; no gh).
 * - I5: an item that matches a current rule in its quote only, its evidence only or its
 *   destination only gives none of its text, quote or destination.
 * - I6: the counts (the shared function), I7: `--json` schema 1, I8: the operations' states.
 * - §4.2: another repository's item or worktree is 404; a document's worktree is never guessed.
 *
 * Nothing reaches GitHub, the production database or a server.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  exportedWriters,
  PROMOTE_WRITE_MODULES,
  SRC,
  specifiersOf,
  usesOf,
  MEM_DB,
} from '../../../lib/promote/promote-write-chain-4225.helpers';
import { FakeGh, failed } from '../../../lib/promote/fake-gh';

const spawned = vi.hoisted(() => [] as string[]);

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));
// Every child process the code under test starts is recorded (git is let through: the reads
// of HEAD and of the common dir are real; gh must never be started by a read).
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  const util = await import('util');
  const custom = util.promisify.custom;
  const realPromisified = (actual.execFile as unknown as Record<symbol, (...args: unknown[]) => unknown>)[custom];
  const execFile = Object.assign(
    (...args: unknown[]) => {
      spawned.push(String(args[0]));
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args);
    },
    {
      [custom]: (...args: unknown[]) => {
        spawned.push(String(args[0]));
        return realPromisified(...args);
      },
    }
  );
  return { ...actual, execFile };
});

import { setMockDb } from '@/lib/db/db-instance';
import { GET as getDecisions } from '@/app/api/repositories/[id]/mem/decisions/route';
import { GET as getDiff } from '@/app/api/repositories/[id]/mem/decisions/[itemId]/diff/route';
import { createRepository } from '@/lib/db/db-repository';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { memAddItem } from '@/lib/mem/service';
import { promoteApprove, promotePreview, type PromoteDeps } from '@/lib/promote/service';
import { summarizeDecisionCounts } from '@/lib/promote/decision-summary';
import { decisionCountsOf } from '@/lib/promote/decision-counts';
import { PROMOTE_REFERENCE_NOTICE, type PromoteOperationView, type PromotePreviewView, type PromoteReferenceDiffView } from '@/lib/promote/model';
import type { MemWriteResponse } from '@/types/mem';
import { decisionsLines, diffLines, toDecisionsJson, toDiffJson } from '../../../../../src/cli/commands/mem-decisions';
import type { PromoteListWire } from '../../../../../src/cli/types/mem-decisions';

const GHP = `ghp_${'d'.repeat(36)}`;
const BRANCH = 'feature/x';
const WT = 'wt-a';

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
let gh: FakeGh;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });

/** A real git repository on `branch` with `docs/d.md` committed, registered with mem `on`. */
function makeRepository(name: string, worktreeId: string): { root: string; id: string } {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, 'init', '-q', '-b', BRANCH);
  writeFileSync(path.join(root, 'docs/d.md'), '# d\n');
  git(root, 'add', 'docs/d.md');
  git(root, 'commit', '-q', '-m', 'init');
  const id = createRepository(db, { name, path: root, cloneSource: 'local' }).id;
  insertWorktree(worktreeId, root, root, BRANCH);
  setMode(id, 'on');
  return { root, id };
}
function insertWorktree(id: string, worktreePath: string, repositoryPath: string, branch: string | null): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch) VALUES (?, ?, ?, ?, 'repo', ?)`).run(
    id,
    id,
    worktreePath,
    repositoryPath,
    branch
  );
}
function setMode(repositoryId: string, mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repositoryId);
  saveMemSettings(db, repositoryId, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}

async function addDecision(worktreeId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const outcome = await memAddItem(db, worktreeId, { instanceId: 'claude', kind: 'decision', text: '方針を A にする', promoteTo: 'issue:#1', ...extra });
  expect(outcome.status).toBe(201);
  const made = (outcome.body as MemWriteResponse).item;
  return { id: made.id, version: made.version };
}

const headers = new Headers({ 'x-commandmate-client': 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' });
const SCREEN = { headers, url: 'http://localhost:3000/api/x' };
const promoteDeps = (hooks?: PromoteDeps['hooks']): PromoteDeps => ({ gh: gh.run, originUrl: async () => 'git@github.com:o/r.git', hooks });

/** A person's approval on the screen (preview, then approve), with gh answering as set up. */
async function approveOnScreen(itemId: string, hooks?: PromoteDeps['hooks']): Promise<PromoteOperationView> {
  const made = await promotePreview(db, SCREEN, repoA, itemId, { worktreeId: WT }, promoteDeps());
  expect(made.status).toBe(201);
  const p = (made.body as { preview: PromotePreviewView }).preview;
  const outcome = await promoteApprove(
    db,
    SCREEN,
    repoA,
    itemId,
    { previewId: p.id, itemVersion: p.itemVersion, baseFingerprint: p.baseFingerprint, bodySha256: p.bodySha256, acknowledgedOperationIds: p.acknowledgedOperationIds },
    promoteDeps(hooks)
  );
  return (outcome.body as { operation: PromoteOperationView }).operation;
}

function req(url: string): NextRequest {
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}
async function listRoute(repositoryId = repoA, branch = BRANCH): Promise<{ status: number; body: unknown }> {
  const response = await getDecisions(req(`http://localhost:3000/api/repositories/${repositoryId}/mem/decisions?branch=${encodeURIComponent(branch)}`), {
    params: Promise.resolve({ id: repositoryId }),
  });
  return { status: response.status, body: await response.json() };
}
async function diffRoute(itemId: string, query: Record<string, string> = {}, repositoryId = repoA): Promise<{ status: number; body: Record<string, unknown> }> {
  const search = new URLSearchParams(query).toString();
  const response = await getDiff(req(`http://localhost:3000/api/repositories/${repositoryId}/mem/decisions/${itemId}/diff${search ? `?${search}` : ''}`), {
    params: Promise.resolve({ id: repositoryId, itemId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Every row of every table (I2: the content and the version, not only the count). */
function snapshot(): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  return JSON.stringify(tables.map((table) => [table, (db.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()]));
}
const ghStarted = () => spawned.filter((file) => file === 'gh').length;

beforeEach(() => {
  dir = makeTempDir('mem-decisions-read-4355-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  setMockDb(db);
  gh = new FakeGh();
  ({ root: rootA, id: repoA } = makeRepository('root-a', WT));
  spawned.length = 0;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('I6: the counts of a branch, one function for every reader', () => {
  const items = (open: number, recorded = 1) => [
    ...Array.from({ length: open }, () => ({ kind: 'decision' as const, state: 'open' as const })),
    ...Array.from({ length: recorded }, () => ({ kind: 'decision' as const, state: 'recorded' as const })),
    { kind: 'decision' as const, state: 'promoted' as const },
    { kind: 'note' as const, state: 'open' as const },
  ];

  it.each([
    ['on', 2, { mode: 'on', approvable: true, open: 2, recorded: 1 }],
    ['on', 0, { mode: 'on', approvable: true, open: 0, recorded: 1 }],
    ['off', 2, { mode: 'off', approvable: false, open: 2, recorded: 1 }],
    ['off', 0, { mode: 'off', approvable: false, open: 0, recorded: 1 }],
    ['derived', 2, { mode: 'derived', approvable: false, open: 2, recorded: 1 }],
    ['derived', 0, { mode: 'derived', approvable: false, open: 0, recorded: 1 }],
    ['ambiguous', 2, { mode: 'ambiguous', approvable: false, open: null, recorded: null }],
    ['ambiguous', 0, { mode: 'ambiguous', approvable: false, open: null, recorded: null }],
  ] as const)('mode %s with %i open → %o (ambiguous is unknown, never 0)', (mode, open, expected) => {
    expect(decisionCountsOf(mode, items(open))).toEqual(expected);
  });

  it('the list route answers the counts, and the shared reader answers the same (on and off)', async () => {
    await addDecision(WT);
    await addDecision(WT);
    const listed = (await listRoute()).body as PromoteListWire;
    expect(listed.counts).toEqual({ mode: 'on', approvable: true, open: 2, recorded: 0 });
    expect(await summarizeDecisionCounts(db, repoA, BRANCH)).toEqual(listed.counts);

    setMode(repoA, 'off');
    const off = (await listRoute()).body as PromoteListWire;
    expect(off.counts).toEqual({ mode: 'off', approvable: false, open: 2, recorded: 0 });
    expect(await summarizeDecisionCounts(db, repoA, BRANCH)).toEqual(off.counts);
  });

  it('(control) a repository that is not there has no counts', async () => {
    expect(await summarizeDecisionCounts(db, 'no-such-repository', BRANCH)).toBeNull();
  });
});

describe('I8・I7: the operations of the list, from the route to what the CLI prints', () => {
  /** failed / unknown / succeeded / succeeded + transitionPending (T18), each on its own decision. */
  async function fourOperations() {
    const failedItem = await addDecision(WT, { text: 'failed の決定' });
    gh.override = (call) => (call.args.includes('--method') ? failed('HTTP 422: Validation Failed') : undefined);
    const failedOp = await approveOnScreen(failedItem.id);
    gh.override = undefined;

    const unknownItem = await addDecision(WT, { text: 'unknown の決定', quote: '「A にする」と人が言った', quoteAt: '2026-11-13T10:00:00+09:00' });
    gh.postAnswer = () => failed('', { code: null, timedOut: true });
    const unknownOp = await approveOnScreen(unknownItem.id);
    gh.postAnswer = undefined;

    const succeededItem = await addDecision(WT, { text: 'succeeded の決定' });
    const succeededOp = await approveOnScreen(succeededItem.id);

    const pendingItem = await addDecision(WT, { text: 'T18 の決定' });
    const pendingOp = await approveOnScreen(pendingItem.id, { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) });

    expect([failedOp.state, unknownOp.state, succeededOp.state, pendingOp.state]).toEqual(['failed', 'unknown', 'succeeded', 'succeeded']);
    expect(pendingOp.transitionPending).toBe(true);
    return { failedItem, unknownItem, succeededItem, pendingItem, failedOp, unknownOp, succeededOp, pendingOp };
  }

  it('each state is kept apart in --json and in the text, nothing folded into one "approved"', async () => {
    const made = await fourOperations();
    const listed = (await listRoute()).body as PromoteListWire;
    const json = toDecisionsJson(repoA, listed, false);
    const byId = new Map(json.decisions.map((decision) => [decision.id, decision]));

    expect(byId.get(made.failedItem.id)).toMatchObject({ state: 'open', humanApprovals: 1, operations: [{ state: 'failed', transitionPending: false }] });
    expect(byId.get(made.unknownItem.id)).toMatchObject({
      state: 'open',
      humanApprovals: 1,
      quote: '「A にする」と人が言った',
      operations: [{ state: 'unknown', unknownReason: 'timeout', transitionPending: false }],
    });
    expect(byId.get(made.succeededItem.id)).toMatchObject({ state: 'recorded', humanApprovals: 1, operations: [{ state: 'succeeded', transitionPending: false }] });
    // T18: written outside, the item did not move — open, one approval, the move pending.
    expect(byId.get(made.pendingItem.id)).toMatchObject({
      state: 'open',
      humanApprovals: 1,
      operations: [{ state: 'succeeded', transitionPending: true, transitionReason: 'version_conflict', concurrentEdit: false }],
    });

    const text = decisionsLines(json).join('\n');
    expect(text).toContain(`  op ${made.failedOp.id} failed decided-by=`);
    expect(text).toContain(`  op ${made.unknownOp.id} unknown unknown(timeout) decided-by=`);
    expect(text).toMatch(new RegExp(`  op ${made.succeededOp.id} succeeded decided-by=\\S+ effect=spec`));
    expect(text).toContain(`  op ${made.pendingOp.id} succeeded pending-transition(version_conflict) decided-by=`);
    expect(text).toContain(`${made.pendingItem.id} open v${made.pendingItem.version} by=agent(claude) to=issue:#1 quote=- approvals=1`);
    expect(text).toContain(`quote="「A にする」と人が言った"`);
    expect(text.split('\n').at(-1)).toBe('counts (before --pending): open=3 recorded=1 approvable=yes');
  });

  it('I7: --json schema 1 keeps its keys and types; --pending does not change counts and keeps what needs a reconcile', async () => {
    const made = await fourOperations();
    const listed = (await listRoute()).body as PromoteListWire;
    const all = toDecisionsJson(repoA, listed, false);
    const pending = toDecisionsJson(repoA, listed, true);

    const typesOf = (value: object) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry]));
    expect(typesOf(all)).toEqual({
      schema: 'number',
      repositoryId: 'string',
      branch: 'string',
      mode: 'string',
      counts: 'object',
      pending: 'boolean',
      decisions: 'array',
      unresolved: 'array',
    });
    expect(all.schema).toBe(1);
    expect(Object.keys(all.decisions[0]).sort()).toEqual(
      ['author', 'createdBy', 'humanApprovals', 'id', 'operations', 'promoteTo', 'quote', 'quoteAt', 'stale', 'state', 'text', 'version', 'withheld'].sort()
    );
    expect(Object.keys(all.decisions[0].operations[0]).sort()).toEqual(
      ['approvedAt', 'concurrentEdit', 'decidedBy', 'destination', 'effect', 'id', 'resultRef', 'settledAt', 'state', 'transitionPending', 'transitionReason', 'unknownReason'].sort()
    );
    expect(all.counts).toEqual({ open: 3, recorded: 1, approvable: true });

    expect(pending.counts).toEqual(all.counts);
    expect(pending.decisions.map((decision) => decision.id).sort()).toEqual([made.failedItem.id, made.unknownItem.id, made.pendingItem.id].sort());
    expect(all.decisions).toHaveLength(4);
  });
});

describe('the reference diff (§3.4.2・§4.2)', () => {
  it('draws the body as a reference: not approvable, no preview made, the quote unconfirmed', async () => {
    const made = await addDecision(WT, { quote: '人の言葉', quoteAt: '2026-11-13T10:00:00+09:00' });
    const { status, body } = await diffRoute(made.id, { worktreeId: WT });
    expect(status).toBe(200);
    const view = body as unknown as PromoteReferenceDiffView;
    expect(view).toMatchObject({ reference: true, approvable: false, notice: PROMOTE_REFERENCE_NOTICE, mode: 'on', effect: 'spec', quoteOrigin: 'agent' });
    expect(view.destination).toEqual({ resolved: true, kind: 'issue_comment', ref: 'issue', number: 1, target: null });
    expect(view.body).toContain('方針を A にする');
    expect(view.body).toContain('未確認');
    expect(view.body).toContain('<!-- commandmate-promote:op=; item=');

    const lines = diffLines(view);
    expect(lines[0]).toBe('REFERENCE ONLY — cannot be approved; approve on the screen');
    expect(toDiffJson(view)).toMatchObject({ schema: 1, reference: true, approvable: false });
    expect(toDiffJson(view)).not.toHaveProperty('ok');
  });

  it('a document destination resolves through the worktree named, and is never guessed', async () => {
    const made = await addDecision(WT, { promoteTo: 'path:docs/d.md' });
    expect((await diffRoute(made.id, { worktreeId: WT })).body.destination).toEqual({
      resolved: true,
      kind: 'worktree_doc',
      worktreeId: WT,
      path: 'docs/d.md',
      exists: true,
      headBranch: BRANCH,
    });
    // No worktree (the CLI's --repository): drawn, the destination unresolved.
    const none = await diffRoute(made.id);
    expect(none.status).toBe(200);
    expect(none.body.destination).toEqual({ resolved: false, kind: 'worktree_doc', reason: 'worktree_required' });

    git(rootA, 'worktree', 'add', '-q', '-b', 'other', path.join(dir, 'wt-other'));
    insertWorktree('wt-other', path.join(dir, 'wt-other'), rootA, 'other');
    expect((await diffRoute(made.id, { worktreeId: 'wt-other' })).body.destination).toEqual({ resolved: false, kind: 'worktree_doc', reason: 'branch_changed' });

    git(rootA, 'worktree', 'add', '-q', '--detach', path.join(dir, 'wt-detached'));
    insertWorktree('wt-detached', path.join(dir, 'wt-detached'), rootA, null);
    expect((await diffRoute(made.id, { worktreeId: 'wt-detached' })).body.destination).toEqual({ resolved: false, kind: 'worktree_doc', reason: 'branch_unresolved' });
  });

  it('the item and the worktree must be the repository’s own (404 otherwise); an unknown effect is 400', async () => {
    const own = await addDecision(WT);
    const { id: repoB } = makeRepository('root-b', 'wt-b');
    const other = await addDecision('wt-b');
    expect((await diffRoute(other.id, {}, repoA)).status).toBe(404);
    expect((await diffRoute(own.id, { worktreeId: 'wt-b' })).status).toBe(404);
    expect((await diffRoute(own.id, { worktreeId: 'no-such-worktree' })).status).toBe(404);
    expect((await diffRoute('no-such-item')).status).toBe(404);
    expect((await diffRoute(own.id, {}, 'no-such-repository')).status).toBe(404);
    // (control) through its own repository the other item is drawn.
    expect((await diffRoute(other.id, {}, repoB)).status).toBe(200);
    expect(await diffRoute(own.id, { effect: 'publish' })).toMatchObject({ status: 400, body: { code: 'invalid_request', field: 'effect' } });
    expect((await diffRoute(own.id, { effect: 'record_only' })).body.effect).toBe('record_only');
  });

  it('a note is not a decision → 404', async () => {
    const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'メモ' });
    const note = (outcome.body as MemWriteResponse).item;
    expect((await diffRoute(note.id)).status).toBe(404);
  });
});

describe('I5: a match anywhere in the item withholds all of it', () => {
  /** Stored under an older rule set, the field set to a value the current rules match. */
  function storeOld(itemId: string, column: 'quote' | 'evidence' | 'promote_to', value: string): void {
    db.prepare(`UPDATE mem_items SET ${column} = ?, checked_rules_version = 0 WHERE id = ?`).run(value, itemId);
  }

  it.each([
    ['quote only', 'quote', `引用 ${GHP}`, 'quote'],
    ['evidence only', 'evidence', JSON.stringify([`url:https://example.invalid/${GHP}`]), 'evidence'],
    ['the destination only', 'promote_to', `path:docs/${GHP}.md`, 'promoteTo'],
  ] as const)('%s: the diff answers 422 with the field name only; the list shows none of the free fields', async (_name, column, value, field) => {
    const made = await addDecision(WT, { quote: '無害な引用', quoteAt: '2026-11-13T10:00:00+09:00' });
    storeOld(made.id, column, value);

    const { status, body } = await diffRoute(made.id, { worktreeId: WT });
    expect(status).toBe(422);
    expect(body).toEqual({ ok: false, code: 'secret_like', message: expect.any(String), field });
    const raw = JSON.stringify(body);
    for (const leaked of [GHP, '方針を A にする', '無害な引用', 'issue:#1']) expect(raw).not.toContain(leaked);

    const json = toDecisionsJson(repoA, (await listRoute()).body as PromoteListWire, false);
    expect(json.decisions[0]).toMatchObject({ text: null, quote: null, promoteTo: null, quoteAt: null, withheld: { code: 'secret_like', field } });
    const printed = `${JSON.stringify(json)}\n${decisionsLines(json).join('\n')}`;
    for (const leaked of [GHP, '方針を A にする', '無害な引用']) expect(printed).not.toContain(leaked);
  });

  it('(control) the same item under the rule set it was checked with is drawn', async () => {
    const made = await addDecision(WT, { quote: '無害な引用', quoteAt: '2026-11-13T10:00:00+09:00' });
    expect((await diffRoute(made.id, { worktreeId: WT })).status).toBe(200);
  });
});

describe('I2: reading writes nothing', () => {
  it('the list and the diff, answered or refused, leave every row (content and version) as it was, and start no gh', async () => {
    const made = await addDecision(WT, { promoteTo: 'path:docs/d.md' });
    const t18 = await addDecision(WT);
    await approveOnScreen(t18.id, { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) });
    const before = snapshot();
    spawned.length = 0;

    expect((await listRoute()).status).toBe(200);
    expect((await diffRoute(made.id, { worktreeId: WT })).status).toBe(200);
    expect((await diffRoute(t18.id, { worktreeId: WT })).status).toBe(200);
    expect((await diffRoute(made.id)).status).toBe(200);
    expect((await diffRoute(made.id, { effect: 'x' })).status).toBe(400);
    expect((await diffRoute('no-such-item')).status).toBe(404);
    expect((await listRoute('no-such-repository')).status).toBe(404);

    expect(snapshot()).toBe(before);
    expect(ghStarted()).toBe(0);
    expect(readFileSync(path.join(rootA, 'docs/d.md'), 'utf8')).toBe('# d\n');
  });

  it('(positive control) the snapshot sees an UPDATE that keeps the row count, which a count would not', async () => {
    const made = await addDecision(WT);
    const before = snapshot();
    const rows = (db.prepare('SELECT COUNT(*) n FROM mem_items').get() as { n: number }).n;
    db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(made.id);
    expect((db.prepare('SELECT COUNT(*) n FROM mem_items').get() as { n: number }).n).toBe(rows);
    expect(snapshot()).not.toBe(before);
  });

  it('the readers call no write of the store, the promote records, gh or the document', () => {
    const files = ['lib/promote/reference-diff.ts', 'lib/promote/decision-summary.ts', 'lib/promote/decision-counts.ts'].map((file) => path.join(SRC, file));
    const writeModules = [
      ...PROMOTE_WRITE_MODULES(),
      { file: MEM_DB, writers: exportedWriters(readFileSync(MEM_DB, 'utf8')) },
      { file: path.join(SRC, 'lib/mem/incarnation.ts'), writers: new Set(['getOrCreateWorktreeIncarnation']) },
      { file: path.join(SRC, 'lib/promote/github-write.ts'), writers: new Set(['defaultGhRun', 'readGhIssue', 'readGhUser', 'readGhToken', 'listGhComments']) },
    ];
    const used = files.flatMap((file) => writeModules.flatMap(({ file: module, writers }) => usesOf(readFileSync(file, 'utf8'), specifiersOf(file, module), writers).map((name) => `${path.basename(file)}: ${name}`)));
    expect(used).toEqual([]);
  });

  it('(positive control) the same reading catches a reader that would make a preview row', () => {
    const file = path.join(SRC, 'lib/promote/reference-diff.ts');
    const changed = `import { insertPromotePreview } from '@/lib/db/mem-promote-db';\n${readFileSync(file, 'utf8')}\nexport const x = (db: never) => insertPromotePreview(db, {} as never);\n`;
    const promoteDb = PROMOTE_WRITE_MODULES()[0];
    expect(usesOf(changed, specifiersOf(file, promoteDb.file), promoteDb.writers)).toEqual(['insertPromotePreview']);
  });
});
