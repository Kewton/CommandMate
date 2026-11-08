/**
 * The routes #4222 adds, as Next calls them: `POST …/mem/check`, the screen's list of
 * notices nobody took and the person's acknowledgement (screen only). git is replaced
 * at its module; no condition here needs gh.
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
import { memAddItem } from '@/lib/mem/service';
import { POST as postCheck } from '@/app/api/worktrees/[id]/mem/check/route';
import { GET as getNotices } from '@/app/api/repositories/[id]/mem/notices/route';
import { POST as postAcknowledge } from '@/app/api/repositories/[id]/mem/notices/[noticeId]/acknowledge/route';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';
import type { MemCheckResponse, MemNoticeListResponse } from '@/types/mem';

const WT = 'wt-4222-api';
let dir: string;
let db: Database.Database;
let repo: string;

function req(url: string, init: RequestInit = {}): NextRequest {
  const request = new Request(url, init) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}

function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repo);
  saveMemSettings(db, repo, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}

const check = async () => {
  const response = await postCheck(
    req(`http://localhost:3000/api/worktrees/${WT}/mem/check`, { method: 'POST', body: JSON.stringify({ instanceId: 'claude' }) }),
    { params: Promise.resolve({ id: WT }) }
  );
  return { status: response.status, body: await response.json() };
};

beforeEach(async () => {
  dir = makeTempDir('mem-routes-4222-');
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
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('#4222 routes', () => {
  it('check closes a met condition in on, answers disabled in off', async () => {
    setMode('on');
    const added = await memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'x', closeWhen: 'at:2020-01-01T00:00+00:00' });
    expect(added.status).toBe(201);
    const first = await check();
    expect(first.status).toBe(200);
    expect((first.body as MemCheckResponse).results.map((entry) => [entry.condition.result, entry.condition.closed])).toEqual([['met', true]]);
    setMode('off');
    const off = await check();
    expect([off.status, off.body.code]).toEqual([409, 'disabled']);
  });

  it('the notices list needs a branch; a person takes one from the screen only', async () => {
    setMode('on');
    await memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'x', closeWhen: 'at:2020-01-01T00:00+00:00' });
    await check();
    const noBranch = await getNotices(req(`http://localhost:3000/api/repositories/${repo}/mem/notices`), { params: Promise.resolve({ id: repo }) });
    expect(noBranch.status).toBe(400);
    const listed = await getNotices(req(`http://localhost:3000/api/repositories/${repo}/mem/notices?branch=main`), { params: Promise.resolve({ id: repo }) });
    const notices = ((await listed.json()) as MemNoticeListResponse).notices;
    expect(notices).toHaveLength(1);
    const url = `http://localhost:3000/api/repositories/${repo}/mem/notices/${notices[0].id}/acknowledge`;
    const params = { params: Promise.resolve({ id: repo, noticeId: notices[0].id }) };
    const cli = await postAcknowledge(req(url, { method: 'POST', body: JSON.stringify({ ifVersion: notices[0].version }) }), params);
    expect([cli.status, (await cli.json()).code]).toEqual([403, 'screen_only']);
    const screen = await postAcknowledge(
      req(url, {
        method: 'POST',
        headers: { [SCREEN_CLIENT_HEADER]: 'screen', Origin: 'http://localhost:3000', Host: 'localhost:3000' },
        body: JSON.stringify({ ifVersion: notices[0].version }),
      }),
      params
    );
    expect(screen.status).toBe(200);
    expect((db.prepare('SELECT acknowledged_by FROM mem_notices').get() as { acknowledged_by: string }).acknowledged_by).toBe('human');
  });
});
