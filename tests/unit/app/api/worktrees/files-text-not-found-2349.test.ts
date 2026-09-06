/**
 * A missing TEXT file is 404 FILE_NOT_FOUND, not 500 (Issue #2349)
 *
 * GET /api/worktrees/:id/files/:path has four branches — download, image,
 * video/PDF, and text. The first three each catch ENOENT and answer 404
 * `FILE_NOT_FOUND`; the text branch's entry `stat` sat outside every `try`, so
 * a missing `.md` / `.txt` fell through to the outer catch and became 500
 * `INTERNAL_ERROR` ("Failed to read file"). Measured on the running server
 * 2026-09-06: `no/such/file-xyz.png` → 404, `no/such/file-xyz.md` → 500.
 *
 * The route runs against a REAL temp worktree here — real `stat`, real path
 * validation — so the 200 / 304 pins below exercise the same `fileStat` the
 * fix had to keep in scope. Only ONE test overrides `stat`, to inject EACCES:
 * that is the positive control proving the fix maps ENOENT and nothing else.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));

const { loggerError, statControl } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  /**
   * `override` replaces `fs/promises.stat` for the duration of one test. `null`
   * (the default, restored in `afterEach`) means the real `stat` runs.
   */
  statControl: {
    override: null as ((...args: unknown[]) => Promise<unknown>) | null,
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

// Real filesystem, with `stat` routed through a switch so the EACCES test can
// make it fail without touching file modes (which root, e.g. in CI, ignores).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const stat = ((...args: unknown[]) =>
    statControl.override
      ? statControl.override(...args)
      : (actual.stat as (...a: unknown[]) => Promise<unknown>)(...args)) as typeof actual.stat;
  return { ...actual, stat };
});

import { GET, HEAD } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { getWorktreeById } from '@/lib/db';

// ============================================================================
// Helpers
// ============================================================================

const WORKTREE_ID = 'wt-2349';
const README_CONTENT = 'hello\n日本語の行\n';
const NOTES_CONTENT = 'plain text notes\n';

let worktreeDir: string;

function request(pathInWorktree: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    new URL(`/api/worktrees/${WORKTREE_ID}/files/${pathInWorktree}`, 'http://localhost:3000'),
    headers ? { headers } : undefined,
  );
}

function params(...segments: string[]) {
  return { params: Promise.resolve({ id: WORKTREE_ID, path: segments }) };
}

/** Split `a/b/c.md` into the `[...path]` segments Next hands the route. */
function segmentsOf(pathInWorktree: string): string[] {
  return pathInWorktree.split('/');
}

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/worktrees/:id/files/:path — missing text file (Issue #2349)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktreeDir = makeTempDir('cm-files-2349-');
    mkdirSync(join(worktreeDir, 'docs'), { recursive: true });
    writeFileSync(join(worktreeDir, 'docs', 'readme.md'), README_CONTENT, 'utf-8');
    writeFileSync(join(worktreeDir, 'notes.txt'), NOTES_CONTENT, 'utf-8');
    // `Last-Modified` is an HTTP-date (whole seconds). Pin the mtime to a whole
    // second so `If-Modified-Since: <that header>` compares equal to the real
    // stat, the way the 304 branch expects; a sub-second mtime would be "newer".
    const wholeSecond = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000);
    utimesSync(join(worktreeDir, 'docs', 'readme.md'), wholeSecond, wholeSecond);
    vi.mocked(getWorktreeById).mockReturnValue({
      id: WORKTREE_ID,
      path: worktreeDir,
    } as unknown as ReturnType<typeof getWorktreeById>);
  });

  afterEach(() => {
    statControl.override = null;
    removeTempDir(worktreeDir);
  });

  // ------------------------------------------------------------------------
  // The defect: text branch answered 500 where the other three answer 404
  // ------------------------------------------------------------------------

  describe('a missing text file is 404 FILE_NOT_FOUND', () => {
    it.each([
      // The Issue's own measured shapes.
      'no/such/file-xyz.md',
      'no/such/file-xyz.txt',
      // Missing file in an existing directory (no ENOENT on a parent segment).
      'docs/missing.md',
      // What a worktree-OUTSIDE absolute path becomes after Next's 308 collapses
      // `files//Users/…` into `files/Users/…` (#2345 acceptance criterion 3).
      'Users/nobody/elsewhere/notes.md',
    ])('%s → 404 FILE_NOT_FOUND', async (missing) => {
      const response = await GET(request(missing), params(...segmentsOf(missing)));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
      });
    });

    it('does not reach the outer catch (nothing is logged as an error)', async () => {
      const response = await GET(request('no/such/file-xyz.md'), params('no', 'such', 'file-xyz.md'));

      expect(response.status).toBe(404);
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('line-range mode (?startLine&endLine) on a missing file is 404 too', async () => {
      // The entry `stat` runs BEFORE the line-range dispatch, so it used to be
      // 500 for this shape as well — even though readFileLineRange itself can
      // answer FILE_NOT_FOUND.
      const response = await GET(
        request('no/such/file-xyz.md?startLine=1&endLine=10'),
        params('no', 'such', 'file-xyz.md'),
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------------
  // Positive control: ONLY ENOENT is mapped; everything else still surfaces
  // ------------------------------------------------------------------------

  describe('non-ENOENT failures of the entry stat are still 500', () => {
    it('EACCES → 500 INTERNAL_ERROR via the outer catch, and is logged', async () => {
      statControl.override = async () => {
        throw errnoError('EACCES', 'EACCES: permission denied');
      };

      const response = await GET(request('docs/readme.md'), params('docs', 'readme.md'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to read file' },
      });
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        'error-reading-file:',
        expect.objectContaining({ error: 'EACCES: permission denied' }),
      );
    });

    it('a stat failure without an errno code → 500 as well', async () => {
      statControl.override = async () => {
        throw new Error('disk on fire');
      };

      const response = await GET(request('notes.txt'), params('notes.txt'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ------------------------------------------------------------------------
  // Regression: the other three branches' 404s are unchanged
  // ------------------------------------------------------------------------

  describe('the other GET branches still answer 404 for a missing file', () => {
    it.each([
      ['image', 'no/such/file-xyz.png'],
      ['video', 'no/such/file-xyz.mp4'],
      ['PDF', 'no/such/file-xyz.pdf'],
    ])('%s branch: %s → 404 FILE_NOT_FOUND', async (_branch, missing) => {
      const response = await GET(request(missing), params(...segmentsOf(missing)));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('FILE_NOT_FOUND');
    });

    it('download branch: no/such/file-xyz.md?download=1 → 404 FILE_NOT_FOUND', async () => {
      const response = await GET(
        request('no/such/file-xyz.md?download=1'),
        params('no', 'such', 'file-xyz.md'),
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------------
  // Regression: an existing text file's 200 / 304 contract is unchanged
  // ------------------------------------------------------------------------

  describe('an existing text file is served exactly as before', () => {
    it('200 with content, totalBytes, Last-Modified and Cache-Control', async () => {
      const response = await GET(request('docs/readme.md'), params('docs', 'readme.md'));

      expect(response.status).toBe(200);
      const expectedMtime = statSync(join(worktreeDir, 'docs', 'readme.md')).mtime;
      expect(response.headers.get('Last-Modified')).toBe(expectedMtime.toUTCString());
      expect(response.headers.get('Cache-Control')).toBe('no-store, private');

      const body = await response.json();
      expect(body).toEqual({
        success: true,
        path: 'docs/readme.md',
        content: README_CONTENT,
        extension: 'md',
        worktreePath: worktreeDir,
        totalBytes: Buffer.byteLength(README_CONTENT, 'utf-8'),
      });
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('a non-editable .txt is served with its content', async () => {
      const response = await GET(request('notes.txt'), params('notes.txt'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content).toBe(NOTES_CONTENT);
      expect(body.totalBytes).toBe(Buffer.byteLength(NOTES_CONTENT, 'utf-8'));
      expect(body.extension).toBe('txt');
    });

    it('304 when If-Modified-Since matches Last-Modified (Issue #469)', async () => {
      const lastModified = statSync(join(worktreeDir, 'docs', 'readme.md')).mtime.toUTCString();

      const response = await GET(
        request('docs/readme.md', { 'If-Modified-Since': lastModified }),
        params('docs', 'readme.md'),
      );

      expect(response.status).toBe(304);
      expect(response.headers.get('Last-Modified')).toBe(lastModified);
      expect(response.headers.get('Cache-Control')).toBe('no-store, private');
      expect(await response.text()).toBe('');
    });

    it('200 (full body) when If-Modified-Since is older than the file', async () => {
      const mtime = statSync(join(worktreeDir, 'docs', 'readme.md')).mtime;
      const stale = new Date(mtime.getTime() - 60_000).toUTCString();

      const response = await GET(
        request('docs/readme.md', { 'If-Modified-Since': stale }),
        params('docs', 'readme.md'),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content).toBe(README_CONTENT);
    });

    it('line-range mode on an existing file still returns the partial payload', async () => {
      const response = await GET(
        request('docs/readme.md?startLine=2&endLine=2'),
        params('docs', 'readme.md'),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content).toBe('日本語の行');
      expect(body.range).toEqual({ start: 2, end: 2 });
      expect(body.totalLines).toBe(2);
    });
  });

  // ------------------------------------------------------------------------
  // HEAD (the chat surface's existence probe) already had this handling; pin it
  // ------------------------------------------------------------------------

  describe('HEAD keeps answering the same question', () => {
    it('HEAD of a missing text file is 404', async () => {
      const response = await HEAD(request('no/such/file-xyz.md'), params('no', 'such', 'file-xyz.md'));

      expect(response.status).toBe(404);
    });

    it('HEAD of an existing text file is 200', async () => {
      const response = await HEAD(request('docs/readme.md'), params('docs', 'readme.md'));

      expect(response.status).toBe(200);
    });
  });
});
