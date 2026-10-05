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
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
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

  it.each(ROUTES)('%s: well-formed JSON still reaches validation', async (route, handler) => {
    const response = await call(handler, route, JSON.stringify({}));

    expect(await response.json()).not.toEqual({ error: 'Invalid request body' });
    expect(response.status).not.toBe(500);
  });
});
