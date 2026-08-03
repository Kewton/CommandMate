/**
 * Issue #1621 / #1644 Phase 2: `/worktrees/<historical id>` must redirect to the
 * current URL instead of 404ing.
 *
 * This is the half of the fix that reaches humans rather than scripts: the ID
 * lives in bookmarks, in the tab someone left open on their phone, in a PWA
 * shortcut. None of those can be rewritten when the ID behind the directory
 * changes, so the app has to answer for the old URL forever.
 *
 * ## What these tests do and do NOT prove
 *
 * They prove the *decision*: which URL the layout redirects to, and — just as
 * important — the four cases where it must NOT redirect. They do not prove the
 * HTTP status, and deliberately do not claim one.
 *
 * Measured against a real server (`tsx server.ts`, NODE_ENV=production,
 * isolated DB), `permanentRedirect` from this layout answers **HTTP 200** with
 * `<meta id="__next-page-redirect" http-equiv="refresh" content="0;url=...">`,
 * not the 301 the design named and not even the 308 the helper's name suggests.
 * That is App Router behaviour rather than anything about this code: an
 * unconditional `permanentRedirect('/probe-target')` as the layout's first
 * statement produces the same 200 + meta tag. A real 3xx needs `middleware.ts`
 * or the custom `server.ts`, both outside this change's scope (and middleware
 * runs on the edge runtime, where the SQLite lookup is impossible).
 *
 * A unit test asserting "308" here would have been green while the server
 * answered 200 — which is exactly what happened before the live check, so the
 * assertion is on the call, and the status is pinned in the module doc from the
 * measurement instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, recordWorktreeAlias } from '@/lib/db';
import type { Worktree } from '@/types/models';

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
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

const permanentRedirect = vi.fn((url: string) => {
  // Mirrors the real helper: it throws, so nothing after the call runs.
  throw new Error(`NEXT_REDIRECT;replace;${url};308`);
});
const redirect = vi.fn();

vi.mock('next/navigation', () => ({
  permanentRedirect: (url: string) => permanentRedirect(url),
  redirect: (url: string) => redirect(url),
}));

import WorktreeLayout from '@/app/worktrees/[id]/layout';

const OLD_ID = 'anvil-feature-1644-worktree-id';
const NEW_ID = 'commandmate-issue-1644';

const WORKTREE: Worktree = {
  id: NEW_ID,
  name: 'feature/1644-worktree-id',
  branch: 'feature/1644-worktree-id',
  path: '/repos/commandmate-issue-1644',
  repositoryPath: '/repos/commandmate',
  repositoryName: 'commandmate',
};

function renderLayout(id: string) {
  return WorktreeLayout({
    children: null,
    params: Promise.resolve({ id }),
  });
}

describe('/worktrees/[id] redirects a historical ID to the current one', () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    upsertWorktree(db, WORKTREE);
    recordWorktreeAlias(db, OLD_ID, NEW_ID);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('redirects to the canonical URL, using the permanent helper', async () => {
    await expect(renderLayout(OLD_ID)).rejects.toThrow('NEXT_REDIRECT');

    expect(permanentRedirect).toHaveBeenCalledTimes(1);
    expect(permanentRedirect).toHaveBeenCalledWith(`/worktrees/${NEW_ID}`);
    // Permanent rather than temporary — see the module doc for what the server
    // actually emits (200 + meta refresh), which this cannot observe.
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders normally for the current ID', async () => {
    await expect(renderLayout(NEW_ID)).resolves.toBeDefined();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect an unknown ID (the page owns that error)', async () => {
    await expect(renderLayout('never-existed')).resolves.toBeDefined();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect a malformed ID', async () => {
    await expect(renderLayout('../etc/passwd')).resolves.toBeDefined();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('prefers a live worktree over an alias claiming the same ID', async () => {
    // The retired name has since been given to a real, different worktree.
    upsertWorktree(db, {
      ...WORKTREE,
      id: OLD_ID,
      path: '/repos/anvil-feature-1644-worktree-id',
    });

    await expect(renderLayout(OLD_ID)).resolves.toBeDefined();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('renders instead of redirecting when the database is unreadable', async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();

    await expect(renderLayout(OLD_ID)).resolves.toBeDefined();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
