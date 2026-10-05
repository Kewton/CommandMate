/**
 * Malformed JSON bodies answer 400 `Invalid request body` (Issue #3295).
 * @vitest-environment node
 *
 * Six routes parsed the body inside their outer try, so a syntax error landed in
 * the catch as a 500 plus an error-level log line — a client mistake that looked
 * like a server fault. They now share `readJsonBody`, as special-keys and
 * clear-composer already did by hand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createMemo } from '@/lib/db/memo-db';
import { createTodo } from '@/lib/db/worktree-todo-db';
import type { Worktree } from '@/types/models';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withContext: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

let mockDb: Database.Database | null = null;
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (!mockDb) throw new Error('Mock DB not initialized');
    return mockDb;
  },
  closeDbInstance: () => { mockDb?.close(); mockDb = null; },
}));

import { POST as terminalPOST } from '@/app/api/worktrees/[id]/terminal/route';
import { POST as sendPOST } from '@/app/api/worktrees/[id]/send/route';
import { POST as respondPOST } from '@/app/api/worktrees/[id]/respond/route';
import { POST as capturePOST } from '@/app/api/worktrees/[id]/capture/route';
import { POST as promptResponsePOST } from '@/app/api/worktrees/[id]/prompt-response/route';
import { POST as timersPOST } from '@/app/api/worktrees/[id]/timers/route';
import { POST as specialKeysPOST } from '@/app/api/worktrees/[id]/special-keys/route';
import { POST as clearComposerPOST } from '@/app/api/worktrees/[id]/clear-composer/route';
import { PUT as filesPUT, POST as filesPOST, PATCH as filesPATCH } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { PATCH as cliToolPATCH } from '@/app/api/worktrees/[id]/cli-tool/route';
import { PATCH as worktreePATCH } from '@/app/api/worktrees/[id]/route';
import { PUT as notesPUT } from '@/app/api/worktrees/[id]/instances/notes/route';
import { PUT as opencodeInstancePUT } from '@/app/api/worktrees/[id]/instances/opencode/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as dailySummaryPOST, PUT as dailySummaryPUT } from '@/app/api/daily-summary/route';
import { PATCH as externalAppPATCH } from '@/app/api/external-apps/[id]/route';
import { POST as externalAppsPOST } from '@/app/api/external-apps/route';
import { POST as claudeDonePOST } from '@/app/api/hooks/claude-done/route';
import { PATCH as pushEscalationPATCH } from '@/app/api/push/escalation/route';
import { POST as pushSubscriptionsPOST, PATCH as pushSubscriptionsPATCH } from '@/app/api/push/subscriptions/route';
import { POST as relaysPOST } from '@/app/api/relays/route';
import { PUT as repositoryPUT } from '@/app/api/repositories/[id]/route';
import { POST as clonePOST } from '@/app/api/repositories/clone/route';
import { PUT as restorePUT } from '@/app/api/repositories/restore/route';
import { DELETE as repositoriesDELETE } from '@/app/api/repositories/route';
import { POST as scanPOST } from '@/app/api/repositories/scan/route';
import { PUT as groupOrderPUT } from '@/app/api/sidebar/group-order/route';
import { PUT as templatePUT } from '@/app/api/templates/[id]/route';
import { POST as templatesPOST } from '@/app/api/templates/route';

const WORKTREE_ID = 'wt-3295';

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const ROUTES: Array<[string, Handler]> = [
  ['terminal', terminalPOST as Handler],
  ['send', sendPOST as Handler],
  ['respond', respondPOST as Handler],
  ['capture', capturePOST as Handler],
  ['prompt-response', promptResponsePOST as Handler],
  ['timers', timersPOST as Handler],
  ['special-keys', specialKeysPOST as Handler],
  ['clear-composer', clearComposerPOST as Handler],
];

function call(handler: Handler, route: string, body: string) {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/${route}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
  return handler(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('malformed JSON body → 400 Invalid request body (#3295)', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'wt',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(mockDb, worktree);
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  it.each(ROUTES)('%s: broken JSON returns 400 and logs no error', async (route, handler) => {
    const response = await call(handler, route, 'this is not valid JSON');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request body' });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s: empty body returns 400', async (route, handler) => {
    const response = await call(handler, route, '');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request body' });
  });

  for (const body of ['null', '[]', '1', '"text"']) {
    it.each(ROUTES)(`%s: non-object body ${body} returns 400 and logs no error (#3333)`, async (route, handler) => {
      const response = await call(handler, route, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid request body' });
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  }

  it.each(ROUTES)('%s: well-formed JSON still reaches validation', async (route, handler) => {
    const response = await call(handler, route, JSON.stringify({}));

    expect(await response.json()).not.toEqual({ error: 'Invalid request body' });
    expect(response.status).not.toBe(500);
  });
});

// Routes whose bodies are read after a #3295 sweep of the remaining bare `req.json()` calls.
// `shape` is how the route words its input errors, so the assertion follows the route.
type Shape = 'error' | 'success-error' | 'clone' | 'files';
const TEMPLATE_ID = '123e4567-e89b-42d3-a456-426614174000';

const SWEPT: Array<[string, string, string, Handler, Shape, string?]> = [
  ['files PUT', 'PUT', `worktrees/${WORKTREE_ID}/files/a.md`, filesPUT as unknown as Handler, 'files'],
  ['files POST', 'POST', `worktrees/${WORKTREE_ID}/files/a.md`, filesPOST as unknown as Handler, 'files'],
  ['files PATCH', 'PATCH', `worktrees/${WORKTREE_ID}/files/a.md`, filesPATCH as unknown as Handler, 'files'],
  ['cli-tool PATCH', 'PATCH', `worktrees/${WORKTREE_ID}/cli-tool`, cliToolPATCH as Handler, 'error'],
  ['worktree PATCH', 'PATCH', `worktrees/${WORKTREE_ID}`, worktreePATCH as Handler, 'error'],
  ['instances/notes PUT', 'PUT', `worktrees/${WORKTREE_ID}/instances/notes`, notesPUT as Handler, 'error'],
  ['instances/opencode PUT', 'PUT', `worktrees/${WORKTREE_ID}/instances/opencode`, opencodeInstancePUT as Handler, 'error'],
  ['auth/login POST', 'POST', 'auth/login', loginPOST as Handler, 'error'],
  ['daily-summary POST', 'POST', 'daily-summary', dailySummaryPOST as Handler, 'error'],
  ['daily-summary PUT', 'PUT', 'daily-summary', dailySummaryPUT as Handler, 'error'],
  ['external-apps/[id] PATCH', 'PATCH', `external-apps/${WORKTREE_ID}`, externalAppPATCH as Handler, 'error', 'external-app'],
  ['external-apps POST', 'POST', 'external-apps', externalAppsPOST as Handler, 'error'],
  ['hooks/claude-done POST', 'POST', 'hooks/claude-done', claudeDonePOST as Handler, 'error'],
  ['push/escalation PATCH', 'PATCH', 'push/escalation', pushEscalationPATCH as Handler, 'error'],
  ['push/subscriptions POST', 'POST', 'push/subscriptions', pushSubscriptionsPOST as Handler, 'error'],
  ['push/subscriptions PATCH', 'PATCH', 'push/subscriptions', pushSubscriptionsPATCH as Handler, 'error'],
  ['relays POST', 'POST', 'relays', relaysPOST as Handler, 'error'],
  ['repositories/[id] PUT', 'PUT', `repositories/${WORKTREE_ID}`, repositoryPUT as Handler, 'error'],
  ['repositories/clone POST', 'POST', 'repositories/clone', clonePOST as Handler, 'clone'],
  ['repositories/restore PUT', 'PUT', 'repositories/restore', restorePUT as Handler, 'success-error'],
  ['repositories DELETE', 'DELETE', 'repositories', repositoriesDELETE as Handler, 'success-error'],
  ['repositories/scan POST', 'POST', 'repositories/scan', scanPOST as Handler, 'error'],
  ['sidebar/group-order PUT', 'PUT', 'sidebar/group-order', groupOrderPUT as Handler, 'success-error'],
  ['templates/[id] PUT', 'PUT', `templates/${TEMPLATE_ID}`, templatePUT as Handler, 'error'],
  ['templates POST', 'POST', 'templates', templatesPOST as Handler, 'error'],
];

const OWN_OBJECT_CHECK = new Set([
  'cli-tool PATCH', 'worktree PATCH', 'instances/notes PUT', 'instances/opencode PUT',
  'push/escalation PATCH', 'repositories/[id] PUT', 'daily-summary POST',
]);

function callSwept(handler: Handler, method: string, path: string, body: string) {
  const request = new NextRequest(`http://localhost:3000/api/${path}`, {
    method,
    body,
    headers: { 'Content-Type': 'application/json' },
  });
  const id = path.startsWith('templates/') ? TEMPLATE_ID : path.startsWith('worktrees/') ? WORKTREE_ID : path.split('/')[1];
  return handler(request, {
    params: Promise.resolve({ id, path: ['a.md'] } as { id: string }),
  });
}

describe('malformed JSON body → 400 in the remaining routes (#3295 sweep)', () => {
  let worktreeDir: string;

  beforeEach(() => {
    // The files route resolves the real path, so the worktree needs a directory.
    worktreeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3295-')));
    fs.writeFileSync(path.join(worktreeDir, 'a.md'), 'x');
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    upsertWorktree(mockDb, {
      id: WORKTREE_ID,
      name: 'wt',
      path: worktreeDir,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    });
    mockDb.prepare(
      `INSERT INTO external_apps (id, name, display_name, description, path_prefix, target_port, target_host, app_type, websocket_enabled, websocket_path_pattern, enabled, created_at, updated_at)
       VALUES (?, 'app', 'App', NULL, 'app', 4000, 'localhost', 'other', 0, NULL, 1, 1, 1)`
    ).run(WORKTREE_ID);
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  for (const body of ['this is not valid JSON', '', 'null', '[]', '1']) {
    it.each(SWEPT)(`%s: ${body === '' ? 'empty body' : body === 'this is not valid JSON' ? 'broken JSON' : `non-object ${body}`} → 400 and no error log`, async (_label, method, path, handler, shape) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await callSwept(handler, method, path, body);
      const data = await response.json();
      consoleError.mockRestore();

      // push/escalation normalizes field by field, so an array falls back to defaults (200) by design.
      if (_label === 'push/escalation PATCH' && body === '[]') return;
      expect(response.status).toBe(400);
      // Routes that already checked for an object keep their own wording (#3333).
      const ownCheck = body !== 'this is not valid JSON' && body !== '' && OWN_OBJECT_CHECK.has(_label);
      if (ownCheck) expect(data).toHaveProperty('error');
      else if (shape === 'error') expect(data).toEqual({ error: 'Invalid request body' });
      else if (shape === 'success-error') expect(data).toEqual({ success: false, error: 'Invalid request body' });
      else if (shape === 'files') expect(data).toEqual({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request body' } });
      else if (shape === 'clone') {
        expect(data.success).toBe(false);
        expect(data.error.code).toBe('INVALID_REQUEST_BODY');
        expect(data.error.message).toBe('Invalid request body');
      }
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });
  }
});

// Routes that read the body themselves (`.catch(() => ({}))` or a local try/catch) and then
// destructure it: a JSON `null` used to throw a TypeError into the outer catch (#3333).
type ReadRoute = [label: string, method: string, urlPath: string, modulePath: string, exportName: string, extraParams: Record<string, string>, valid?: string];
const W = `worktrees/${WORKTREE_ID}`;
const GIT = '@/app/api/worktrees/[id]/git';
const SELF_READ: ReadRoute[] = [
  ['git/branch/create', 'POST', `${W}/git/branch/create`, `${GIT}/branch/create/route`, 'POST', {}, '{}'],
  ['git/branch/delete', 'POST', `${W}/git/branch/delete`, `${GIT}/branch/delete/route`, 'POST', {}, '{}'],
  ['git/checkout', 'POST', `${W}/git/checkout`, `${GIT}/checkout/route`, 'POST', {}, '{}'],
  ['git/commit', 'POST', `${W}/git/commit`, `${GIT}/commit/route`, 'POST', {}, '{}'],
  ['git/fetch', 'POST', `${W}/git/fetch`, `${GIT}/fetch/route`, 'POST', {}, '{"remote":"bad name"}'],
  ['git/pull', 'POST', `${W}/git/pull`, `${GIT}/pull/route`, 'POST', {}, '{"rebase":true,"ffOnly":true}'],
  ['git/push', 'POST', `${W}/git/push`, `${GIT}/push/route`, 'POST', {}, '{"remote":"bad name"}'],
  ['git/reset', 'POST', `${W}/git/reset`, `${GIT}/reset/route`, 'POST', {}, '{}'],
  ['git/revert', 'POST', `${W}/git/revert`, `${GIT}/revert/route`, 'POST', {}, '{}'],
  ['git/stage', 'POST', `${W}/git/stage`, `${GIT}/stage/route`, 'POST', {}, '{}'],
  ['git/unstage', 'POST', `${W}/git/unstage`, `${GIT}/unstage/route`, 'POST', {}, '{}'],
  ['git/stash/apply', 'POST', `${W}/git/stash/apply`, `${GIT}/stash/apply/route`, 'POST', {}, '{"index":-1}'],
  ['git/stash/pop', 'POST', `${W}/git/stash/pop`, `${GIT}/stash/pop/route`, 'POST', {}, '{"index":-1}'],
  ['git/stash/push', 'POST', `${W}/git/stash/push`, `${GIT}/stash/push/route`, 'POST', {}],
  ['memos POST', 'POST', `${W}/memos`, '@/app/api/worktrees/[id]/memos/route', 'POST', {}],
  ['memos PATCH', 'PATCH', `${W}/memos`, '@/app/api/worktrees/[id]/memos/route', 'PATCH', {}, '{}'],
  ['memos/[memoId] PUT', 'PUT', `${W}/memos/MEMO`, '@/app/api/worktrees/[id]/memos/[memoId]/route', 'PUT', { memoId: 'MEMO' }],
  ['todos POST', 'POST', `${W}/todos`, '@/app/api/worktrees/[id]/todos/route', 'POST', {}, '{}'],
  ['todos PATCH', 'PATCH', `${W}/todos`, '@/app/api/worktrees/[id]/todos/route', 'PATCH', {}, '{}'],
  ['todos/[todoId] PATCH', 'PATCH', `${W}/todos/TODO`, '@/app/api/worktrees/[id]/todos/[todoId]/route', 'PATCH', { todoId: 'TODO' }, '{}'],
  ['schedules POST', 'POST', `${W}/schedules`, '@/app/api/worktrees/[id]/schedules/route', 'POST', {}, '{}'],
  ['schedules/[scheduleId] PUT', 'PUT', `${W}/schedules/s1`, '@/app/api/worktrees/[id]/schedules/[scheduleId]/route', 'PUT', { scheduleId: 's1' }],
  ['cmate/schedules POST', 'POST', `${W}/cmate/schedules`, '@/app/api/worktrees/[id]/cmate/schedules/route', 'POST', {}, '{}'],
  ['cmate/schedules PATCH', 'PATCH', `${W}/cmate/schedules`, '@/app/api/worktrees/[id]/cmate/schedules/route', 'PATCH', {}, '{}'],
  ['cmate/schedules DELETE', 'DELETE', `${W}/cmate/schedules`, '@/app/api/worktrees/[id]/cmate/schedules/route', 'DELETE', {}, '{}'],
  ['push/subscriptions DELETE', 'DELETE', 'push/subscriptions', '@/app/api/push/subscriptions/route', 'DELETE', {}, '{}'],
  ['interrupt POST', 'POST', `${W}/interrupt`, '@/app/api/worktrees/[id]/interrupt/route', 'POST', {}, '{"instanceId":"../x"}'],
  ['opencode/diff POST', 'POST', `${W}/opencode/diff`, '@/app/api/worktrees/[id]/opencode/diff/route', 'POST', {}, '{}'],
  ['opencode/session POST', 'POST', `${W}/opencode/session`, '@/app/api/worktrees/[id]/opencode/session/route', 'POST', {}, '{}'],
  ['opencode/share POST', 'POST', `${W}/opencode/share`, '@/app/api/worktrees/[id]/opencode/share/route', 'POST', {}, '{"instanceId":"../x"}'],
  ['auto-yes POST', 'POST', `${W}/auto-yes`, '@/app/api/worktrees/[id]/auto-yes/route', 'POST', {}, '{}'],
  ['marp-render POST', 'POST', `${W}/marp-render`, '@/app/api/worktrees/[id]/marp-render/route', 'POST', {}, '{}'],
  ['direct-input POST', 'POST', `${W}/direct-input`, '@/app/api/worktrees/[id]/direct-input/route', 'POST', {}, '{}'],
];

let seeded: Record<string, string> = {};

describe('non-object JSON body → 400 in routes that read the body themselves (#3333)', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    upsertWorktree(mockDb, {
      id: WORKTREE_ID,
      name: 'wt',
      path: os.tmpdir(),
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    });
    vi.clearAllMocks();
    mockLogger.withContext.mockReturnValue(mockLogger);
    // memo / todo routes look the row up before they read the body.
    seeded = {
      MEMO: createMemo(mockDb, WORKTREE_ID, { position: 0 }).id,
      TODO: createTodo(mockDb, WORKTREE_ID, { content: 'x', position: 0 }).id,
    };
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  async function callSelf([, method, urlPath, modulePath, exportName, extra]: ReadRoute, body: string) {
    const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, Handler>;
    const request = new NextRequest(`http://localhost:3000/api/${urlPath}`, {
      method,
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    return mod[exportName](request, { params: Promise.resolve({ id: WORKTREE_ID, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, seeded[v] ?? v])) }) });
  }

  for (const body of ['null', '[]', '1']) {
    it.each(SELF_READ)(`%s: ${body} → 400, no error log`, async (...route) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await callSelf(route, body);
      consoleError.mockRestore();

      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });
  }

  it.each(SELF_READ.filter((r) => r[6] !== undefined))('%s: an ordinary object body still reaches the route’s own validation', async (...route) => {
    const response = await callSelf(route, route[6] as string);

    expect(response.status).not.toBe(500);
    const data = await response.json();
    expect(data.error).not.toBe('Invalid request body');
  });
});
