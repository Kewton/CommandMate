/**
 * The screen's item routes as Next calls them (Issue #4227, design `mem-ui-4227.md`
 * §2.3): the mark is asked before anything is read (403 `screen_only`), the writer is
 * the person, a stale version answers 409 with the item now, and a recorded decision
 * closes only with the confirmation. git is replaced at its two modules.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
vi.mock('@/lib/git/git-common-dir', () => ({
  probeGitCommonDir: async () => ({ kind: 'repository', commonDir: '/c/.git' }),
  resolveGitCommonDir: async () => '/c/.git',
}));
vi.mock('@/lib/mem/git-observe', () => ({
  observeWorktreeHead: async () => ({ branch: 'main', detached: false, head: null, commonDir: '/c/.git', known: true }),
  readOriginUrl: async () => null,
  readRefTip: async () => null,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { createRepository } from '@/lib/db/db-repository';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { POST as postItem } from '@/app/api/worktrees/[id]/mem/screen/items/route';
import { PATCH as patchItem } from '@/app/api/worktrees/[id]/mem/screen/items/[itemId]/route';
import { POST as closeItem } from '@/app/api/worktrees/[id]/mem/screen/items/[itemId]/close/route';
import { POST as agentAdd } from '@/app/api/worktrees/[id]/mem/items/route';
import { POST as agentClose } from '@/app/api/worktrees/[id]/mem/items/[itemId]/close/route';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';

const WT = 'wt-4227-api';
const BASE = `http://localhost:3000/api/worktrees/${WT}/mem`;

let dir: string;
let db: Database.Database;
let repo: string;

function req(url: string, init: RequestInit = {}): NextRequest {
  const request = new Request(url, init) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}
const screenHeaders = { 'Content-Type': 'application/json', [SCREEN_CLIENT_HEADER]: 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' };
const plainHeaders = { 'Content-Type': 'application/json', host: 'localhost:3000' };
const json = async (response: Response) => ({ status: response.status, body: await response.json() });

const add = (body: Record<string, unknown>, headers: Record<string, string> = screenHeaders) =>
  postItem(req(`${BASE}/screen/items`, { method: 'POST', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id: WT }) }).then(json);
const patch = (itemId: string, body: Record<string, unknown>, headers: Record<string, string> = screenHeaders) =>
  patchItem(req(`${BASE}/screen/items/${itemId}`, { method: 'PATCH', headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: WT, itemId }),
  }).then(json);
const close = (itemId: string, body: Record<string, unknown>, headers: Record<string, string> = screenHeaders) =>
  closeItem(req(`${BASE}/screen/items/${itemId}/close`, { method: 'POST', headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: WT, itemId }),
  }).then(json);

function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repo);
  saveMemSettings(db, repo, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}
const row = (id: string) => db.prepare('SELECT state, text, version, close_reason, created_by, updated_by FROM mem_items WHERE id = ?').get(id) as Record<string, unknown>;

beforeEach(async () => {
  dir = makeTempDir('mem-screen-routes-4227-');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const root = path.join(dir, 'root');
  mkdirSync(root);
  mkdirSync(path.join(dir, 'wt'));
  repo = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(WT, WT, path.join(dir, 'wt'), root);
  setAgentInstances(db, WT, [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
  setMode('on');
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('[#4227] the screen’s item routes', () => {
  it('add: the writer is the person; without the mark 403 and nothing written', async () => {
    const refused = await add({ instanceId: 'claude', kind: 'note', text: 'no mark', key: 'k-1', expectBranch: 'main' }, plainHeaders);
    expect(refused).toMatchObject({ status: 403, body: { code: 'screen_only' } });
    expect((db.prepare('SELECT COUNT(*) n FROM mem_items').get() as { n: number }).n).toBe(0);
    const added = await add({ instanceId: 'claude', kind: 'note', text: 'by a person', key: 'k-2', expectBranch: 'main' });
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ createdBy: 'human', updatedBy: 'human', owner: { instanceId: 'claude', branch: 'main' } });
  });

  it('add for another branch than HEAD → 409 membership_changed', async () => {
    const refused = await add({ instanceId: 'claude', kind: 'note', text: 'wrong branch', key: 'k-3', expectBranch: 'feature/other' });
    expect(refused).toMatchObject({ status: 409, body: { code: 'membership_changed' } });
  });

  it('edit: a stale version is 409 with the item now; the version read saves', async () => {
    const made = (await add({ instanceId: 'claude', kind: 'note', text: 'v1', key: 'k-4', expectBranch: 'main' })).body.item;
    const saved = await patch(made.id, { instanceId: 'claude', ifVersion: made.version, text: 'v2' });
    expect(saved.status).toBe(201);
    const stale = await patch(made.id, { instanceId: 'claude', ifVersion: made.version, text: 'v3' });
    expect(stale).toMatchObject({ status: 409, body: { code: 'version_conflict', currentVersion: made.version + 1, item: { text: 'v2' } } });
    expect(row(made.id)).toMatchObject({ text: 'v2', updated_by: 'human' });
    const noMark = await patch(made.id, { instanceId: 'claude', ifVersion: made.version + 1, text: 'v4' }, plainHeaders);
    expect(noMark.status).toBe(403);
    expect(row(made.id)).toMatchObject({ text: 'v2' });
  });

  it('close: derived refuses; a recorded decision needs the confirmation, and the CLI route still refuses it', async () => {
    const decision = await json(
      await agentAdd(
        req(`${BASE}/items`, { method: 'POST', headers: plainHeaders, body: JSON.stringify({ instanceId: 'claude', kind: 'decision', text: 'd', promoteTo: 'issue:#1' }) }),
        { params: Promise.resolve({ id: WT }) }
      )
    );
    const id = decision.body.item.id as string;
    db.prepare("UPDATE mem_items SET state = 'recorded', version = version + 1 WHERE id = ?").run(id);
    const version = row(id).version as number;

    setMode('derived');
    expect(await close(id, { instanceId: 'claude', ifVersion: version, confirmUnreflected: true })).toMatchObject({ status: 409, body: { code: 'disabled' } });
    setMode('on');

    expect(await close(id, { instanceId: 'claude', ifVersion: version })).toMatchObject({ status: 409, body: { code: 'confirmation_required' } });
    const cli = await json(
      await agentClose(req(`${BASE}/items/${id}/close`, { method: 'POST', headers: plainHeaders, body: JSON.stringify({ instanceId: 'claude' }) }), {
        params: Promise.resolve({ id: WT, itemId: id }),
      })
    );
    expect(cli).toMatchObject({ status: 409, body: { code: 'state_forbids' } });
    expect(row(id)).toMatchObject({ state: 'recorded' });

    const closed = await close(id, { instanceId: 'claude', ifVersion: version, confirmUnreflected: true, reason: '反映しない' });
    expect(closed.status).toBe(201);
    expect(row(id)).toMatchObject({ state: 'closed', close_reason: 'withdrawn', updated_by: 'human' });
  });

  it('a body that is not an object is 400', async () => {
    const response = await postItem(req(`${BASE}/screen/items`, { method: 'POST', headers: screenHeaders, body: '[1]' }), { params: Promise.resolve({ id: WT }) });
    expect(response.status).toBe(400);
  });
});
