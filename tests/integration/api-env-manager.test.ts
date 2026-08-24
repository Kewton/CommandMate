/**
 * Env Manager API — integration (Issue #1968).
 *
 * Drives the real route handlers against a real temporary worktree and a real
 * (in-memory) database. Three things are pinned here that no unit test can see
 * on its own:
 *
 *   1. END-TO-END PATH CONTAINMENT — `../`, an absolute path and a symlink out
 *      of the worktree are all refused by the HTTP surface, not just by the
 *      helper underneath it.
 *   2. SURFACE ISOLATION — the general file tree still hides `.env*`
 *      (`EXCLUDED_PATTERNS`) while the Env Manager serves it. The feature adds
 *      a second door; it does not widen the first one.
 *   3. NO VALUES IN ERROR BODIES — a refusal names the line and the key, never
 *      the secret.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'fs';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { GET, PUT } from '@/app/api/worktrees/[id]/env/route';
import { GET as getRootTree } from '@/app/api/worktrees/[id]/tree/route';
import { ENV_MASK } from '@/lib/env-manager/env-masking';

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
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

const WORKTREE_ID = 'env-test-worktree';
const SECRET = 'super-secret-token-do-not-leak';
/** A terminal escape sequence, written as an escape so this file stays greppable. */
const ESC_SEQUENCE = '\x1B[31m';

describe('Env Manager API', () => {
  let db: Database.Database;
  let sandbox: string;
  let worktreeDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    sandbox = makeTempDir('api-env-manager-');
    worktreeDir = join(sandbox, 'worktree');
    outsideDir = join(sandbox, 'outside');
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'stolen.env'), 'OUTSIDE=1\n');

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'env-test',
      path: worktreeDir,
      repositoryPath: worktreeDir,
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    removeTempDir(sandbox);
  });

  const params = (id: string = WORKTREE_ID) => ({ params: Promise.resolve({ id }) });

  function getRequest(query = ''): NextRequest {
    return new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/env${query}`);
  }

  function putRequest(body: unknown): NextRequest {
    return new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // --------------------------------------------------------------------------
  // GET
  // --------------------------------------------------------------------------

  describe('GET (list)', () => {
    it('offers .env and .env.local even in an empty worktree', async () => {
      const response = await GET(getRequest(), params());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.files.map((f: { name: string }) => f.name)).toEqual(['.env', '.env.local']);
      expect(data.selected).toBeUndefined();
    });

    it('never caches an env payload', async () => {
      const response = await GET(getRequest('?file=.env'), params());
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    });

    it('404s for an unknown worktree', async () => {
      const response = await GET(getRequest(), { params: Promise.resolve({ id: 'nope' }) });
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  describe('GET (one file)', () => {
    beforeEach(() => {
      writeFileSync(join(worktreeDir, '.env'), `# note\nDB_HOST=localhost\nAPI_KEY=${SECRET}\n`);
      writeFileSync(
        join(worktreeDir, '.env.example'),
        'DB_HOST=\nAPI_KEY=\nEXTRA_KEY=placeholder\n',
      );
    });

    it('returns the raw content and the parsed entries', async () => {
      const response = await GET(getRequest('?file=.env'), params());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.selected.name).toBe('.env');
      expect(data.selected.exists).toBe(true);
      expect(data.selected.content).toContain('# note');
      expect(data.selected.entries.map((e: { key: string }) => e.key)).toEqual([
        'DB_HOST',
        'API_KEY',
      ]);
    });

    it('suggests template keys that are not defined yet', async () => {
      const response = await GET(getRequest('?file=.env'), params());
      const data = await response.json();
      expect(data.selected.suggestions).toEqual([
        { key: 'EXTRA_KEY', source: '.env.example', value: 'placeholder' },
      ]);
    });

    it('reports a file that does not exist as exists:false, not as an error', async () => {
      const response = await GET(getRequest('?file=.env.local'), params());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.selected).toMatchObject({ name: '.env.local', exists: false, content: '' });
    });
  });

  // --------------------------------------------------------------------------
  // Path containment (issue security requirement 1)
  // --------------------------------------------------------------------------

  describe('path containment', () => {
    it.each([
      ['relative traversal', '../outside/stolen.env'],
      ['deep relative traversal', '../../etc/passwd'],
      ['traversal through a legal prefix', '.env/../../outside/stolen.env'],
      ['absolute path', '/etc/passwd'],
      ['nested path', 'sub/.env'],
      ['lookalike name', '.envrc'],
      ['bare name', 'env'],
    ])('GET refuses %s', async (_label, file) => {
      const response = await GET(getRequest(`?file=${encodeURIComponent(file)}`), params());
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(['INVALID_ENV_FILE', 'INVALID_PATH']).toContain(data.error.code);
    });

    it('GET refuses a NUL-byte truncation attempt', async () => {
      const response = await GET(
        getRequest(`?file=${encodeURIComponent('.env\x00.png')}`),
        params(),
      );
      expect(response.status).toBe(400);
    });

    it('GET refuses an absolute path that points inside the sandbox', async () => {
      const absolute = join(outsideDir, 'stolen.env');
      const response = await GET(getRequest(`?file=${encodeURIComponent(absolute)}`), params());
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).not.toContain('OUTSIDE=1');
    });

    it('GET refuses an allow-listed name that symlinks outside the worktree', async () => {
      symlinkSync(join(outsideDir, 'stolen.env'), join(worktreeDir, '.env.local'));
      const response = await GET(getRequest('?file=.env.local'), params());
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_PATH');
      expect(JSON.stringify(data)).not.toContain('OUTSIDE=1');
    });

    it('PUT refuses to write through a symlink that escapes', async () => {
      symlinkSync(join(outsideDir, 'stolen.env'), join(worktreeDir, '.env.local'));
      const response = await PUT(
        putRequest({ file: '.env.local', content: 'PWNED=1\n' }),
        params(),
      );
      expect(response.status).toBe(400);
      expect(readFileSync(join(outsideDir, 'stolen.env'), 'utf-8')).toBe('OUTSIDE=1\n');
    });

    it.each(['../outside/stolen.env', '/tmp/pwned.env', '.envrc', 'notenv'])(
      'PUT refuses %j',
      async (file) => {
        const response = await PUT(putRequest({ file, content: 'A=1\n' }), params());
        expect(response.status).toBe(400);
        expect(existsSync(join(outsideDir, 'pwned.env'))).toBe(false);
      },
    );
  });

  // --------------------------------------------------------------------------
  // PUT
  // --------------------------------------------------------------------------

  describe('PUT', () => {
    it('creates a file that does not exist yet', async () => {
      const response = await PUT(putRequest({ file: '.env', content: 'A=1\n' }), params());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.file).toMatchObject({ name: '.env', exists: true });
      expect(readFileSync(join(worktreeDir, '.env'), 'utf-8')).toBe('A=1\n');
    });

    it('overwrites an existing file, preserving what the client sent verbatim', async () => {
      writeFileSync(join(worktreeDir, '.env'), 'OLD=1\n');
      const content = '# kept comment\nNEW="two words"\n';
      const response = await PUT(putRequest({ file: '.env', content }), params());
      expect(response.status).toBe(200);
      expect(readFileSync(join(worktreeDir, '.env'), 'utf-8')).toBe(content);
    });

    it('refuses invalid syntax and leaves the file untouched', async () => {
      writeFileSync(join(worktreeDir, '.env'), 'GOOD=1\n');
      const response = await PUT(
        putRequest({ file: '.env', content: 'GOOD=1\nthis is not an assignment\n' }),
        params(),
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_CONTENT');
      expect(data.error.issues).toContainEqual({
        line: 2,
        code: 'invalid-syntax',
        severity: 'error',
      });
      expect(readFileSync(join(worktreeDir, '.env'), 'utf-8')).toBe('GOOD=1\n');
    });

    it('refuses a dangerous control character', async () => {
      const response = await PUT(
        putRequest({ file: '.env', content: `A=${SECRET}${ESC_SEQUENCE}\n` }),
        params(),
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(
        data.error.issues.some((i: { code: string }) => i.code === 'control-character'),
      ).toBe(true);
    });

    it('never echoes a value back in an error body', async () => {
      const response = await PUT(
        putRequest({ file: '.env', content: `1BAD=${SECRET}\nalso bad\n` }),
        params(),
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).not.toContain(SECRET);
    });

    it('accepts a duplicate key and reports it as a warning', async () => {
      const response = await PUT(putRequest({ file: '.env', content: 'A=1\nA=2\n' }), params());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.issues).toEqual([
        { line: 2, code: 'duplicate-key', severity: 'warning', key: 'A' },
      ]);
    });

    it('requires a string content', async () => {
      const response = await PUT(putRequest({ file: '.env' }), params());
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('404s for an unknown worktree', async () => {
      const response = await PUT(putRequest({ file: '.env', content: 'A=1\n' }), {
        params: Promise.resolve({ id: 'nope' }),
      });
      expect(response.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Surface isolation — EXCLUDED_PATTERNS must keep working (requirement 4)
  // --------------------------------------------------------------------------

  describe('the general file tree still hides env files', () => {
    beforeEach(() => {
      writeFileSync(join(worktreeDir, '.env'), `API_KEY=${SECRET}\n`);
      writeFileSync(join(worktreeDir, '.env.local'), 'LOCAL=1\n');
      writeFileSync(join(worktreeDir, '.env.example'), 'API_KEY=\n');
      writeFileSync(join(worktreeDir, '.env.production'), 'PROD=1\n');
      writeFileSync(join(worktreeDir, 'README.md'), '# readme\n');
    });

    async function treeNames(): Promise<string[]> {
      const request = new Request(
        `http://localhost:3000/api/worktrees/${WORKTREE_ID}/tree`,
      ) as unknown as NextRequest;
      const response = await getRootTree(request, params());
      expect(response.status).toBe(200);
      const data = await response.json();
      return data.items.map((item: { name: string }) => item.name);
    }

    it('lists no env file at all', async () => {
      const names = await treeNames();
      expect(names).toContain('README.md');
      for (const hidden of ['.env', '.env.local', '.env.example', '.env.production']) {
        expect(names).not.toContain(hidden);
      }
      expect(names.filter((name) => name.startsWith('.env'))).toEqual([]);
    });

    it('the Env Manager serves exactly what the tree hides', async () => {
      const treeListed = await treeNames();
      const response = await GET(getRequest(), params());
      const data = await response.json();
      const envListed: string[] = data.files
        .filter((file: { exists: boolean }) => file.exists)
        .map((file: { name: string }) => file.name);

      expect(envListed.sort()).toEqual(
        ['.env', '.env.example', '.env.local', '.env.production'].sort(),
      );
      // The two surfaces are disjoint: that is the whole security story.
      expect(envListed.filter((name) => treeListed.includes(name))).toEqual([]);
    });

    it('a secret never appears in the tree response', async () => {
      const request = new Request(
        `http://localhost:3000/api/worktrees/${WORKTREE_ID}/tree`,
      ) as unknown as NextRequest;
      const response = await getRootTree(request, params());
      expect(await response.text()).not.toContain(SECRET);
    });
  });

  // --------------------------------------------------------------------------
  // The mask is a display control, and the tests should say so out loud.
  // --------------------------------------------------------------------------

  describe('what the API does and does not do about masking', () => {
    it('returns real values (the browser needs them to edit) and does not pre-mask', async () => {
      writeFileSync(join(worktreeDir, '.env'), `API_KEY=${SECRET}\n`);
      const response = await GET(getRequest('?file=.env'), params());
      const data = await response.json();
      // Documented on purpose: masking happens at render time
      // (`env-masking.ts`), and the transport control is authentication plus the
      // allow-list — not obfuscating the payload.
      expect(data.selected.content).toContain(SECRET);
      expect(data.selected.content).not.toContain(ENV_MASK);
    });
  });
});
