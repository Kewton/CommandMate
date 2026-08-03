/**
 * Integration tests for GET /api/fs/browse (Issue #1517).
 *
 * This endpoint is the feature's new attack surface — the first one that reveals
 * the server's filesystem layout — so the acceptance criteria are asserted here
 * directly: authentication, traversal/symlink/URL-encoding rejection, no file
 * names in the payload, and a request cap.
 *
 * The route module is re-imported per test because both the auth state
 * (`CM_AUTH_TOKEN_HASH` is read once at import) and the rate limiter live at
 * module scope.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { addRecentBrowsePath } from '@/lib/db/app-settings-db';
import { removeTempDir } from '@tests/helpers/temp-dir';

const AUTH_TOKEN = 'browse-test-token';
const AUTH_TOKEN_HASH = crypto.createHash('sha256').update(AUTH_TOKEN).digest('hex');

let sandbox: string;
let managedRoot: string;
let extraRoot: string;
let foreignDir: string;
let db: Database.Database;

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  // Read lazily so the sandbox created in beforeAll is picked up.
  getEnv: () => ({ CM_ROOT_DIR: managedRoot }),
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => db,
}));

type BrowseRoute = typeof import('@/app/api/fs/browse/route');

/** Fresh module registry so auth state and the rate limiter start clean. */
async function loadBrowseRoute(): Promise<BrowseRoute> {
  vi.resetModules();
  return import('@/app/api/fs/browse/route');
}

function browseRequest(
  params: { path?: string; token?: string; cookie?: boolean } = {}
): NextRequest {
  const url = new URL('http://localhost:3000/api/fs/browse');
  if (params.path !== undefined) url.searchParams.set('path', params.path);

  const headers = new Headers();
  if (params.token && params.cookie) {
    headers.set('cookie', `cm_auth_token=${params.token}`);
  } else if (params.token) {
    headers.set('authorization', `Bearer ${params.token}`);
  }

  return new NextRequest(url, { headers });
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'cm-1517-browse-api-'));
  managedRoot = path.join(sandbox, 'repos');
  extraRoot = path.join(sandbox, 'work');
  foreignDir = path.join(sandbox, 'elsewhere');

  mkdirSync(path.join(managedRoot, 'repo-a', '.git'), { recursive: true });
  mkdirSync(path.join(managedRoot, 'plain'), { recursive: true });
  mkdirSync(path.join(extraRoot, 'repo-b'), { recursive: true });
  mkdirSync(foreignDir, { recursive: true });

  writeFileSync(path.join(managedRoot, 'top-secret.txt'), 'contents');
  writeFileSync(path.join(managedRoot, '.env'), 'SECRET=xxx');
  symlinkSync(foreignDir, path.join(managedRoot, 'escape-link'), 'dir');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  delete process.env.CM_AUTH_TOKEN_HASH;
  delete process.env.CM_BROWSE_ROOTS;
});

afterEach(() => {
  db.close();
});

describe('GET /api/fs/browse — authentication', () => {
  it('rejects an unauthenticated request with 401 when auth is enabled', async () => {
    process.env.CM_AUTH_TOKEN_HASH = AUTH_TOKEN_HASH;
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects a wrong token with 401', async () => {
    process.env.CM_AUTH_TOKEN_HASH = AUTH_TOKEN_HASH;
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest({ token: 'not-the-token' }));

    expect(response.status).toBe(401);
  });

  it('accepts a valid Bearer token', async () => {
    process.env.CM_AUTH_TOKEN_HASH = AUTH_TOKEN_HASH;
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest({ token: AUTH_TOKEN }));

    expect(response.status).toBe(200);
  });

  it('accepts a valid auth cookie', async () => {
    process.env.CM_AUTH_TOKEN_HASH = AUTH_TOKEN_HASH;
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest({ token: AUTH_TOKEN, cookie: true }));

    expect(response.status).toBe(200);
  });

  it('allows the request when auth is not configured (local-only default)', async () => {
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest());

    expect(response.status).toBe(200);
  });
});

describe('GET /api/fs/browse — listing', () => {
  it('returns the allowed roots when no path is given', async () => {
    process.env.CM_BROWSE_ROOTS = extraRoot;
    const { GET } = await loadBrowseRoute();

    const body = await (await GET(browseRequest())).json();

    expect(body.path).toBeNull();
    expect(body.parent).toBeNull();
    expect(body.roots).toEqual([managedRoot, extraRoot]);
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual([
      managedRoot,
      extraRoot,
    ]);
  });

  it('lists directories under a path and never file names', async () => {
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest({ path: managedRoot }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.path).toBe(managedRoot);
    expect(body.entries.map((e: { name: string }) => e.name).sort()).toEqual([
      'plain',
      'repo-a',
    ]);
    expect(JSON.stringify(body)).not.toContain('top-secret.txt');
    expect(JSON.stringify(body)).not.toContain('.env');
  });

  it('annotates git repositories so the picker can badge them', async () => {
    const { GET } = await loadBrowseRoute();

    const body = await (await GET(browseRequest({ path: managedRoot }))).json();
    const entries = new Map(
      body.entries.map((e: { name: string }) => [e.name, e])
    );

    expect(entries.get('repo-a')).toMatchObject({ isGitRepo: true, worktreeCount: 1 });
    expect(entries.get('plain')).toMatchObject({ isGitRepo: false, worktreeCount: null });
  });

  it('reports no parent at a root so the picker cannot walk above it', async () => {
    const { GET } = await loadBrowseRoute();

    const body = await (await GET(browseRequest({ path: managedRoot }))).json();

    expect(body.parent).toBeNull();
  });

  it('reports the parent for a directory below a root', async () => {
    const { GET } = await loadBrowseRoute();

    const body = await (
      await GET(browseRequest({ path: path.join(managedRoot, 'repo-a') }))
    ).json();

    expect(body.parent).toBe(managedRoot);
  });

  it('returns 404 for a directory that does not exist', async () => {
    const { GET } = await loadBrowseRoute();

    const response = await GET(
      browseRequest({ path: path.join(managedRoot, 'no-such-folder') })
    );

    expect(response.status).toBe(404);
  });
});

describe('GET /api/fs/browse — escape attempts', () => {
  it.each([
    ['a directory outside every root', () => '/etc'],
    ['a relative traversal escape', () => '../../etc'],
    ['a traversal escape that re-enters the root', () => `${managedRoot}/../../etc`],
    ['a URL-encoded traversal escape', () => '%2e%2e%2f%2e%2e%2fetc'],
    ['a symlink pointing outside the root', () => path.join(managedRoot, 'escape-link')],
    ['a null byte injection', () => `${managedRoot}\x00.txt`],
  ])('rejects %s with 400', async (_label, makePath) => {
    const { GET } = await loadBrowseRoute();

    const response = await GET(browseRequest({ path: makePath() }));
    const body = await response.json();

    expect(response.status).toBe(400);
    // The message names the allowed roots: an unexplained 400 is what sent
    // users looking for a typo instead of a scope problem (Issue #1517).
    expect(body.error).toContain(managedRoot);
  });
});

describe('GET /api/fs/browse — recently used paths', () => {
  it('surfaces stored paths that still resolve', async () => {
    addRecentBrowsePath(db, path.join(managedRoot, 'repo-a'));
    const { GET } = await loadBrowseRoute();

    const body = await (await GET(browseRequest())).json();

    expect(body.recentPaths).toEqual([path.join(managedRoot, 'repo-a')]);
  });

  it('drops stored paths that fall outside the current roots', async () => {
    // The roots can shrink after a path was stored.
    addRecentBrowsePath(db, path.join(foreignDir, 'gone'));
    const { GET } = await loadBrowseRoute();

    const body = await (await GET(browseRequest())).json();

    expect(body.recentPaths).toEqual([]);
  });
});

describe('GET /api/fs/browse — rate limiting', () => {
  it('returns 429 with Retry-After once the per-IP budget is spent', async () => {
    const { GET } = await loadBrowseRoute();

    let lastStatus = 200;
    // The budget is 120/minute; 130 attempts must cross it.
    for (let i = 0; i < 130; i++) {
      lastStatus = (await GET(browseRequest({ path: managedRoot }))).status;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);

    const blocked = await GET(browseRequest({ path: managedRoot }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });
});
