/**
 * `.txt` is editable through the file API (Issue #2506)
 *
 * `EDITABLE_EXTENSIONS` is the write allow-list that `PUT
 * /api/worktrees/:id/files/:path` consults through `isEditableFile()`. Before
 * this Issue a `.txt` file could be read but never saved: the PC file panel
 * showed it in the read-only code viewer and PUT answered 403 `NOT_EDITABLE`.
 *
 * Adding one string to that array changes three behaviours at once, and this
 * file pins all three at the route boundary:
 *
 *   1. PUT accepts `.txt` and actually writes the bytes;
 *   2. GET starts applying the 2MB text ceiling to `.txt` — which, after Issue
 *      #2505, means "opens read-only", NOT "refuses to open";
 *   3. nothing that was refused before becomes reachable — `.env.txt` is still
 *      denied, NULL bytes are still rejected, and `.txt` gains no exemption
 *      from path validation.
 *
 * The route runs against a REAL temp worktree — real `stat`, real reads and
 * real writes — so the assertions below are about bytes that actually landed
 * on disk, not about a mocked filesystem agreeing with itself.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { TEXT_MAX_SIZE_BYTES } from '@/config/editable-extensions';

// ============================================================================
// Mocks — only the DB lookup and the logger; the filesystem is real.
// ============================================================================

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

import { GET, PUT, POST } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { getWorktreeById } from '@/lib/db';

// ============================================================================
// Helpers
// ============================================================================

const WORKTREE_ID = 'wt-2506';

let worktreeDir: string;

function request(pathWithQuery: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(`/api/worktrees/${WORKTREE_ID}/files/${pathWithQuery}`, 'http://localhost:3000'),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

function jsonRequest(method: string, pathInWorktree: string, body: unknown): NextRequest {
  return request(pathInWorktree, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(...segments: string[]) {
  return { params: Promise.resolve({ id: WORKTREE_ID, path: segments }) };
}

/** Write a file of EXACTLY `bytes` bytes (ASCII, so one char is one byte). */
function writeSized(name: string, bytes: number): string {
  const body = 'x'.repeat(bytes);
  writeFileSync(join(worktreeDir, name), body, 'utf-8');
  return body;
}

const OVER_TEXT = TEXT_MAX_SIZE_BYTES + 1;

// ============================================================================
// Tests
// ============================================================================

describe('.txt through the worktree file API (Issue #2506)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktreeDir = makeTempDir('cm-files-2506-');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: WORKTREE_ID,
      path: worktreeDir,
    } as unknown as ReturnType<typeof getWorktreeById>);
  });

  afterEach(() => {
    removeTempDir(worktreeDir);
  });

  // ------------------------------------------------------------------------
  // 1. The feature: saving a .txt
  // ------------------------------------------------------------------------

  describe('PUT writes .txt instead of refusing it', () => {
    it('saves edited content and the new bytes are on disk', async () => {
      writeFileSync(join(worktreeDir, 'notes.txt'), 'before\n', 'utf-8');

      const response = await PUT(
        jsonRequest('PUT', 'notes.txt', { content: 'after\nsecond line\n' }),
        params('notes.txt'),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).success).toBe(true);
      // The assertion that matters: the file, not the response envelope.
      expect(readFileSync(join(worktreeDir, 'notes.txt'), 'utf-8')).toBe('after\nsecond line\n');
    });

    it('accepts an uppercase .TXT name', async () => {
      writeFileSync(join(worktreeDir, 'NOTES.TXT'), 'before\n', 'utf-8');

      const response = await PUT(
        jsonRequest('PUT', 'NOTES.TXT', { content: 'after\n' }),
        params('NOTES.TXT'),
      );

      expect(response.status).toBe(200);
      expect(readFileSync(join(worktreeDir, 'NOTES.TXT'), 'utf-8')).toBe('after\n');
    });

    it('saves a .txt nested under a subdirectory', async () => {
      const createDir = await POST(
        jsonRequest('POST', 'docs', { type: 'directory' }),
        params('docs'),
      );
      expect(createDir.status).toBe(201);

      const create = await POST(
        jsonRequest('POST', 'docs/memo.txt', { type: 'file', content: 'seed\n' }),
        params('docs', 'memo.txt'),
      );
      expect(create.status).toBe(201);

      const response = await PUT(
        jsonRequest('PUT', 'docs/memo.txt', { content: 'edited\n' }),
        params('docs', 'memo.txt'),
      );

      expect(response.status).toBe(200);
      expect(readFileSync(join(worktreeDir, 'docs', 'memo.txt'), 'utf-8')).toBe('edited\n');
    });

    it('POST creates a new .txt and now validates its body', async () => {
      // The POST branch only runs `validateContent` for editable extensions, so
      // `.txt` joining the list is what turns this from "written unchecked" into
      // "written after the shared NULL-byte / size checks".
      const created = await POST(
        jsonRequest('POST', 'fresh.txt', { type: 'file', content: 'hello\n' }),
        params('fresh.txt'),
      );
      expect(created.status).toBe(201);
      expect(readFileSync(join(worktreeDir, 'fresh.txt'), 'utf-8')).toBe('hello\n');

      const rejected = await POST(
        jsonRequest('POST', 'binary.txt', { type: 'file', content: 'hello\x00world' }),
        params('binary.txt'),
      );
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.code).toBe('INVALID_CONTENT');
      expect(existsSync(join(worktreeDir, 'binary.txt'))).toBe(false);
    });
  });

  // ------------------------------------------------------------------------
  // 2. The regression this Issue had to avoid: large .txt must stay readable
  // ------------------------------------------------------------------------

  describe('the 2MB text ceiling now applies to .txt — read-only, never unreadable', () => {
    it('a 3MB .txt is 200 with the full body and readOnly: true', async () => {
      const body = writeSized('huge.txt', 3 * 1024 * 1024);

      const response = await GET(request('huge.txt'), params('huge.txt'));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBe(body);
      expect(data.readOnly).toBe(true);
      expect(data.readOnlyReason).toMatchObject({
        code: 'FILE_TOO_LARGE',
        limitBytes: TEXT_MAX_SIZE_BYTES,
        sizeBytes: 3 * 1024 * 1024,
      });
    });

    it('never answers 413 for an oversize .txt', async () => {
      // The whole point of ordering this Issue behind #2505: before that change
      // this exact request was 413 FILE_TOO_LARGE with no body, i.e. adding
      // `.txt` to the list would have TAKEN AWAY the ability to open large
      // `.txt` files that users had all along.
      writeSized('huge.txt', OVER_TEXT);

      const response = await GET(request('huge.txt'), params('huge.txt'));

      expect(response.status).not.toBe(413);
      expect(response.status).toBe(200);
    });

    it('a line-range slice of an oversize .txt reports the same read-only state', async () => {
      // The virtualized viewer fetches further chunks through this mode while
      // scrolling; a slice that dropped the flag would resurrect the editor UI
      // mid-scroll for a file PUT still refuses.
      const LINE_WIDTH = 500;
      const lineCount = Math.ceil(OVER_TEXT / (LINE_WIDTH + 1)) + 1;
      const huge = new Array<string>(lineCount).fill('x'.repeat(LINE_WIDTH)).join('\n');
      expect(huge.length).toBeGreaterThan(OVER_TEXT);
      writeFileSync(join(worktreeDir, 'huge.txt'), huge, 'utf-8');

      const response = await GET(
        request('huge.txt?startLine=1&endLine=3'),
        params('huge.txt'),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.range).toEqual({ start: 1, end: 3 });
      expect(data.readOnly).toBe(true);
    });

    it('a .txt at exactly 2MB is not flagged', async () => {
      writeSized('exact.txt', TEXT_MAX_SIZE_BYTES);

      const response = await GET(request('exact.txt'), params('exact.txt'));

      expect(response.status).toBe(200);
      expect((await response.json()).readOnly).toBeUndefined();
    });

    it('a small .txt carries no readOnly key at all', async () => {
      writeSized('small.txt', 16);

      const data = await (await GET(request('small.txt'), params('small.txt'))).json();

      expect(Object.keys(data)).not.toContain('readOnly');
      expect(Object.keys(data)).not.toContain('readOnlyReason');
    });

    it('PUT still refuses oversize .txt content, so read-only is not merely advisory', async () => {
      const body = writeSized('huge.txt', OVER_TEXT);

      const getData = await (await GET(request('huge.txt'), params('huge.txt'))).json();
      expect(getData.readOnly).toBe(true);

      const putResponse = await PUT(
        jsonRequest('PUT', 'huge.txt', { content: getData.content }),
        params('huge.txt'),
      );

      expect(putResponse.status).toBe(400);
      expect((await putResponse.json()).error.code).toBe('INVALID_CONTENT');
      // And the file was not truncated or partially rewritten on the way out.
      expect(readFileSync(join(worktreeDir, 'huge.txt'), 'utf-8')).toBe(body);
    });
  });

  // ------------------------------------------------------------------------
  // 3. Nothing new is exposed
  // ------------------------------------------------------------------------

  describe('widening the allow-list exposes nothing new', () => {
    it('.env.txt is still refused — the sensitive-path guard runs before editability', async () => {
      // [Issue #2014] `.env.*` is a deny-tier pattern checked on every method,
      // so a secret file cannot be reached by giving it an editable suffix.
      const secret = 'API_KEY=super-secret\n';
      writeFileSync(join(worktreeDir, '.env.txt'), secret, 'utf-8');

      const getResponse = await GET(request('.env.txt'), params('.env.txt'));
      const putResponse = await PUT(
        jsonRequest('PUT', '.env.txt', { content: 'API_KEY=pwned\n' }),
        params('.env.txt'),
      );

      expect(getResponse.status).toBe(403);
      expect(putResponse.status).toBe(403);
      // The bytes are untouched and never left the server.
      expect(readFileSync(join(worktreeDir, '.env.txt'), 'utf-8')).toBe(secret);
      expect(JSON.stringify(await getResponse.json())).not.toContain('super-secret');
    });

    it('PUT of .txt with NULL bytes is rejected and the file is untouched', async () => {
      writeFileSync(join(worktreeDir, 'notes.txt'), 'before\n', 'utf-8');

      const response = await PUT(
        jsonRequest('PUT', 'notes.txt', { content: 'hello\x00world' }),
        params('notes.txt'),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_CONTENT');
      expect(readFileSync(join(worktreeDir, 'notes.txt'), 'utf-8')).toBe('before\n');
    });

    it('a .txt path escaping the worktree is still INVALID_PATH', async () => {
      const response = await PUT(
        jsonRequest('PUT', '../escaped.txt', { content: 'nope' }),
        params('..', 'escaped.txt'),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_PATH');
    });

    it('extensions outside the list are still 403 NOT_EDITABLE', async () => {
      // `.text` and `.log` are the near-misses: the list gained exactly one
      // member, not a family of text-ish suffixes.
      writeFileSync(join(worktreeDir, 'notes.text'), 'a', 'utf-8');
      writeFileSync(join(worktreeDir, 'server.log'), 'a', 'utf-8');

      for (const name of ['notes.text', 'server.log']) {
        const response = await PUT(jsonRequest('PUT', name, { content: 'b' }), params(name));
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('NOT_EDITABLE');
      }
    });
  });
});
