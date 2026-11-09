/**
 * The invariants of every entrance of the promote path (Issue #4225, design §7, the
 * PM's table): one table of the entrances that write (the database, a comment, a
 * document or the item's state), and each invariant run against it —
 *
 * (a) a request the worktree's delete and re-creation (same id and path) overtook is refused;
 * (b) `off` / `derived` write nothing (the outcome of a write already outside is still kept, E1);
 * (c) a version, destination or fingerprint that changed is not written: back to a new approval;
 * (d) an unknown outcome is never sent again by itself, and nothing is written twice;
 * (e) only the screen's path changes anything;
 * (f) nothing commits or pushes.
 *
 * The table is checked against the service itself, enumerated from the write side: the
 * exported functions of `src/lib/promote/service.ts` that reach a write of
 * `mem-promote-db.ts`, A's entrance, `github-write.ts` or `doc-write.ts`, helpers
 * included — a new way in fails the first test until it has a row.
 *
 * gh is a fake (`fake-gh.ts`) and the worktrees live in a `mkdtemp` sandbox removed
 * after each test. Nothing reaches GitHub, the production database or a server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
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
import { memAddItem, memCloseItem, memPurge, memUpdateItem, type MemServiceDeps } from '@/lib/mem/service';
import { renameWorktreeIdPreservingChildren } from '@/lib/db/migrations/worktree-id-rename';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { PromoteOperationView, PromotePreviewView } from '@/lib/promote/model';
import {
  promoteAbandon,
  promoteApprove,
  promoteConfirmReflected,
  promoteList,
  promotePreview,
  promoteReconcile,
  promoteSettleTransition,
  type PromoteDeps,
} from '@/lib/promote/service';
import { tempNameOf } from '@/lib/promote/doc-write';
import { promoteApi } from '@/lib/promote/screen-client';
import type { MemWriteResponse } from '@/types/mem';
import { FakeGh, failed } from './fake-gh';
import { writeEntrancesOfPromote } from './promote-write-chain-4225.helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-p';

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
let gh: FakeGh;
let head: WorktreeHeadObservation;
let origin: string;
let clock: number | null;
let boot: string;
let promoteHooks: PromoteDeps['hooks'];
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
/** Let pending promises run until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(cond()).toBe(true);
}

/** The git every root is judged by (5-2c P2-2: a root of another git is not the same repository). */
let commonDirOf: (rootPath: string) => string = () => '/common/.git';
const memDeps = (): MemServiceDeps => ({
  resolveCommonDir: async (rootPath: string) => commonDirOf(rootPath),
  pathExists: () => true,
  observe: async () => {
    await held();
    return { ...head };
  },
  git: { originUrl: async () => origin, refTip: async () => SHA },
});
const deps = (): PromoteDeps => ({
  gh: gh.run,
  originUrl: async () => origin,
  mem: memDeps(),
  now: () => clock ?? Date.now(),
  bootId: () => boot,
  hooks: promoteHooks,
});

const wtPath = () => path.join(dir, 'wt-p');
const docPath = (rel = 'docs/d.md') => path.join(wtPath(), rel);
function makeWorktree(): void {
  mkdirSync(path.join(wtPath(), 'docs'), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch) VALUES (?, ?, ?, ?, 'repo', 'feature/x')`).run(
    WT,
    WT,
    wtPath(),
    rootA
  );
}
function recreateWorktree(): void {
  deleteWorktreesByIds(db, [WT]);
  makeWorktree();
}
function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}

const headers = (marked: boolean) =>
  new Headers(marked ? { 'x-commandmate-client': 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' } : { host: 'localhost:3000' });
const SCREEN = { headers: headers(true), url: 'http://localhost:3000/api/x' };
const NOT_SCREEN = { headers: headers(false), url: 'http://localhost:3000/api/x' };

const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const promoteRows = () =>
  count('SELECT COUNT(*) n FROM mem_promote_previews') + count('SELECT COUNT(*) n FROM mem_promote_operations') + count('SELECT COUNT(*) n FROM mem_promote_attempts');
const item = (id: string) => db.prepare('SELECT state, version FROM mem_items WHERE id = ?').get(id) as { state: string; version: number };
const op = (id: string) =>
  db.prepare('SELECT state, transition_pending, transition_reason, unknown_reason, concurrent_edit, poster_id FROM mem_promote_operations WHERE id = ?').get(id) as {
    state: string;
    transition_pending: number;
    transition_reason: string | null;
    unknown_reason: string | null;
    concurrent_edit: number;
    poster_id: number | null;
  };

async function addDecision(promoteTo = 'issue:#1', text = '方針を A にする', extra: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text, promoteTo, ...extra }, memDeps());
  expect(outcome.status).toBe(201);
  const made = (outcome.body as MemWriteResponse).item;
  return { id: made.id, version: made.version };
}
async function preview(itemId: string, extra: Record<string, unknown> = {}): Promise<PromotePreviewView> {
  const outcome = await promotePreview(db, SCREEN, repoA, itemId, { worktreeId: WT, ...extra }, deps());
  expect(outcome.status).toBe(201);
  return (outcome.body as { preview: PromotePreviewView }).preview;
}
const approveBody = (p: PromotePreviewView) => ({
  previewId: p.id,
  itemVersion: p.itemVersion,
  baseFingerprint: p.baseFingerprint,
  bodySha256: p.bodySha256,
  acknowledgedOperationIds: p.acknowledgedOperationIds,
});
const approve = (p: PromotePreviewView, request = SCREEN) => promoteApprove(db, request, repoA, p.itemId, approveBody(p), deps());
const operationOf = (outcome: { body: unknown }) => (outcome.body as { operation: PromoteOperationView }).operation;
const codeOf = (outcome: { body: unknown }) => (outcome.body as { code?: string; reason?: string });

/** An operation left `unknown`: the POST timed out after GitHub took the comment. */
async function unknownComment(itemId: string): Promise<string> {
  gh.postAnswer = () => failed('', { code: null, timedOut: true });
  const outcome = await approve(await preview(itemId));
  gh.postAnswer = undefined;
  const operation = operationOf(outcome);
  expect(operation.state).toBe('unknown');
  return operation.id;
}

interface Entrance {
  /** Make the state the entrance acts on; returns what `call` needs. */
  setup: () => Promise<Record<string, string>>;
  call: (request: typeof SCREEN, made: Record<string, string>) => Promise<{ status: number; body: unknown }>;
}

/** Every entrance of the promote service that writes. */
const ENTRANCES: Record<string, Entrance> = {
  promotePreview: {
    setup: async () => ({ itemId: (await addDecision()).id }),
    call: (request, made) => promotePreview(db, request, repoA, made.itemId, { worktreeId: WT }, deps()),
  },
  promoteApprove: {
    setup: async () => {
      const p = await preview((await addDecision()).id);
      return { previewJson: JSON.stringify(p) };
    },
    call: (request, made) => {
      const p = JSON.parse(made.previewJson) as PromotePreviewView;
      return promoteApprove(db, request, repoA, p.itemId, approveBody(p), deps());
    },
  },
  promoteConfirmReflected: {
    setup: async () => {
      const made = await addDecision();
      await approve(await preview(made.id));
      return { itemId: made.id, version: String(item(made.id).version) };
    },
    call: (request, made) => promoteConfirmReflected(db, request, repoA, made.itemId, { worktreeId: WT, ifVersion: Number(made.version) }, deps()),
  },
  promoteReconcile: {
    setup: async () => ({ opId: await unknownComment((await addDecision()).id) }),
    call: (request, made) => promoteReconcile(db, request, repoA, made.opId, deps()),
  },
  promoteAbandon: {
    setup: async () => ({ opId: await unknownComment((await addDecision()).id) }),
    call: (request, made) => promoteAbandon(db, request, repoA, made.opId, { ifState: 'unknown' }, deps()),
  },
  promoteSettleTransition: {
    setup: async () => {
      const made = await addDecision();
      promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
      const outcome = await approve(await preview(made.id));
      promoteHooks = undefined;
      return { opId: operationOf(outcome).id, version: String(item(made.id).version) };
    },
    call: (request, made) => promoteSettleTransition(db, request, repoA, made.opId, { worktreeId: WT, ifVersion: Number(made.version) }, deps()),
  },
};

/** What an entrance may have changed: the records, the item states, the comments, the document. */
const snapshot = () => ({
  rows: db.prepare('SELECT * FROM mem_promote_operations ORDER BY id').all(),
  previews: db.prepare('SELECT id, used_at, invalidated_reason FROM mem_promote_previews ORDER BY id').all(),
  previewCount: count('SELECT COUNT(*) n FROM mem_promote_previews'),
  items: db.prepare('SELECT id, state, version FROM mem_items ORDER BY id').all(),
  posts: gh.posts().length,
  doc: existsSync(docPath()) ? readFileSync(docPath(), 'utf8') : null,
});

beforeEach(() => {
  dir = makeTempDir('promote-entrances-4225-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  gh = new FakeGh();
  head = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
  origin = 'git@github.com:o/r.git';
  clock = null;
  boot = 'boot-1';
  promoteHooks = undefined;
  hold = null;
  commonDirOf = () => '/common/.git';
  makeWorktree();
  setMode('on');
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('the table names every entrance that writes', () => {
  it('the entrances enumerated from the write side are the rows of the table (a new one fails here)', () => {
    expect(writeEntrancesOfPromote()).toEqual(Object.keys(ENTRANCES).sort());
  });
});

describe('(e) only the screen changes anything (T1)', () => {
  it.each(Object.keys(ENTRANCES))('%s without the screen mark → 403, nothing written, nothing sent', async (key) => {
    const entry = ENTRANCES[key];
    const made = await entry.setup();
    const before = snapshot();
    const outcome = await entry.call(NOT_SCREEN, made);
    expect(outcome.status).toBe(403);
    expect(codeOf(outcome).code).toBe('screen_only');
    expect(snapshot()).toEqual(before);
  });

  it.each(Object.keys(ENTRANCES))('%s (control) with the mark → not refused as screen_only', async (key) => {
    const entry = ENTRANCES[key];
    const outcome = await entry.call(SCREEN, await entry.setup());
    expect(codeOf(outcome).code).not.toBe('screen_only');
    expect(outcome.status).toBeLessThan(300);
  });
});

describe('(b) off / derived write nothing (T2・T17)', () => {
  it.each(['off', 'derived'] as const)('preview with the branch %s → disabled, no preview', async (mode) => {
    const made = await addDecision();
    setMode(mode);
    const outcome = await promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps());
    expect(codeOf(outcome).code).toBe('disabled');
    expect(promoteRows()).toBe(0);
  });

  it.each(['off', 'derived'] as const)('approve with the branch %s since the preview → back to approval, nothing sent', async (mode) => {
    const p = await preview((await addDecision()).id);
    setMode(mode);
    const outcome = await approve(p);
    expect(codeOf(outcome)).toMatchObject({ code: 'reapproval_required', reason: 'mode_not_on' });
    expect(gh.posts()).toHaveLength(0);
    expect(count('SELECT COUNT(*) n FROM mem_promote_operations')).toBe(0);
  });

  it.each(['off', 'derived'] as const)('confirm-reflected and settle-transition with the branch %s → refused, the item unchanged', async (mode) => {
    const confirm = await ENTRANCES.promoteConfirmReflected.setup();
    const settle = await ENTRANCES.promoteSettleTransition.setup();
    setMode(mode);
    const before = snapshot();
    expect(codeOf(await ENTRANCES.promoteConfirmReflected.call(SCREEN, confirm)).code).toBe('disabled');
    expect(codeOf(await ENTRANCES.promoteSettleTransition.call(SCREEN, settle)).code).toBe('disabled');
    expect(snapshot().items).toEqual(before.items);
  });

  it('T17 (E1): an unknown write reconciled while off → the outcome is kept, the item does not move', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    setMode('off');
    const outcome = await promoteReconcile(db, SCREEN, repoA, opId, deps());
    expect(outcome.status).toBe(200);
    expect(op(opId)).toMatchObject({ state: 'succeeded', transition_pending: 1, transition_reason: 'disabled' });
    expect(item(made.id).state).toBe('open');
    expect(gh.comments).toHaveLength(1);
  });

  it('(control) on: the comment is written once and the item is recorded', async () => {
    const made = await addDecision();
    const outcome = await approve(await preview(made.id));
    expect(operationOf(outcome)).toMatchObject({ state: 'succeeded', transitionPending: false });
    expect(gh.comments).toHaveLength(1);
    expect(item(made.id)).toEqual({ state: 'recorded', version: made.version + 1 });
  });
});

describe('(a) a request the worktree’s re-creation overtook (T4・T20)', () => {
  it('T20(a): re-created after the preview → the approval goes back, nothing sent', async () => {
    const p = await preview((await addDecision()).id);
    recreateWorktree();
    const outcome = await approve(p);
    expect(codeOf(outcome)).toMatchObject({ code: 'reapproval_required', reason: 'worktree_recreated' });
    expect(gh.posts()).toHaveLength(0);
  });

  it('re-created while the approval waits on git → refused, nothing sent', async () => {
    const p = await preview((await addDecision()).id);
    const release = arm();
    const pending = approve(p);
    await until(() => hold?.armed === false);
    recreateWorktree();
    release();
    expect(codeOf(await pending)).toMatchObject({ code: 'reapproval_required', reason: 'worktree_recreated' });
    expect(gh.posts()).toHaveLength(0);
  });

  it('re-created while the preview waits on git → refused, no preview', async () => {
    const made = await addDecision();
    const release = arm();
    const pending = promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps());
    await until(() => hold?.armed === false);
    recreateWorktree();
    release();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(count('SELECT COUNT(*) n FROM mem_promote_previews')).toBe(0);
  });

  it('T20(b): re-created while the POST is answered → the outcome is kept, the item stays open, transition pending', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    let release!: () => void;
    gh.hold = { match: (call) => call.args.includes('--method'), wait: new Promise<void>((resolve) => (release = resolve)) };
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    recreateWorktree();
    release();
    const operation = operationOf(await pending);
    expect(operation).toMatchObject({ state: 'succeeded', transitionPending: true, transitionReason: 'incarnation_changed' });
    expect(item(made.id).state).toBe('open');
    expect(gh.comments).toHaveLength(1);
  });

  it('T20(c): re-created while the reconcile asks GitHub → the outcome is kept, the item stays open', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    let release!: () => void;
    gh.hold = { match: (call) => call.args.includes('--paginate'), wait: new Promise<void>((resolve) => (release = resolve)) };
    const pending = promoteReconcile(db, SCREEN, repoA, opId, deps());
    await until(() => gh.calls.some((call) => call.args.includes('--paginate')));
    recreateWorktree();
    release();
    await pending;
    expect(op(opId)).toMatchObject({ state: 'succeeded', transition_pending: 1, transition_reason: 'incarnation_changed' });
    expect(item(made.id).state).toBe('open');
  });

  it('(control) the worktree left alone → the item moves (T20 negative)', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    await promoteReconcile(db, SCREEN, repoA, opId, deps());
    expect(op(opId)).toMatchObject({ state: 'succeeded', transition_pending: 0 });
    expect(item(made.id).state).toBe('recorded');
  });
});

describe('(c) what changed since the diff is not written: back to a new approval (T3・T5・T6・T14)', () => {
  it('T3: the item updated after the preview → item_changed, nothing sent', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    const updated = await memUpdateItem(db, WT, made.id, { instanceId: 'claude', ifVersion: made.version, text: '方針を B にする' }, memDeps());
    expect(updated.status).toBe(201);
    expect(codeOf(await approve(p))).toMatchObject({ code: 'reapproval_required', reason: 'item_changed' });
    expect(gh.posts()).toHaveLength(0);
  });

  it('T5: the document changed after the preview → base_changed, the other content kept as it is', async () => {
    writeFileSync(docPath(), '# 既存\n');
    const p = await preview((await addDecision('path:docs/d.md')).id);
    writeFileSync(docPath(), '# 他のセッションが変えた\n');
    expect(codeOf(await approve(p))).toMatchObject({ code: 'reapproval_required', reason: 'base_changed' });
    expect(readFileSync(docPath(), 'utf8')).toBe('# 他のセッションが変えた\n');
  });

  it('(control) the document unchanged → the block is appended, the old content first', async () => {
    writeFileSync(docPath(), '# 既存\n');
    const made = await addDecision('path:docs/d.md');
    const outcome = await approve(await preview(made.id));
    expect(operationOf(outcome)).toMatchObject({ state: 'succeeded', concurrentEdit: false });
    expect(readFileSync(docPath(), 'utf8').startsWith('# 既存\n<!-- commandmate-promote:begin')).toBe(true);
    expect(item(made.id).state).toBe('recorded');
  });

  it('T6: the worktree switched to another branch → branch_changed', async () => {
    const p = await preview((await addDecision('path:docs/d.md')).id);
    head = { ...head, branch: 'other' };
    expect(codeOf(await approve(p))).toMatchObject({ code: 'reapproval_required', reason: 'branch_changed' });
    expect(existsSync(docPath())).toBe(false);
  });

  it('the Issue changed (its body) → base_changed; the account switched since the preview → poster_changed', async () => {
    const p1 = await preview((await addDecision()).id);
    gh.issue = { ...gh.issue, body: 'edited' };
    expect(codeOf(await approve(p1))).toMatchObject({ reason: 'base_changed' });
    const p2 = await preview((await addDecision('issue:#1', 'other')).id);
    gh.active = 202;
    expect(codeOf(await approve(p2))).toMatchObject({ reason: 'poster_changed' });
    expect(gh.posts()).toHaveLength(0);
  });

  it('T14: an expired preview, a preview used once, and one whose shown body differs → not written', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    clock = Date.now() + 31 * 60 * 1000;
    expect(codeOf(await approve(p))).toMatchObject({ reason: 'expired' });
    clock = null;
    const p2 = await preview(made.id);
    expect(codeOf(await promoteApprove(db, SCREEN, repoA, made.id, { ...approveBody(p2), bodySha256: 'x' }, deps()))).toMatchObject({
      reason: 'preview_mismatch',
    });
    expect(gh.posts()).toHaveLength(0);
    expect(item(made.id).state).toBe('open');
    const p3 = await preview(made.id);
    expect((await approve(p3)).status).toBe(200);
    expect(codeOf(await approve(p3))).toMatchObject({ reason: 'preview_used' });
    expect(gh.posts()).toHaveLength(1);
  });

  it('T15: an item withheld by the current rules makes no preview', async () => {
    const made = await addDecision();
    db.prepare('UPDATE mem_items SET text = ?, checked_rules_version = 0 WHERE id = ?').run(`password: ${'x'.repeat(12)}`, made.id);
    const outcome = await promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps());
    expect(codeOf(outcome).code).toBe('withheld');
    expect(promoteRows()).toBe(0);
  });
});

describe('(d) an unknown outcome is not sent again, nothing is written twice (T7〜T11・T18・T19・T21)', () => {
  it('T8: GitHub took it and the answer was lost → unknown; the reconcile finds it; one comment', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    expect(gh.comments).toHaveLength(1);
    // A new approval does not send it again while it is unknown.
    const again = await approve(await preview(made.id));
    expect(again.status).toBe(409);
    expect(gh.posts()).toHaveLength(1);
    const reconciled = operationOf(await promoteReconcile(db, SCREEN, repoA, opId, deps()));
    expect(reconciled.state).toBe('succeeded');
    expect(gh.posts()).toHaveLength(1);
    expect(item(made.id).state).toBe('recorded');
  });

  it('(positive control) reading the unknown as a failure lets the next approval post a second comment', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    db.prepare("UPDATE mem_promote_operations SET state = 'failed' WHERE id = ?").run(opId);
    await approve(await preview(made.id));
    expect(gh.comments).toHaveLength(2);
  });

  it('(control) a definite 4xx → failed (not sent), and a new approval may write', async () => {
    const made = await addDecision();
    gh.override = (call) => (call.args.includes('--method') ? failed('HTTP 422: Validation Failed') : undefined);
    expect(operationOf(await approve(await preview(made.id))).state).toBe('failed');
    gh.override = undefined;
    expect(operationOf(await approve(await preview(made.id))).state).toBe('succeeded');
    expect(gh.comments).toHaveLength(1);
  });

  it('T9: written, then the database update failed → unknown, the reconcile settles it, one POST', async () => {
    const made = await addDecision();
    let thrown = false;
    promoteHooks = {
      afterPost: () => {
        if (!thrown) {
          thrown = true;
          throw new Error('SQLITE_BUSY');
        }
      },
    };
    const operation = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    expect(operation.state).toBe('unknown');
    expect(op(operation.id).unknown_reason).toBe('db_error');
    await promoteReconcile(db, SCREEN, repoA, operation.id, deps());
    expect(op(operation.id).state).toBe('succeeded');
    expect(gh.posts()).toHaveLength(1);
  });

  it('an attempt left in_flight by another boot reads as unknown and is reconciled, never resent', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    let release!: () => void;
    gh.hold = { match: (call) => call.args.includes('--method'), wait: new Promise<void>((resolve) => (release = resolve)) };
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    boot = 'boot-2'; // the server restarted while the POST was out
    const list = await promoteList(db, repoA, 'feature/x', { mem: memDeps(), bootId: () => boot });
    const listed = (list.body as { decisions: Array<{ operations: PromoteOperationView[] }> }).decisions[0].operations[0];
    expect(listed.state).toBe('unknown');
    release();
    await pending;
    expect(gh.posts()).toHaveLength(1);
  });

  it('T10: two reconciles and two approvals at once on an unknown write → no POST added, the item moves once', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    const [p1, p2] = [await preview(made.id), await preview(made.id)];
    const results = await Promise.all([
      promoteReconcile(db, SCREEN, repoA, opId, deps()),
      promoteReconcile(db, SCREEN, repoA, opId, deps()),
      approve(p1),
      approve(p2),
    ]);
    expect(gh.posts()).toHaveLength(1);
    expect(results[2].status).toBe(409);
    expect(results[3].status).toBe(409);
    expect(item(made.id)).toEqual({ state: 'recorded', version: made.version + 1 });
  });

  it('T7: two screens approve the same item at once → one write, the other 409', async () => {
    const made = await addDecision();
    const [p1, p2] = [await preview(made.id), await preview(made.id)];
    const [a, b] = await Promise.all([approve(p1), approve(p2)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(gh.comments).toHaveLength(1);
    expect(item(made.id).version).toBe(made.version + 1);
  });

  it('T11: the reconcile does not take a copy of the mark by someone else, nor a body that differs', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    const ours = gh.comments[0];
    gh.comments = [{ ...ours, id: 50, user: { id: 999 } }];
    await promoteReconcile(db, SCREEN, repoA, opId, deps());
    expect(op(opId)).toMatchObject({ state: 'unknown', unknown_reason: 'not_found_yet' });
    gh.comments = [{ ...ours, body: `${ours.body}\nedited` }];
    await promoteReconcile(db, SCREEN, repoA, opId, deps());
    expect(op(opId)).toMatchObject({ state: 'unknown', unknown_reason: 'body_differs' });
    // A person checked GitHub: it is not there.
    expect((await promoteAbandon(db, SCREEN, repoA, opId, { ifState: 'unknown' }, deps())).status).toBe(200);
    expect(op(opId).state).toBe('abandoned');
  });

  it('T11b: an Enterprise host is named in every gh call; a switch of account after the write still finds the comment', async () => {
    origin = 'git@ghe.example.com:o/r.git';
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    gh.active = 202;
    await promoteReconcile(db, SCREEN, repoA, opId, deps());
    expect(op(opId)).toMatchObject({ state: 'succeeded', poster_id: 101 });
    const apiCalls = gh.calls.filter((call) => call.args[0] === 'api' || call.args[0] === 'auth');
    expect(apiCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of apiCalls) expect(call.args.slice(call.args.indexOf('--hostname'), call.args.indexOf('--hostname') + 2)).toEqual(['--hostname', 'ghe.example.com']);
  });

  it.each(['github.com', 'acme.ghe.com', 'ghe.example.com'])(
    'T11c (%s): an account switch between the poster check and the POST does not change the poster; the token is stored nowhere',
    async (host) => {
      origin = `git@${host}:o/r.git`;
      const made = await addDecision();
      const p = await preview(made.id);
      let release!: () => void;
      gh.hold = { match: (call) => call.args.includes('--method'), wait: new Promise<void>((resolve) => (release = resolve)) };
      const pending = approve(p);
      await until(() => gh.posts().length === 1);
      gh.active = 202;
      release();
      const operation = operationOf(await pending);
      expect(operation.state).toBe('succeeded');
      expect(gh.comments[0].user.id).toBe(101);
      const dump = JSON.stringify(
        ['mem_promote_previews', 'mem_promote_operations', 'mem_promote_attempts'].map((table) => db.prepare(`SELECT * FROM ${table}`).all())
      );
      expect(dump).not.toContain('tok-alice');
      expect(JSON.stringify(operation)).not.toContain('tok-alice');
    }
  );

  it('(control T11c) gh auth token fails → no POST, no operation', async () => {
    const p = await preview((await addDecision()).id);
    gh.override = (call) => (call.args[0] === 'auth' ? failed('not logged in') : undefined);
    const outcome = await approve(p);
    expect(codeOf(outcome).code).toBe('gh_failed');
    expect(gh.posts()).toHaveLength(0);
    expect(count('SELECT COUNT(*) n FROM mem_promote_operations')).toBe(0);
  });

  it('T18: written outside but the item did not move → an earlier preview of another screen cannot write again', async () => {
    const made = await addDecision();
    const other = await preview(made.id);
    promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
    const first = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    expect(first).toMatchObject({ state: 'succeeded', transitionPending: true, transitionReason: 'version_conflict' });
    expect((await approve(other)).status).toBe(409);
    expect(gh.posts()).toHaveLength(1);
    // "記録済みとして扱う" moves it without writing outside.
    const settled = await promoteSettleTransition(db, SCREEN, repoA, first.id, { worktreeId: WT, ifVersion: made.version }, deps());
    expect(settled.status).toBe(200);
    expect(item(made.id)).toEqual({ state: 'recorded', version: made.version + 1 });
    expect(gh.posts()).toHaveLength(1);
  });

  it('T18: while the transition is pending, even a new preview that lists the record cannot write (the pending one is in progress)', async () => {
    const made = await addDecision();
    promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
    const first = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    const listing = await preview(made.id);
    expect(listing.acknowledgedOperationIds).toEqual([first.id]);
    expect(codeOf(await approve(listing)).code).toBe('operation_in_progress');
    expect(gh.posts()).toHaveLength(1);
  });

  it('T18 (U7): the item changed since it was written → the diff must be acknowledged first', async () => {
    const made = await addDecision();
    promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
    const first = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    db.prepare("UPDATE mem_items SET text = 'changed after the write' WHERE id = ?").run(made.id);
    const refused = await promoteSettleTransition(db, SCREEN, repoA, first.id, { worktreeId: WT, ifVersion: made.version }, deps());
    expect(codeOf(refused).code).toBe('diff_not_acknowledged');
    const settled = await promoteSettleTransition(db, SCREEN, repoA, first.id, { worktreeId: WT, ifVersion: made.version, acknowledgeDiff: true }, deps());
    expect(settled.status).toBe(200);
  });

  it('T19: a preview made before another record was written goes back (prior_record_exists); one that lists it may write', async () => {
    const made = await addDecision();
    const stale = await preview(made.id);
    const first = operationOf(await approve(await preview(made.id)));
    // The record outside exists while the item is still open (its transition settled elsewhere as nothing).
    db.prepare("UPDATE mem_items SET state = 'open', version = ? WHERE id = ?").run(made.version, made.id);
    expect(codeOf(await approve(stale))).toMatchObject({ reason: 'prior_record_exists' });
    const listing = await preview(made.id);
    expect(listing.acknowledgedOperationIds).toEqual([first.id]);
    expect(operationOf(await approve(listing)).state).toBe('succeeded');
    expect(gh.posts()).toHaveLength(2);
  });

  it('T21・T5e: a new document, an ending after the link, another append, the reconcile, then a second item to the same document', async () => {
    const first = await addDecision('path:docs/new.md');
    promoteHooks = {
      doc: {
        afterLink: () => {
          throw new Error('the process ended here');
        },
      },
    };
    const crashed = operationOf(await approve(await preview(first.id)));
    promoteHooks = undefined;
    expect(crashed.state).toBe('unknown');
    expect(readdirSync(path.join(wtPath(), 'docs'))).toContain(tempNameOf(crashed.id));
    appendFileSync(docPath('docs/new.md'), 'appended by another session\n');
    await promoteReconcile(db, SCREEN, repoA, crashed.id, deps());
    expect(op(crashed.id).state).toBe('succeeded');
    expect(readdirSync(path.join(wtPath(), 'docs'))).toEqual(['new.md']);
    expect(item(first.id).state).toBe('recorded');
    const second = await addDecision('path:docs/new.md', '二つ目の決定');
    expect(operationOf(await approve(await preview(second.id))).state).toBe('succeeded');
    const content = readFileSync(docPath('docs/new.md'), 'utf8');
    expect(content).toContain('appended by another session\n');
    expect(content.match(/commandmate-promote:begin/g)).toHaveLength(2);
  });

  it('T21: a block edited or removed after the write stays unknown and is never written again by itself', async () => {
    writeFileSync(docPath(), '# 既存\n');
    const made = await addDecision('path:docs/d.md');
    promoteHooks = {
      doc: {
        beforeAppend: () => {
          throw new Error('stopped');
        },
      },
    };
    const stopped = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    expect(stopped.state).toBe('unknown');
    await promoteReconcile(db, SCREEN, repoA, stopped.id, deps());
    expect(op(stopped.id)).toMatchObject({ state: 'unknown', unknown_reason: 'block_missing' });
    expect((await approve(await preview(made.id))).status).toBe(409);
    expect(readFileSync(docPath(), 'utf8')).toBe('# 既存\n');
  });
});

describe('recorded is not reflected (T13)', () => {
  it('spec → recorded with the warning; confirmed → promoted. record_only → promoted at once', async () => {
    const spec = await addDecision();
    await approve(await preview(spec.id));
    const list = await promoteList(db, repoA, 'feature/x', { mem: memDeps() });
    const entry = (list.body as { decisions: Array<{ item: { id: string }; unreflected: boolean }> }).decisions.find((d) => d.item.id === spec.id)!;
    expect(entry.unreflected).toBe(true);
    const confirmed = await promoteConfirmReflected(db, SCREEN, repoA, spec.id, { worktreeId: WT, ifVersion: item(spec.id).version }, deps());
    expect(confirmed.status).toBeLessThan(300);
    expect(item(spec.id).state).toBe('promoted');
    const recordOnly = await addDecision('issue:#1', '記録だけの決定');
    await approve(await preview(recordOnly.id, { effect: 'record_only' }));
    expect(item(recordOnly.id).state).toBe('promoted');
  });

  it('the quote keeps its origin: the agent’s by default, the person’s once confirmed on the screen', async () => {
    const made = await addDecision('issue:#1', 'with a quote', { quote: '原文の一節', quoteAt: '2026-11-08T10:00:00+09:00' });
    expect((await preview(made.id)).body).toContain('Agent が記録した引用');
    const confirmed = await preview(made.id, { quoteConfirmed: true });
    expect(confirmed.quoteOrigin).toBe('human');
    expect(confirmed.body).toContain('人が画面で確かめた引用');
  });
});

describe('(f) nothing commits or pushes (T16)', () => {
  it('after a document is written, git shows a change of the worktree only and no new commit', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: wtPath(), encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q', '-b', 'feature/x');
    writeFileSync(docPath(), '# 既存\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    const made = await addDecision('path:docs/d.md');
    expect(operationOf(await approve(await preview(made.id))).state).toBe('succeeded');
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git('status', '--porcelain').trim()).toBe('M docs/d.md');
  });
});

// ---------------------------------------------------------------------------
// 5-2b (2026-11-09): P1 1・P2 3
// ---------------------------------------------------------------------------

/** A second root of the same Git (`resolveCommonDir` answers one dir for every path). */
function addRootB(rules: Array<{ match: 'glob'; pattern: string; mode: 'off' | 'derived' | 'on' }>): string {
  const rootB = path.join(dir, 'root-b');
  mkdirSync(rootB, { recursive: true });
  const repoB = createRepository(db, { name: 'repo-b', path: rootB, cloneSource: 'local' }).id;
  const current = getMemSettings(db, repoB);
  saveMemSettings(db, repoB, { version: current.version, features: current.features, rules });
  return repoB;
}
/** Root B: the worktree's current branch `main` on, the item's branch `feature/x` off. */
const SPLIT = [
  { match: 'glob' as const, pattern: 'main', mode: 'on' as const },
  { match: 'glob' as const, pattern: '**', mode: 'off' as const },
];
const BOTH_ON = [{ match: 'glob' as const, pattern: '**', mode: 'on' as const }];
const rename = (from: string, to: string) => db.transaction(() => renameWorktreeIdPreservingChildren(db, from, to))();

describe('5-2b P1: the mode of the item’s branch at every root', () => {
  it('preview: the current branch on at both roots, the item’s branch on at one and off at the other → disabled, no preview', async () => {
    const made = await addDecision();
    addRootB(SPLIT);
    head = { ...head, branch: 'main' };
    const outcome = await promotePreview(db, SCREEN, repoA, made.id, { worktreeId: WT }, deps());
    expect(codeOf(outcome)).toMatchObject({ code: 'disabled', reason: 'ambiguous' });
    expect(promoteRows()).toBe(0);
  });

  it('approve: root B turned the item’s branch off since the preview → back to approval, nothing sent', async () => {
    const made = await addDecision();
    const repoB = addRootB(BOTH_ON);
    head = { ...head, branch: 'main' };
    const p = await preview(made.id);
    const current = getMemSettings(db, repoB);
    saveMemSettings(db, repoB, { version: current.version, features: current.features, rules: SPLIT });
    const outcome = await approve(p);
    expect(codeOf(outcome)).toMatchObject({ code: 'reapproval_required', reason: 'mode_not_on' });
    expect(gh.posts()).toHaveLength(0);
    expect(count('SELECT COUNT(*) n FROM mem_promote_operations')).toBe(0);
    expect(item(made.id).state).toBe('open');
  });

  it('A’s entrance (confirm-reflected): the item’s branch off at root B → disabled, the item stays recorded', async () => {
    const made = await addDecision();
    await approve(await preview(made.id));
    expect(item(made.id).state).toBe('recorded');
    addRootB(SPLIT);
    head = { ...head, branch: 'main' };
    const before = item(made.id);
    const outcome = await promoteConfirmReflected(db, SCREEN, repoA, made.id, { worktreeId: WT, ifVersion: before.version }, deps());
    expect(codeOf(outcome).code).toBe('disabled');
    expect(item(made.id)).toEqual(before);
  });

  it('(control) a single root on, the worktree on another branch → written and recorded as before', async () => {
    const made = await addDecision();
    head = { ...head, branch: 'main' };
    const operation = operationOf(await approve(await preview(made.id)));
    expect(operation.state).toBe('succeeded');
    expect(item(made.id).state).toBe('recorded');
    const confirmed = await promoteConfirmReflected(db, SCREEN, repoA, made.id, { worktreeId: WT, ifVersion: item(made.id).version }, deps());
    expect(confirmed.status).toBeLessThan(300);
    expect(item(made.id).state).toBe('promoted');
  });

  it('(control) two roots both on for the item’s branch → written', async () => {
    const made = await addDecision();
    addRootB(BOTH_ON);
    head = { ...head, branch: 'main' };
    expect(operationOf(await approve(await preview(made.id))).state).toBe('succeeded');
    expect(gh.comments).toHaveLength(1);
  });
});

describe('5-2b P2-1: a rename keeps the worktree an operation named', () => {
  const crashOnLink = () => {
    promoteHooks = {
      doc: {
        afterLink: () => {
          throw new Error('the process ended here');
        },
      },
    };
  };

  it('an unknown document write reconciled after the worktree’s rename → found, the temporary name taken back, the item recorded', async () => {
    const made = await addDecision('path:docs/new.md');
    crashOnLink();
    const crashed = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    expect(crashed.state).toBe('unknown');
    rename(WT, 'wt-renamed');
    await promoteReconcile(db, SCREEN, repoA, crashed.id, deps());
    expect(op(crashed.id)).toMatchObject({ state: 'succeeded', transition_pending: 0 });
    expect(readdirSync(path.join(wtPath(), 'docs'))).toEqual(['new.md']);
    expect(item(made.id).state).toBe('recorded');
  });

  it('a new approval after the rename takes back the temporary name the earlier operation left', async () => {
    const first = await addDecision('path:docs/new.md');
    const second = await addDecision('path:docs/new.md', '二つ目の決定');
    crashOnLink();
    const crashed = operationOf(await approve(await preview(first.id)));
    promoteHooks = undefined;
    expect(readdirSync(path.join(wtPath(), 'docs'))).toContain(tempNameOf(crashed.id));
    rename(WT, 'wt-renamed');
    const p = await preview(second.id, { worktreeId: 'wt-renamed' });
    expect(operationOf(await approve(p)).state).toBe('succeeded');
    expect(readdirSync(path.join(wtPath(), 'docs'))).toEqual(['new.md']);
  });

  it('an approval whose preview was made before the rename → written under the new id, the item recorded', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    rename(WT, 'wt-renamed');
    expect(operationOf(await approve(p))).toMatchObject({ state: 'succeeded', transitionPending: false });
    expect(item(made.id).state).toBe('recorded');
  });

  it('(control) deleted and made again under the same id (a new lifetime) → the reconcile does not read it', async () => {
    const made = await addDecision('path:docs/new.md');
    crashOnLink();
    const crashed = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    recreateWorktree();
    await promoteReconcile(db, SCREEN, repoA, crashed.id, deps());
    expect(op(crashed.id)).toMatchObject({ state: 'unknown', unknown_reason: 'unreadable' });
  });
});

describe('5-2b P2-2: an unsettled operation stays on the list after its item was closed or purged', () => {
  type Listed = {
    decisions: Array<{ item: { id: string } }>;
    unresolved: Array<{ operation: PromoteOperationView; item: { id: string; state: string } | null; itemVersion: number | null }>;
  };
  const listed = async () => (await promoteList(db, repoA, 'feature/x', { mem: memDeps(), bootId: () => boot })).body as Listed;
  const holdPost = () => {
    let release!: () => void;
    gh.hold = { match: (call) => call.args.includes('--method'), wait: new Promise<void>((resolve) => (release = resolve)) };
    return () => release();
  };

  it('closed while the POST waits → written, the transition pending, and the operation still listed with the closed item', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    const release = holdPost();
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    const closed = await memCloseItem(db, WT, made.id, { instanceId: 'claude' }, memDeps());
    expect(closed.status).toBeLessThan(300);
    release();
    const operation = operationOf(await pending);
    expect(operation).toMatchObject({ state: 'succeeded', transitionPending: true });
    const list = await listed();
    expect(list.decisions.map((entry) => entry.item.id)).not.toContain(made.id);
    expect(list.unresolved).toHaveLength(1);
    expect(list.unresolved[0]).toMatchObject({ operation: { id: operation.id, transitionPending: true }, item: { id: made.id, state: 'closed' } });
  });

  it('purged while the POST times out → unknown, still listed without its item, and the reconcile reaches it', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    const release = holdPost();
    gh.postAnswer = () => failed('', { code: null, timedOut: true });
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    const purged = await memPurge(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { confirm: true, includeDecisions: true }, memDeps());
    expect(purged.status).toBe(200);
    release();
    const operation = operationOf(await pending);
    gh.postAnswer = undefined;
    expect(operation.state).toBe('unknown');
    expect(db.prepare('SELECT COUNT(*) n FROM mem_items WHERE id = ?').get(made.id)).toEqual({ n: 0 });
    const list = await listed();
    expect(list.unresolved).toEqual([expect.objectContaining({ operation: expect.objectContaining({ id: operation.id, state: 'unknown' }), item: null, itemVersion: null })]);
    await promoteReconcile(db, SCREEN, repoA, operation.id, deps());
    expect(op(operation.id).state).toBe('succeeded');
    expect((await listed()).unresolved).toHaveLength(1);
    expect((await listed()).unresolved[0].operation.transitionPending).toBe(true);
  });

  it('(control) an open item’s operation is listed under its item only; a settled operation is not listed as unresolved', async () => {
    const open = await addDecision();
    const unknownId = await unknownComment(open.id);
    const done = await addDecision('issue:#1', '書けて閉じた決定');
    await approve(await preview(done.id, { effect: 'record_only' }));
    expect(item(done.id).state).toBe('promoted');
    const list = await listed();
    expect(list.unresolved).toEqual([]);
    const entry = (list.decisions as Array<{ item: { id: string }; operations?: PromoteOperationView[] }>).find((d) => d.item.id === open.id)!;
    expect(entry.operations?.map((o) => o.id)).toEqual([unknownId]);
  });
});

/**
 * The screen's calls as the Panel makes them (`promoteApi` of screen-client.ts), answered by
 * the service as the routes do: the button's request reaches the real entrance (5-2c).
 */
function routeScreenCalls(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const match = url.pathname.match(/^\/api\/repositories\/([^/]+)\/mem\/decisions(?:\/operations\/([^/]+)\/(reconcile|abandon|settle-transition))?$/);
      if (!match) throw new Error(`unexpected call ${url.pathname}`);
      const headers = new Headers(init?.headers);
      headers.set('origin', 'http://localhost:3000');
      headers.set('host', 'localhost:3000');
      const request = { headers, url: url.toString() };
      const repositoryId = decodeURIComponent(match[1]);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const opId = match[2] ? decodeURIComponent(match[2]) : '';
      const outcome =
        match[3] === undefined
          ? await promoteList(db, repositoryId, url.searchParams.get('branch') ?? '', { mem: memDeps(), bootId: () => boot })
          : match[3] === 'reconcile'
            ? await promoteReconcile(db, request, repositoryId, opId, deps())
            : match[3] === 'abandon'
              ? await promoteAbandon(db, request, repositoryId, opId, body, deps())
              : await promoteSettleTransition(db, request, repositoryId, opId, body, deps());
      return { ok: outcome.status < 300, status: outcome.status, json: async () => outcome.body } as Response;
    })
  );
}

type ScreenList = {
  mode: string;
  ambiguous?: { reason: string | null; roots: Array<{ repositoryId: string }> };
  decisions: Array<{ item: { id: string }; operations: PromoteOperationView[] }>;
  unresolved: Array<{ operation: PromoteOperationView; item: { id: string; state: string } | null; itemVersion: number | null }>;
};
async function screenList(repositoryId: string): Promise<ScreenList> {
  const result = await promoteApi.list(repositoryId, 'feature/x');
  expect(result.ok).toBe(true);
  return (result as { ok: true; body: unknown }).body as ScreenList;
}
const holdThePost = () => {
  let release!: () => void;
  gh.hold = { match: (call) => call.args.includes('--method'), wait: new Promise<void>((resolve) => (release = resolve)) };
  return () => release();
};
const setRules = (repositoryId: string, rules: Array<{ match: 'glob'; pattern: string; mode: 'off' | 'derived' | 'on' }>) => {
  const current = getMemSettings(db, repositoryId);
  saveMemSettings(db, repositoryId, { version: current.version, features: current.features, rules });
};

describe('5-2c: what the screen shows of an unsettled operation, its buttons reach', () => {
  beforeEach(() => routeScreenCalls());
  afterEach(() => vi.unstubAllGlobals());

  it('P2-1: root B turned the item’s branch off while the POST waited → the list answers ambiguous with the pending write', async () => {
    const made = await addDecision();
    const repoB = addRootB(BOTH_ON);
    const p = await preview(made.id);
    const release = holdThePost();
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    setRules(repoB, SPLIT);
    release();
    const operation = operationOf(await pending);
    expect(operation).toMatchObject({ state: 'succeeded', transitionPending: true, transitionReason: 'disabled' });
    const list = await screenList(repoA);
    expect(list.mode).toBe('ambiguous');
    expect(list.ambiguous?.roots.map((root) => root.repositoryId).sort()).toEqual([repoA, repoB].sort());
    expect(list.decisions).toEqual([]);
    expect(list.unresolved).toEqual([
      expect.objectContaining({ operation: expect.objectContaining({ id: operation.id, transitionPending: true }), item: expect.objectContaining({ id: made.id, state: 'open' }) }),
    ]);
  });

  it('P2-1: the POST timed out while root B turned the branch off → listed, and the reconcile reached from the list keeps the outcome', async () => {
    const made = await addDecision();
    const repoB = addRootB(BOTH_ON);
    const p = await preview(made.id);
    const release = holdThePost();
    gh.postAnswer = () => failed('', { code: null, timedOut: true });
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    setRules(repoB, SPLIT);
    release();
    const operation = operationOf(await pending);
    gh.postAnswer = undefined;
    expect(operation.state).toBe('unknown');
    const listed = (await screenList(repoA)).unresolved.map((entry) => entry.operation.id);
    expect(listed).toEqual([operation.id]);
    const reconciled = await promoteApi.reconcile(repoA, listed[0]);
    expect(reconciled.ok).toBe(true);
    expect(op(operation.id)).toMatchObject({ state: 'succeeded', transition_pending: 1, transition_reason: 'disabled' });
    expect(item(made.id).state).toBe('open');
    expect(gh.comments).toHaveLength(1);
    expect((await screenList(repoA)).unresolved.map((entry) => entry.operation.id)).toEqual([operation.id]);
  });

  it('P2-1 (control): the roots agree → the list is the usual one, no ambiguous field', async () => {
    const made = await addDecision();
    addRootB(BOTH_ON);
    const list = await screenList(repoA);
    expect(list.mode).toBe('on');
    expect(list.ambiguous).toBeUndefined();
    expect(list.decisions.map((entry) => entry.item.id)).toEqual([made.id]);
  });

  it('P2-2: root A’s operations shown on root B’s screen → the reconcile, the abandon and the settle sent with root B’s id reach them', async () => {
    const first = await addDecision();
    const second = await addDecision('issue:#1', '二つ目の決定');
    const third = await addDecision('issue:#1', '三つ目の決定');
    const repoB = addRootB(BOTH_ON);
    const reconciled = await unknownComment(first.id);
    const abandoned = await unknownComment(second.id);
    promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
    const settled = operationOf(await approve(await preview(third.id)));
    promoteHooks = undefined;
    expect(db.prepare('SELECT DISTINCT repository_id r FROM mem_promote_operations').all()).toEqual([{ r: repoA }]);

    const shown = (await screenList(repoB)).decisions.flatMap((entry) => entry.operations.map((operation) => operation.id));
    expect(shown.sort()).toEqual([reconciled, abandoned, settled.id].sort());

    expect((await promoteApi.reconcile(repoB, reconciled)).ok).toBe(true);
    expect(op(reconciled).state).toBe('succeeded');
    expect((await promoteApi.abandon(repoB, abandoned)).ok).toBe(true);
    expect(op(abandoned).state).toBe('abandoned');
    expect((await promoteApi.settleTransition(repoB, settled.id, WT, item(third.id).version, false)).ok).toBe(true);
    expect(op(settled.id).transition_pending).toBe(0);
    expect(item(third.id).state).toBe('recorded');
  });

  it('P2-2 (control): a root of another git does not reach the operation (not found, nothing changed)', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    const rootC = path.join(dir, 'root-c');
    mkdirSync(rootC, { recursive: true });
    const repoC = createRepository(db, { name: 'repo-c', path: rootC, cloneSource: 'local' }).id;
    commonDirOf = (rootPath) => (rootPath === rootC ? '/other/.git' : '/common/.git');
    const before = snapshot();
    for (const result of [
      await promoteApi.reconcile(repoC, opId),
      await promoteApi.abandon(repoC, opId),
      await promoteApi.settleTransition(repoC, opId, WT, item(made.id).version, false),
    ]) {
      expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    }
    expect(snapshot()).toEqual(before);
  });

  it('P2-3: closed while the POST waited → "treat as recorded" of a closed item ends the pending without moving it', async () => {
    const made = await addDecision();
    const p = await preview(made.id);
    const release = holdThePost();
    const pending = approve(p);
    await until(() => gh.posts().length === 1);
    expect((await memCloseItem(db, WT, made.id, { instanceId: 'claude' }, memDeps())).status).toBeLessThan(300);
    release();
    const operation = operationOf(await pending);
    const [entry] = (await screenList(repoA)).unresolved;
    expect(entry).toMatchObject({ operation: { id: operation.id, transitionPending: true }, item: { state: 'closed' } });
    const closedBefore = item(made.id);

    // What the screen no longer offers for a closed item is refused before A's entrance.
    const moved = await promoteApi.settleTransition(repoA, operation.id, WT, entry.itemVersion!, true);
    expect(moved).toMatchObject({ ok: false, status: 409, code: 'state_forbids', reason: 'item_closed' });
    expect(op(operation.id).transition_pending).toBe(1);

    const acknowledged = await promoteApi.acknowledgeItemClosed(repoA, operation.id);
    expect(acknowledged.ok).toBe(true);
    expect(op(operation.id)).toMatchObject({ state: 'succeeded', transition_pending: 0 });
    expect(item(made.id)).toEqual(closedBefore);
    expect((await screenList(repoA)).unresolved).toEqual([]);
    expect(gh.comments).toHaveLength(1);
  });

  it('P2-3: purged, reconciled → the closed-item acknowledgement ends the pending of an item that is gone', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    const purged = await memPurge(db, { via: 'repository', repositoryId: repoA, branch: 'feature/x' }, { confirm: true, includeDecisions: true }, memDeps());
    expect(purged.status).toBe(200);
    expect((await promoteApi.reconcile(repoA, opId)).ok).toBe(true);
    expect(op(opId)).toMatchObject({ state: 'succeeded', transition_pending: 1 });
    expect((await promoteApi.acknowledgeItemClosed(repoA, opId)).ok).toBe(true);
    expect(op(opId).transition_pending).toBe(0);
    expect((await screenList(repoA)).unresolved).toEqual([]);
  });

  it('the window between a reconcile’s settle and A’s answer: an approval whose preview listed the write is refused, no second POST', async () => {
    const made = await addDecision();
    const opId = await unknownComment(made.id);
    const p = await preview(made.id);
    expect(p.acknowledgedOperationIds).toEqual([opId]);
    const release = arm();
    const reconciling = promoteApi.reconcile(repoA, opId);
    await until(() => op(opId).state === 'succeeded');
    const second = await approve(p);
    expect(codeOf(second).code).toBe('operation_in_progress');
    release();
    expect((await reconciling).ok).toBe(true);
    expect(gh.posts()).toHaveLength(1);
    expect(op(opId).transition_pending).toBe(0);
    expect(item(made.id).state).toBe('recorded');
  });

  it('P2-3 (control): an open item’s pending write is not ended by the closed-item acknowledgement; it still moves through A', async () => {
    const made = await addDecision();
    promoteHooks = { transition: () => ({ status: 409, body: { code: 'version_conflict' } }) };
    const operation = operationOf(await approve(await preview(made.id)));
    promoteHooks = undefined;
    const refused = await promoteApi.acknowledgeItemClosed(repoA, operation.id);
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'state_forbids', reason: 'item_open' });
    expect(op(operation.id).transition_pending).toBe(1);
    expect((await promoteApi.settleTransition(repoA, operation.id, WT, item(made.id).version, false)).ok).toBe(true);
    expect(item(made.id).state).toBe('recorded');
  });
});
