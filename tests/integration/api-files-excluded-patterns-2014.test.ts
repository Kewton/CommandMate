/**
 * files API × EXCLUDED_PATTERNS — Issue #2014
 *
 * `EXCLUDED_PATTERNS` hid `.env` from the tree but never stopped anyone from
 * asking for it by path. Measured on develop @6696c4bb before this change:
 *
 *   GET    /files/.env                       -> 200 {"content":"SECRET=probe-value\n"}
 *   GET    /files/.env?download=1            -> 200 raw bytes
 *   GET    /files/server.pem | .git/config   -> 200 body
 *   PUT    /files/.env.yml                   -> 200 (overwrote a secret file)
 *   POST   /files/.env                       -> 201
 *   DELETE /files/.env                       -> 200 (file gone)
 *   PATCH  /files/.env {rename:'leaked.md'}  -> 200, then GET /files/leaked.md -> 200 body
 *
 * The last line is why the guard is not GET-only. Every method of the route is
 * covered here, plus the two invariants that keep the fix honest:
 *
 *   - the hide-only tier (`node_modules`, `.DS_Store`, `Thumbs.db`) reads
 *     exactly as it did before — those are excluded for volume, not secrecy;
 *   - files that are in no pattern at all read/write exactly as before.
 *
 * The tier assignment itself is argued in
 * `src/lib/security/sensitive-file-guard.ts` and pinned in
 * `tests/unit/lib/security/sensitive-file-guard.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  GET,
  PUT,
  POST,
  DELETE,
  PATCH,
} from '@/app/api/worktrees/[id]/files/[...path]/route';
import { POST as UPLOAD } from '@/app/api/worktrees/[id]/upload/[...path]/route';
import { GET as envGET } from '@/app/api/worktrees/[id]/env/route';

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

const WORKTREE_ID = 'files-2014-worktree';
const SECRET = 'probe-value-do-not-leak';

describe('files API refuses deny-tier paths (Issue #2014)', () => {
  let db: Database.Database;
  let worktreeDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    worktreeDir = makeTempDir('api-files-2014-');

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'files-2014',
      path: worktreeDir,
      repositoryPath: worktreeDir,
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);

    // Deny tier
    writeFileSync(join(worktreeDir, '.env'), `SECRET=${SECRET}\n`);
    writeFileSync(join(worktreeDir, '.env.local'), `LOCAL=${SECRET}\n`);
    writeFileSync(join(worktreeDir, '.env.production'), `PROD=${SECRET}\n`);
    writeFileSync(join(worktreeDir, '.env.yml'), `secret: ${SECRET}\n`);
    writeFileSync(join(worktreeDir, 'server.pem'), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
    writeFileSync(join(worktreeDir, 'private.key'), `${SECRET}\n`);
    mkdirSync(join(worktreeDir, '.git'), { recursive: true });
    writeFileSync(
      join(worktreeDir, '.git', 'config'),
      `[remote "origin"]\n\turl = https://user:${SECRET}@github.com/x/y.git\n`,
    );

    // Hide-only tier
    mkdirSync(join(worktreeDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(worktreeDir, 'node_modules', 'pkg', 'package.json'), '{"name":"pkg"}');
    writeFileSync(join(worktreeDir, 'node_modules', 'pkg', 'notes.md'), '# dep notes\n');
    writeFileSync(join(worktreeDir, '.DS_Store'), 'finder-metadata');
    writeFileSync(join(worktreeDir, 'Thumbs.db'), 'thumbnail-cache');

    // In no pattern at all
    writeFileSync(join(worktreeDir, 'README.md'), '# readme\nline two\nline three\n');
    mkdirSync(join(worktreeDir, 'docs'), { recursive: true });
    writeFileSync(join(worktreeDir, 'docs', 'guide.md'), '# guide\n');
    writeFileSync(join(worktreeDir, 'envelope.md'), '# not an env file\n');
    writeFileSync(join(worktreeDir, 'keyboard.ts'), 'export const a = 1;\n');
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    removeTempDir(worktreeDir);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const fileParams = (segments: string[]) => ({
    params: Promise.resolve({ id: WORKTREE_ID, path: segments }),
  });

  function fileRequest(
    method: string,
    segments: string[],
    body?: object,
    query = '',
  ): NextRequest {
    const url = `http://localhost:3000/api/worktrees/${WORKTREE_ID}/files/${segments.join('/')}${query}`;
    return new NextRequest(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** Assert a refusal that neither serves nor names the secret. */
  async function expectRefused(response: Response): Promise<void> {
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).error.code).toBe('SENSITIVE_PATH');
  }

  // ---------------------------------------------------------------------------
  // GET — the reported hole
  // ---------------------------------------------------------------------------

  describe('GET: files whose purpose is to hold credentials are not served', () => {
    it.each([
      [['.env'], 'the exact case from the issue report'],
      [['.env.local'], 'a .env.* variant'],
      [['.env.production'], 'a .env.* variant'],
      [['server.pem'], 'private key material (*.pem)'],
      [['private.key'], 'private key material (*.key)'],
      [['.git', 'config'], 'the remote URL routinely embeds a token'],
    ])('GET /files/%s is refused (%s)', async (segments) => {
      await expectRefused(await GET(fileRequest('GET', segments), fileParams(segments)));
    });

    it('the ?download=1 attachment branch is refused too — it is a second read surface', async () => {
      const segments = ['.env'];
      const response = await GET(
        fileRequest('GET', segments, undefined, '?download=1'),
        fileParams(segments),
      );
      await expectRefused(response);
    });

    it('the line-range branch (?startLine/?endLine) is refused too', async () => {
      const segments = ['.env'];
      const response = await GET(
        fileRequest('GET', segments, undefined, '?startLine=1&endLine=1'),
        fileParams(segments),
      );
      await expectRefused(response);
    });

    it('.ENV is refused, because a case-insensitive filesystem would open .env', async () => {
      const segments = ['.ENV'];
      await expectRefused(await GET(fileRequest('GET', segments), fileParams(segments)));
    });

    it('a traversal that normalises onto .env is refused', async () => {
      const segments = ['docs', '..', '.env'];
      await expectRefused(await GET(fileRequest('GET', segments), fileParams(segments)));
    });

    it('any path under a deny-tier directory is refused, not just its own name', async () => {
      const segments = ['.git', 'hooks', 'pre-commit'];
      await expectRefused(await GET(fileRequest('GET', segments), fileParams(segments)));
    });
  });

  // ---------------------------------------------------------------------------
  // Write methods — a read-only guard would have been bypassable
  // ---------------------------------------------------------------------------

  describe('PUT/POST/DELETE/PATCH: the same paths cannot be written, created, deleted or renamed', () => {
    it('PUT .env.yml is refused — an editable extension on a .env.* secret file', async () => {
      const segments = ['.env.yml'];
      await expectRefused(
        await PUT(fileRequest('PUT', segments, { content: 'pwned: 1\n' }), fileParams(segments)),
      );
      expect(readFileSync(join(worktreeDir, '.env.yml'), 'utf-8')).toContain(SECRET);
    });

    it('POST .env is refused, and creates nothing', async () => {
      const segments = ['.env.new'];
      await expectRefused(
        await POST(
          fileRequest('POST', segments, { type: 'file', content: 'INJECTED=1' }),
          fileParams(segments),
        ),
      );
      expect(existsSync(join(worktreeDir, '.env.new'))).toBe(false);
    });

    it('DELETE .env is refused, and the file survives', async () => {
      const segments = ['.env'];
      await expectRefused(await DELETE(fileRequest('DELETE', segments), fileParams(segments)));
      expect(existsSync(join(worktreeDir, '.env'))).toBe(true);
    });

    it('PATCH rename .env -> leaked.md is refused, closing the two-request read bypass', async () => {
      const segments = ['.env'];
      await expectRefused(
        await PATCH(
          fileRequest('PATCH', segments, { action: 'rename', newName: 'leaked.md' }),
          fileParams(segments),
        ),
      );
      expect(existsSync(join(worktreeDir, '.env'))).toBe(true);
      expect(existsSync(join(worktreeDir, 'leaked.md'))).toBe(false);

      // The follow-up read finds nothing. (A missing file surfaces as 500 here,
      // not 404 — a pre-existing quirk of the GET `stat()` call, unrelated to
      // this issue, so it is asserted as "not served" rather than pinned.)
      const leaked = await GET(fileRequest('GET', ['leaked.md']), fileParams(['leaked.md']));
      expect(leaked.status).not.toBe(200);
      expect(await leaked.text()).not.toContain(SECRET);
    });

    it('PATCH rename README.md -> .env is refused: the API must not create a path it then cannot manage', async () => {
      const segments = ['README.md'];
      await expectRefused(
        await PATCH(
          fileRequest('PATCH', segments, { action: 'rename', newName: '.env.injected' }),
          fileParams(segments),
        ),
      );
      expect(existsSync(join(worktreeDir, 'README.md'))).toBe(true);
    });

    it('PATCH move into a deny-tier directory is refused', async () => {
      const segments = ['README.md'];
      await expectRefused(
        await PATCH(
          fileRequest('PATCH', segments, { action: 'move', destination: '.git' }),
          fileParams(segments),
        ),
      );
      expect(existsSync(join(worktreeDir, 'README.md'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Hide-only tier — reads must NOT change
  // ---------------------------------------------------------------------------

  describe('hide-only tier keeps its current read behaviour (excluded for volume, not secrecy)', () => {
    it('GET node_modules/pkg/package.json still returns 200 with content', async () => {
      const segments = ['node_modules', 'pkg', 'package.json'];
      const response = await GET(fileRequest('GET', segments), fileParams(segments));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBe('{"name":"pkg"}');
    });

    it('GET .DS_Store and Thumbs.db still return 200', async () => {
      for (const name of ['.DS_Store', 'Thumbs.db']) {
        const response = await GET(fileRequest('GET', [name]), fileParams([name]));
        expect(response.status).toBe(200);
      }
    });

    it('PUT inside node_modules still succeeds for an editable extension', async () => {
      const segments = ['node_modules', 'pkg', 'notes.md'];
      const response = await PUT(
        fileRequest('PUT', segments, { content: '# edited\n' }),
        fileParams(segments),
      );
      expect(response.status).toBe(200);
      expect(readFileSync(join(worktreeDir, 'node_modules', 'pkg', 'notes.md'), 'utf-8')).toBe(
        '# edited\n',
      );
    });

    it('DELETE node_modules is still refused by the pre-existing PROTECTED_DIRECTORY rule, not by this guard', async () => {
      const segments = ['node_modules'];
      const response = await DELETE(fileRequest('DELETE', segments), fileParams(segments));
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe('PROTECTED_DIRECTORY');
    });
  });

  // ---------------------------------------------------------------------------
  // Files in no pattern — behaviour unchanged
  // ---------------------------------------------------------------------------

  describe('files matched by no pattern read and write exactly as before', () => {
    it('GET README.md returns its content', async () => {
      const response = await GET(fileRequest('GET', ['README.md']), fileParams(['README.md']));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toContain('# readme');
    });

    it('GET a line range still returns a partial payload', async () => {
      const response = await GET(
        fileRequest('GET', ['README.md'], undefined, '?startLine=1&endLine=2'),
        fileParams(['README.md']),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toContain('# readme');
      expect(data.range).toBeDefined();
    });

    it('GET ?download=1 still returns raw bytes as an attachment', async () => {
      const response = await GET(
        fileRequest('GET', ['README.md'], undefined, '?download=1'),
        fileParams(['README.md']),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(await response.text()).toContain('# readme');
    });

    it('names that merely look like a pattern are untouched (envelope.md, keyboard.ts)', async () => {
      for (const name of ['envelope.md', 'keyboard.ts']) {
        const response = await GET(fileRequest('GET', [name]), fileParams([name]));
        expect(response.status).toBe(200);
      }
    });

    it('PUT / POST / PATCH / DELETE still work on an ordinary file', async () => {
      const put = await PUT(
        fileRequest('PUT', ['docs', 'guide.md'], { content: '# edited guide\n' }),
        fileParams(['docs', 'guide.md']),
      );
      expect(put.status).toBe(200);

      const post = await POST(
        fileRequest('POST', ['docs', 'created.md'], { type: 'file', content: '# new\n' }),
        fileParams(['docs', 'created.md']),
      );
      expect(post.status).toBe(201);

      const patch = await PATCH(
        fileRequest('PATCH', ['docs', 'created.md'], { action: 'rename', newName: 'renamed.md' }),
        fileParams(['docs', 'created.md']),
      );
      expect(patch.status).toBe(200);

      const del = await DELETE(
        fileRequest('DELETE', ['docs', 'renamed.md']),
        fileParams(['docs', 'renamed.md']),
      );
      expect(del.status).toBe(200);
      expect(existsSync(join(worktreeDir, 'docs', 'renamed.md'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Upload route — the write-side twin of the same hole
  // ---------------------------------------------------------------------------

  describe('upload route: the extension allow-list alone let .env.yml through', () => {
    function uploadRequest(dirSegments: string[], filename: string, content: string): NextRequest {
      const form = new FormData();
      form.append('file', new File([content], filename, { type: 'text/yaml' }));
      return new NextRequest(
        `http://localhost:3000/api/worktrees/${WORKTREE_ID}/upload/${dirSegments.join('/')}`,
        { method: 'POST', body: form },
      );
    }

    it('uploading .env.yml is refused even though .yml is an allowed extension', async () => {
      const response = await UPLOAD(
        uploadRequest(['docs'], '.env.yml', 'pwned: 1\n'),
        fileParams(['docs']),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('SENSITIVE_PATH');
      expect(existsSync(join(worktreeDir, 'docs', '.env.yml'))).toBe(false);
    });

    it('uploading into a deny-tier directory is refused', async () => {
      const response = await UPLOAD(
        uploadRequest(['.git'], 'ok.yml', 'a: 1\n'),
        fileParams(['.git']),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('SENSITIVE_PATH');
    });

    it('an ordinary upload still succeeds', async () => {
      const response = await UPLOAD(
        uploadRequest(['docs'], 'ok.yml', 'a: 1\n'),
        fileParams(['docs']),
      );
      expect(response.status).toBe(201);
      expect(existsSync(join(worktreeDir, 'docs', 'ok.yml'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #1968 — the Env Manager is a different door and stays open
  // ---------------------------------------------------------------------------

  describe('Env Manager (#1968) is unaffected: its own allow-list and 3-layer path check', () => {
    it('serves .env while the general files route refuses the same file', async () => {
      const refused = await GET(fileRequest('GET', ['.env']), fileParams(['.env']));
      expect(refused.status).toBe(403);

      const envResponse = await envGET(
        new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/env?file=.env`),
        { params: Promise.resolve({ id: WORKTREE_ID }) },
      );
      expect(envResponse.status).toBe(200);
      const data = await envResponse.json();
      expect(data.selected.name).toBe('.env');
      expect(data.selected.content).toContain(SECRET);
    });

    it('still lists the env files the tree hides', async () => {
      const envResponse = await envGET(
        new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/env`),
        { params: Promise.resolve({ id: WORKTREE_ID }) },
      );
      expect(envResponse.status).toBe(200);
      const names = (await envResponse.json()).files.map((f: { name: string }) => f.name);
      expect(names).toContain('.env');
      expect(names).toContain('.env.local');
    });
  });
});
