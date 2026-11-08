/**
 * The mem routes as Next calls them (Issue #4221): the #2427 note route's checks by
 * row and mode (T1・§6.3, R1・R7, 2nd review 1), the screen-only settings routes (R8),
 * and the worktree list carrying the added fields. git is replaced at its two modules.
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
vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => []) }));
vi.mock('@/lib/git/git-common-dir', () => ({
  probeGitCommonDir: async () => ({ kind: 'repository', commonDir: '/c/.git' }),
  resolveGitCommonDir: async () => '/c/.git',
}));
vi.mock('@/lib/mem/git-observe', () => ({
  observeWorktreeHead: async () => ({ branch: 'main', detached: false, head: null, commonDir: '/c/.git', known: true }),
  readOriginUrl: async () => null,
  readRefTip: async () => null,
}));
const logged: unknown[] = [];
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const record = (...args: unknown[]) => logged.push(args);
    return { info: record, warn: record, error: record, debug: record, withContext: () => ({}) };
  },
}));

import { createRepository } from '@/lib/db/db-repository';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { PUT as putNote, GET as getNotes } from '@/app/api/worktrees/[id]/instances/notes/route';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { POST as postNow } from '@/app/api/worktrees/[id]/mem/now/route';
import { GET as getList } from '@/app/api/worktrees/[id]/mem/route';
import { GET as getSettings, PUT as putSettings } from '@/app/api/repositories/[id]/mem-settings/route';
import { PUT as putOverride } from '@/app/api/repositories/[id]/mem-settings/branches/route';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';

const WT = 'wt-4221-api';
const GHP = `ghp_${'c'.repeat(36)}`;

let dir: string;
let db: Database.Database;
let repo: string;

function req(url: string, init: RequestInit = {}): NextRequest {
  const request = new Request(url, init) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function put(body: Record<string, unknown>) {
  const response = await putNote(
    req(`http://localhost:3000/api/worktrees/${WT}/instances/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(WT)
  );
  return { status: response.status, body: await response.json() };
}

function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repo);
  saveMemSettings(db, repo, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}

beforeEach(async () => {
  dir = makeTempDir('mem-routes-4221-');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const root = path.join(dir, 'root');
  mkdirSync(root);
  mkdirSync(path.join(dir, 'wt'));
  repo = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
    WT,
    WT,
    path.join(dir, 'wt'),
    root
  );
  setAgentInstances(db, WT, [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
  logged.length = 0;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('the #2427 note route with mem (T1・§6.3)', () => {
  it('off, plain note: written as before — no version needed, no mem check (control)', async () => {
    const written = await put({ instanceId: 'claude', text: `token ${GHP}` });
    expect(written.status).toBe(200);
    expect(written.body.note).toMatchObject({ text: `token ${GHP}`, mem: null });
  });

  it('on, plain note: a secret is 400 with the field and rule; the row stays as it was (2nd review 1)', async () => {
    await put({ instanceId: 'claude', text: 'before' });
    setMode('on');
    const refused = await put({ instanceId: 'claude', text: `x ${GHP}` });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'secret_like', field: 'text', rule: 'github-token' });
    expect(JSON.stringify(refused.body) + JSON.stringify(logged)).not.toContain(GHP);
    const notes = await (await getNotes(req(`http://localhost:3000/api/worktrees/${WT}/instances/notes`), params(WT))).json();
    expect(notes.notes.claude).toMatchObject({ text: 'before', mem: null });
    // An ordinary note in on becomes the now of mem (control).
    const ok = await put({ instanceId: 'claude', text: '通常の文', baseVersion: notes.notes.claude.version });
    expect(ok.status).toBe(200);
    expect(ok.body.note).toMatchObject({ text: '通常の文', mem: { createdBy: 'human' } });
  });

  it('a mem row, in off: still mem-checked (400) and needs the version (version_required)', async () => {
    setMode('on');
    const now = await postNow(
      req(`http://localhost:3000/api/worktrees/${WT}/mem/now`, { method: 'POST', body: JSON.stringify({ instanceId: 'claude', text: 'agent now' }) }),
      params(WT)
    );
    const item = (await now.json()).item;
    setMode('off');
    expect((await put({ instanceId: 'claude', text: 'no version' })).body).toMatchObject({ code: 'version_required' });
    const secret = await put({ instanceId: 'claude', text: `x ${GHP}`, baseVersion: item.version });
    expect(secret.status).toBe(400);
    // R1: back in on, the secret is nowhere in the list.
    setMode('on');
    const list = await (await getList(req(`http://localhost:3000/api/worktrees/${WT}/mem`), params(WT))).json();
    expect(JSON.stringify(list)).not.toContain(GHP);
    expect(list.now[0].item).toMatchObject({ text: 'agent now', version: item.version });
  });

  it('a stale baseVersion is 409 with the current text; the CLI’s write stands (R7)', async () => {
    setMode('on');
    const first = await put({ instanceId: 'claude', text: 'screen' });
    const read = first.body.note.version;
    await postNow(
      req(`http://localhost:3000/api/worktrees/${WT}/mem/now`, { method: 'POST', body: JSON.stringify({ instanceId: 'claude', text: 'cli' }) }),
      params(WT)
    );
    const stale = await put({ instanceId: 'claude', text: 'screen again', baseVersion: read });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { text: 'cli' } });
  });

  it('GET /api/worktrees carries version and mem beside text and updatedAt', async () => {
    await put({ instanceId: 'claude', text: 'note' });
    const url = 'http://localhost:3000/api/worktrees?includeStatus=0';
    const body = await (await getWorktrees(req(url))).json();
    const worktree = body.worktrees.find((entry: { id: string }) => entry.id === WT);
    expect(worktree.sessionNotes.claude).toEqual({ text: 'note', updatedAt: expect.any(Number), version: expect.any(Number), mem: null });
  });
});

describe('the settings routes change the mode from the screen only (R8)', () => {
  const settingsUrl = () => `http://localhost:3000/api/repositories/${repo}/mem-settings`;
  const body = (version: number) =>
    JSON.stringify({ version, features: { injectOnStart: false, promptOnEvents: false, popup: false }, rules: [{ match: 'glob', pattern: 'main', mode: 'on' }] });

  it('refuses a write without the mark (the CLI, Bearer or not) with 403 and changes nothing', async () => {
    const attempts: Array<Record<string, string>> = [{ host: 'localhost:3000' }, { host: 'localhost:3000', authorization: 'Bearer t' }];
    for (const headers of attempts) {
      const response = await putSettings(req(settingsUrl(), { method: 'PUT', headers, body: body(0) }), params(repo));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'screen_only' });
    }
    const override = await putOverride(
      req(`${settingsUrl()}/branches`, { method: 'PUT', headers: { host: 'localhost:3000' }, body: JSON.stringify({ version: 0, branch: 'main', mode: 'on' }) }),
      params(repo)
    );
    expect(override.status).toBe(403);
    expect(getMemSettings(db, repo).version).toBe(0);
  });

  it('takes a write with the mark and a matching Origin; a GET needs no mark', async () => {
    const response = await putSettings(
      req(settingsUrl(), {
        method: 'PUT',
        headers: { [SCREEN_CLIENT_HEADER]: 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' },
        body: body(0),
      }),
      params(repo)
    );
    expect(response.status).toBe(200);
    const read = await (await getSettings(req(settingsUrl()), params(repo))).json();
    expect(read.settings).toMatchObject({ version: 1, rules: [{ match: 'glob', pattern: 'main', mode: 'on' }] });
    const stale = await putSettings(
      req(settingsUrl(), {
        method: 'PUT',
        headers: { [SCREEN_CLIENT_HEADER]: 'screen', origin: 'http://localhost:3000', host: 'localhost:3000' },
        body: body(0),
      }),
      params(repo)
    );
    expect(stale.status).toBe(409);
  });
});
