/**
 * Issue #4354 PR1a, the store side (design `docs/design/mem-approval-4354.md` §3.2・§3.3・§3.4・§4.1・§5):
 *
 * - a `promoted` decision is out of the open count (the warning and the limit), other kinds as before;
 * - `presentMemItem` marks a decision whose `at` has passed `expired: true` (time only, nothing
 *   written), and the brief carries `expired=true` without changing the rank;
 * - a purge keeps every decision closed within the last 24 hours (N4), whatever its filter, and
 *   leaves them out of the dry run; the counts of what ended are the same after it.
 *
 * A file DB under `os.tmpdir()` (`mkdtemp`), removed after each test; the clock is fixed.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
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
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { countOpenItems, getMemRecord, getMemSettings, listMem, MEM_PURGE_RECENT_DECISION_MS, saveMemSettings, type MemScope } from '@/lib/db/mem-db';
import { memAddItem, memList, memPurge, type MemServiceDeps } from '@/lib/mem/service';
import { presentMemItem } from '@/lib/mem/present';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { readMemSource, type BriefSourceContext } from '@/lib/brief/sources';
import { decisionCountsOf } from '@/lib/promote/decision-counts';
import type { MemTargetResolved } from '@/lib/mem/target';
import type { MemListResponse, MemPurgeResponse, MemWriteResponse } from '@/types/mem';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-1';
const BRANCH = 'feature/x';
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
let head: WorktreeHeadObservation;
let clock: number;

const deps = (): MemServiceDeps => ({
  resolveCommonDir: async () => '/common/.git',
  pathExists: () => true,
  observe: async () => ({ ...head }),
  git: { originUrl: async () => 'git@github.com:o/r.git', refTip: async () => SHA },
  now: () => clock,
});
const scope = (): MemScope => ({ storageRepositoryId: repoA, readRepositoryIds: [repoA], branch: BRANCH, worktreeId: null });
const REPO = () => ({ via: 'repository' as const, repositoryId: repoA, branch: BRANCH });

async function add(kind: string, extra: Record<string, unknown> = {}): Promise<string> {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind, text: `${kind} の本文`, ...extra }, deps());
  expect(outcome.status).toBe(201);
  return (outcome.body as MemWriteResponse).item.id;
}
const setState = (id: string, state: string) => db.prepare('UPDATE mem_items SET state = ? WHERE id = ?').run(state, id);
/** Closed `agoMs` before the clock, as a server closed it. */
const closeAt = (id: string, agoMs: number, reason = 'withdrawn') =>
  db.prepare("UPDATE mem_items SET state = 'closed', closed_at = ?, close_reason = ? WHERE id = ?").run(clock - agoMs, reason, id);
/** A grant as PR1c will store it: no destination, an `at` marked as an expiry. */
const markGrant = (id: string, epochMs: number) =>
  db.prepare('UPDATE mem_items SET close_when = ? WHERE id = ?').run(JSON.stringify({ schema: 1, type: 'at', epochMs, offset: 'Z', expires: true }), id);
const rows = () => (db.prepare('SELECT COUNT(*) n FROM mem_items').get() as { n: number }).n;

beforeEach(() => {
  dir = makeTempDir('mem-counts-expired-purge-4354-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  mkdirSync(path.join(dir, WT, 'docs'), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(WT, WT, path.join(dir, WT), rootA);
  setAgentInstances(db, WT, [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
  head = { branch: BRANCH, detached: false, head: SHA, commonDir: '/common/.git', known: true };
  clock = NOW;
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode: 'on' }] });
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('§3.3・§3.4: promoted is out of the open count', () => {
  it('a decision counts while open or recorded, not once promoted or closed', async () => {
    const ids = [await add('decision'), await add('decision'), await add('decision'), await add('decision')];
    setState(ids[1], 'recorded');
    setState(ids[2], 'promoted');
    closeAt(ids[3], HOUR);
    expect(countOpenItems(db, scope(), 'decision')).toBe(2);
  });

  it('(control) other kinds count every state but closed, as before', async () => {
    const notes = [await add('note'), await add('note')];
    closeAt(notes[1], HOUR, 'manual');
    expect(countOpenItems(db, scope(), 'note')).toBe(1);
  });

  it('the warning of mem list follows the same count (20 decisions, one promoted → no warning)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) ids.push(await add('decision', { promoteTo: 'issue:#1' }));
    const warned = (await memList(db, { via: 'worktree', worktreeId: WT }, {}, deps())).body as MemListResponse;
    expect(warned.warnings).toEqual([expect.objectContaining({ code: 'open_count', kind: 'decision', count: 20 })]);
    setState(ids[0], 'promoted');
    const after = (await memList(db, { via: 'worktree', worktreeId: WT }, {}, deps())).body as MemListResponse;
    expect(after.warnings.filter((warning) => warning.code === 'open_count')).toEqual([]);
  });
});

describe('§3.2: expired, read by the clock only', () => {
  it.each([
    ['an at an hour ago', 'at:2026-11-22T11:00:00+00:00', 'open', true],
    ['an at exactly now', 'at:2026-11-22T12:00:00+00:00', 'open', true],
    ['an at an hour ahead', 'at:2026-11-22T13:00:00+00:00', 'open', false],
    ['an at passed, recorded', 'at:2026-11-22T11:00:00+00:00', 'recorded', true],
    ['an at passed, closed', 'at:2026-11-22T11:00:00+00:00', 'closed', false],
    ['an issue condition', 'issue:#1', 'open', false],
    ['no condition', null, 'open', false],
  ] as const)('a decision with %s (close_when %s, %s) → expired=%s; nothing is written', async (_name, closeWhen, state, expired) => {
    const id = await add('decision', { promoteTo: 'issue:#1', ...(closeWhen ? { closeWhen } : {}) });
    if (state === 'closed') closeAt(id, HOUR, 'manual');
    else setState(id, state);
    const before = getMemRecord(db, id)!;
    const view = presentMemItem(before, { now: NOW });
    expect(view.expired === true).toBe(expired);
    if (!expired) expect('expired' in view).toBe(false);
    expect(getMemRecord(db, id)).toEqual(before);
  });

  it('the same decision is not expired an hour earlier (the clock decides)', async () => {
    const id = await add('decision', { promoteTo: 'issue:#1', closeWhen: 'at:2026-11-22T11:30:00+00:00' });
    expect(presentMemItem(getMemRecord(db, id)!, { now: NOW - HOUR }).expired).toBeUndefined();
    expect(presentMemItem(getMemRecord(db, id)!, { now: NOW }).expired).toBe(true);
  });

  it('(control) a next whose at has passed is not marked: only a decision is', async () => {
    const id = await add('next', { closeWhen: 'at:2026-11-22T11:00:00+00:00' });
    expect('expired' in presentMemItem(getMemRecord(db, id)!, { now: NOW })).toBe(false);
  });

  it('the brief carries expired=true on the decision, its rank unchanged', async () => {
    const expiredId = await add('decision', { promoteTo: 'issue:#1', closeWhen: 'at:2026-11-22T11:00:00+00:00' });
    const freshId = await add('decision', { promoteTo: 'issue:#1', closeWhen: 'at:2026-11-22T13:00:00+00:00' });
    const target = { storageRepositoryId: repoA, readRepositoryIds: [repoA], branch: BRANCH, detached: false, worktree: { id: WT } } as unknown as MemTargetResolved;
    const ctx = { db, worktreeId: WT, instanceId: 'claude', cliToolId: 'claude', roster: [], target, now: NOW, readAll: 'x', conditions: new Map(), recipient: null } as BriefSourceContext;
    const answer = await readMemSource(ctx);
    const entry = (id: string) => answer.items.find((item) => item.entry.id === id)!.entry;
    expect(entry(expiredId).fields).toMatchObject({ kind: 'decision', state: 'open', expired: true });
    expect(entry(expiredId).rank).toBe(10);
    expect('expired' in entry(freshId).fields).toBe(false);
    expect(entry(freshId).rank).toBe(10);
  });
});

describe('§4.1 N4: a purge keeps the decisions closed in the last 24 hours', () => {
  /** A grant that ended and a decision withdrawn, `agoMs` before the clock; a note closed too. */
  async function ended(agoMs: number): Promise<{ grant: string; withdrawn: string; note: string }> {
    const grant = await add('decision', { promoteTo: 'issue:#1' });
    db.prepare('UPDATE mem_items SET promote_to = NULL WHERE id = ?').run(grant);
    markGrant(grant, clock - agoMs);
    closeAt(grant, agoMs, 'condition');
    const withdrawn = await add('decision', { promoteTo: 'issue:#2' });
    closeAt(withdrawn, agoMs, 'withdrawn');
    const note = await add('note');
    closeAt(note, agoMs, 'manual');
    return { grant, withdrawn, note };
  }
  const endedCounts = () => decisionCountsOf('on', listMem(db, scope(), { all: true }).items, clock);

  it.each([
    ['--closed-only --kind decision', { closedOnly: true, kind: 'decision' }],
    ['--include-decisions', { includeDecisions: true }],
    ['--closed-only --include-decisions', { closedOnly: true, includeDecisions: true }],
  ])('%s --confirm: both stay, the counts of what ended unchanged; the note goes', async (_name, filter) => {
    const made = await ended(HOUR);
    expect(endedCounts()).toMatchObject({ endedGrants: 1, withdrawnDecisions: 1 });
    const dry = (await memPurge(db, REPO(), filter, deps())).body as MemPurgeResponse;
    expect(dry.counts.decision).toBeUndefined();
    const purged = await memPurge(db, REPO(), { ...filter, confirm: true }, deps());
    expect(purged.status).toBe(200);
    expect(getMemRecord(db, made.grant)).not.toBeNull();
    expect(getMemRecord(db, made.withdrawn)).not.toBeNull();
    if (!('kind' in filter)) expect(getMemRecord(db, made.note)).toBeNull();
    expect(endedCounts()).toMatchObject({ endedGrants: 1, withdrawnDecisions: 1 });
  });

  it('24 hours and 1 minute later the same purge removes them', async () => {
    const made = await ended(HOUR);
    clock = NOW + MEM_PURGE_RECENT_DECISION_MS - HOUR + 60_000;
    const dry = (await memPurge(db, REPO(), { includeDecisions: true }, deps())).body as MemPurgeResponse;
    expect(dry.counts.decision).toBe(2);
    await memPurge(db, REPO(), { includeDecisions: true, confirm: true }, deps());
    expect(getMemRecord(db, made.grant)).toBeNull();
    expect(getMemRecord(db, made.withdrawn)).toBeNull();
    expect(rows()).toBe(0);
  });

  it('(control) a decision closed 25 hours ago is purged as before', async () => {
    const made = await ended(25 * HOUR);
    await memPurge(db, REPO(), { closedOnly: true, kind: 'decision', confirm: true }, deps());
    expect(getMemRecord(db, made.grant)).toBeNull();
    expect(getMemRecord(db, made.withdrawn)).toBeNull();
    expect(getMemRecord(db, made.note)).not.toBeNull();
  });
});
