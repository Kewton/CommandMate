/**
 * An oversize editable file opens READ-ONLY instead of 413 (Issue #2505)
 *
 * `GET /api/worktrees/:id/files/:path` used to answer 413 `FILE_TOO_LARGE`
 * whenever an EDITABLE extension was over its ceiling — 5MB for `.html` /
 * `.htm` (Issue #490), 2MB for everything else editable (Issue #723). One size
 * number was doing two unrelated jobs: "too big to hand to a textarea editor"
 * and "too big to look at". Only the first is true, and the second made a 3MB
 * `.md` unopenable.
 *
 * The trap this closes is that the guard keys off `isEditableExtension()`, so
 * ADDING an extension to that list silently removed the ability to READ large
 * files with it. Issue #2506 did exactly that for `.txt`; the `.txt`-shaped
 * assertions below were pinned here in advance and have since been flipped to
 * the post-#2506 contract (a 3MB `.txt` reads in full and is flagged read-only).
 *
 * The new contract:
 *   - GET returns 200 with the full body, plus `readOnly: true` and a structured
 *     `readOnlyReason`;
 *   - PUT is UNCHANGED and still refuses to write oversize content.
 *
 * The route runs against a REAL temp worktree — real `stat`, real reads — so the
 * byte counts asserted below are the ones the route actually measured.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { TEXT_MAX_SIZE_BYTES } from '@/config/editable-extensions';
import { HTML_MAX_SIZE_BYTES } from '@/config/html-extensions';

// ============================================================================
// Mocks — only the DB lookup and the logger; the filesystem is real.
// ============================================================================

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

import { GET, PUT } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { getWorktreeById } from '@/lib/db';

// ============================================================================
// Helpers
// ============================================================================

const WORKTREE_ID = 'wt-2505';

let worktreeDir: string;

function request(pathWithQuery: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(`/api/worktrees/${WORKTREE_ID}/files/${pathWithQuery}`, 'http://localhost:3000'),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

function putRequest(pathInWorktree: string, content: string): NextRequest {
  return request(pathInWorktree, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

function params(...segments: string[]) {
  return { params: Promise.resolve({ id: WORKTREE_ID, path: segments }) };
}

/**
 * Write a file of EXACTLY `bytes` bytes. ASCII only, so one char is one byte and
 * `content.length` (what PUT's `validateContent` measures) equals the on-disk
 * size (what GET's `stat` measures).
 */
function writeSized(name: string, bytes: number): string {
  const body = 'x'.repeat(bytes);
  writeFileSync(join(worktreeDir, name), body, 'utf-8');
  return body;
}

const OVER_TEXT = TEXT_MAX_SIZE_BYTES + 1;
const OVER_HTML = HTML_MAX_SIZE_BYTES + 1;

// ============================================================================
// Tests
// ============================================================================

describe('GET oversize editable files — read-only instead of 413 (Issue #2505)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktreeDir = makeTempDir('cm-files-2505-');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: WORKTREE_ID,
      path: worktreeDir,
    } as unknown as ReturnType<typeof getWorktreeById>);
  });

  afterEach(() => {
    removeTempDir(worktreeDir);
  });

  // ------------------------------------------------------------------------
  // The defect: these four shapes were all 413 before
  // ------------------------------------------------------------------------

  describe('over the 2MB text ceiling: 200 read-only, not 413', () => {
    it.each(['big.md', 'big.yaml', 'big.yml'])(
      '%s at 2MB+1 is 200 with the full body',
      async (name) => {
        const body = writeSized(name, OVER_TEXT);

        const response = await GET(request(name), params(name));

        expect(response.status).toBe(200);
        const data = await response.json();
        // The whole point: the body is actually there, not an error envelope.
        expect(data.success).toBe(true);
        expect(data.content).toBe(body);
        expect(data.totalBytes).toBe(OVER_TEXT);
        expect(loggerError).not.toHaveBeenCalled();
      },
    );

    it('carries readOnly:true and a structured reason naming the 2MB limit', async () => {
      writeSized('big.md', OVER_TEXT);

      const response = await GET(request('big.md'), params('big.md'));
      const data = await response.json();

      expect(data.readOnly).toBe(true);
      expect(data.readOnlyReason).toEqual({
        code: 'FILE_TOO_LARGE',
        message: expect.any(String),
        limitBytes: TEXT_MAX_SIZE_BYTES,
        sizeBytes: OVER_TEXT,
      });
    });

    it('the reason message is human-readable and states both sizes', async () => {
      writeSized('big.md', OVER_TEXT);

      const response = await GET(request('big.md'), params('big.md'));
      const { readOnlyReason } = await response.json();

      // The banner shows this verbatim, so it must read as a sentence and must
      // not print the file size and the limit as the same rounded number.
      expect(readOnlyReason.message).toContain('read-only');
      expect(readOnlyReason.message).toContain('2.0MB');
      expect(readOnlyReason.message).toMatch(/2\.0MB.*2\.0MB/s);
      expect(readOnlyReason.message).not.toMatch(/undefined|NaN/);
    });
  });

  describe('over the 5MB HTML ceiling: 200 read-only, not 413', () => {
    it.each(['big.html', 'big.htm'])('%s at 5MB+1 is 200 read-only', async (name) => {
      writeSized(name, OVER_HTML);

      const response = await GET(request(name), params(name));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.readOnly).toBe(true);
      // HTML keeps its OWN ceiling — it must not be reported against the 2MB one.
      expect(data.readOnlyReason.limitBytes).toBe(HTML_MAX_SIZE_BYTES);
      expect(data.readOnlyReason.sizeBytes).toBe(OVER_HTML);
      expect(data.readOnlyReason.message).toContain('5.0MB');
    });

    it('an HTML file between the two ceilings (3MB) is NOT read-only', async () => {
      // Guards the precedence rule: 3MB is over the 2MB text limit but under
      // HTML's 5MB one. Checking text first would wrongly flag it.
      writeSized('mid.html', 3 * 1024 * 1024);

      const response = await GET(request('mid.html'), params('mid.html'));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.readOnly).toBeUndefined();
      expect(data.readOnlyReason).toBeUndefined();
      expect(data.isHtml).toBe(true);
    });
  });

  // ------------------------------------------------------------------------
  // Boundaries and the untouched majority
  // ------------------------------------------------------------------------

  describe('files within their ceiling are unchanged', () => {
    it('a .md at EXACTLY 2MB is 200 and not flagged', async () => {
      writeSized('exact.md', TEXT_MAX_SIZE_BYTES);

      const response = await GET(request('exact.md'), params('exact.md'));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.readOnly).toBeUndefined();
      expect(data.readOnlyReason).toBeUndefined();
    });

    it('an .html at EXACTLY 5MB is 200 and not flagged', async () => {
      writeSized('exact.html', HTML_MAX_SIZE_BYTES);

      const response = await GET(request('exact.html'), params('exact.html'));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.readOnly).toBeUndefined();
    });

    it('a small .md carries no readOnly key at all (payload shape unchanged)', async () => {
      writeSized('small.md', 16);

      const response = await GET(request('small.md'), params('small.md'));
      const data = await response.json();

      expect(Object.keys(data)).not.toContain('readOnly');
      expect(Object.keys(data)).not.toContain('readOnlyReason');
    });
  });

  describe('non-editable extensions are still uncapped and never flagged', () => {
    it.each([
      'large.log',
      'large.json',
    ])('%s at 3MB is 200 with no readOnly flag', async (name) => {
      const body = writeSized(name, 3 * 1024 * 1024);

      const response = await GET(request(name), params(name));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBe(body);
      expect(data.readOnly).toBeUndefined();
    });

    it('large.txt moved to the capped side when Issue #2506 made .txt editable', async () => {
      // This case used to sit in the list above, as the pinned prediction that
      // adding `.txt` to EDITABLE_EXTENSIONS would change its GET behaviour.
      // It did, and the change is the intended one: a 3MB `.txt` is still
      // READABLE in full — the outcome #2505 exists to guarantee — it is only
      // flagged unsaveable. Had #2505 not landed first, this same edit would
      // have turned the response into 413 and made the file unopenable.
      const body = writeSized('large.txt', 3 * 1024 * 1024);

      const response = await GET(request('large.txt'), params('large.txt'));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBe(body);
      expect(data.readOnly).toBe(true);
      expect(data.readOnlyReason.code).toBe('FILE_TOO_LARGE');
      expect(data.readOnlyReason.limitBytes).toBe(TEXT_MAX_SIZE_BYTES);
    });
  });

  // ------------------------------------------------------------------------
  // Line-range mode agrees with the full read
  // ------------------------------------------------------------------------

  describe('line-range reads report the same read-only state', () => {
    it('a slice of an oversize .md is 200 and flagged read-only', async () => {
      // The viewer fetches further chunks through this mode while scrolling; if
      // only the full-content path reported `readOnly`, the first chunk merge
      // would drop the flag and the editor UI would reappear mid-scroll.
      // Built with one join, not a `join()` per loop iteration: the quadratic
      // version took ~4000 joins over a growing 2MB array and blew the 5s
      // per-test timeout once the suite ran under full parallel load.
      const LINE_WIDTH = 500;
      const lineCount = Math.ceil(OVER_TEXT / (LINE_WIDTH + 1)) + 1;
      const lines = new Array<string>(lineCount).fill('x'.repeat(LINE_WIDTH));
      const huge = lines.join('\n');
      expect(huge.length).toBeGreaterThan(OVER_TEXT);
      writeFileSync(join(worktreeDir, 'huge.md'), huge, 'utf-8');

      const response = await GET(
        request('huge.md?startLine=1&endLine=3'),
        params('huge.md'),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.range).toEqual({ start: 1, end: 3 });
      expect(data.readOnly).toBe(true);
      expect(data.readOnlyReason.code).toBe('FILE_TOO_LARGE');
    });

    it('a slice of a small .md is not flagged', async () => {
      writeFileSync(join(worktreeDir, 'tiny.md'), 'a\nb\nc\n', 'utf-8');

      const response = await GET(request('tiny.md?startLine=1&endLine=2'), params('tiny.md'));

      const data = await response.json();
      expect(data.readOnly).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------
  // PUT is the half of the contract that must NOT change
  // ------------------------------------------------------------------------

  describe('PUT still refuses oversize writes (unchanged)', () => {
    it('writing 2MB+1 to a .md is 400 INVALID_CONTENT', async () => {
      writeSized('big.md', 16);
      const oversize = 'y'.repeat(OVER_TEXT);

      const response = await PUT(putRequest('big.md', oversize), params('big.md'));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_CONTENT');
      expect(data.error.message).toBe('File size exceeds limit');
    });

    it('writing 5MB+1 to an .html is 400 INVALID_CONTENT', async () => {
      writeSized('big.html', 16);

      const response = await PUT(putRequest('big.html', 'y'.repeat(OVER_HTML)), params('big.html'));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_CONTENT');
    });

    it('the refused write leaves the file on disk untouched', async () => {
      const original = writeSized('keep.md', 16);

      await PUT(putRequest('keep.md', 'y'.repeat(OVER_TEXT)), params('keep.md'));

      expect(readFileSync(join(worktreeDir, 'keep.md'), 'utf-8')).toBe(original);
    });

    it('a file opened read-only by GET is still refused by PUT', async () => {
      // The round trip the UI must honour: GET says "view but do not save", and
      // PUT proves that is not merely advisory.
      writeSized('roundtrip.md', OVER_TEXT);

      const getResponse = await GET(request('roundtrip.md'), params('roundtrip.md'));
      const getData = await getResponse.json();
      expect(getData.readOnly).toBe(true);

      const putResponse = await PUT(
        putRequest('roundtrip.md', getData.content),
        params('roundtrip.md'),
      );

      expect(putResponse.status).toBe(400);
      expect((await putResponse.json()).error.code).toBe('INVALID_CONTENT');
    });

    it('PUT to a non-editable extension is still 403 NOT_EDITABLE', async () => {
      // [Issue #2506] Was `notes.txt`, which is editable now. `.js` is not, and
      // the point of the case — that the read-only work of #2505 did not widen
      // the write allow-list — is unchanged.
      writeSized('notes.js', 16);

      const response = await PUT(putRequest('notes.js', 'hello'), params('notes.js'));

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('NOT_EDITABLE');
    });

    it('an within-limit write still succeeds', async () => {
      writeSized('ok.md', 16);

      const response = await PUT(putRequest('ok.md', '# updated'), params('ok.md'));

      expect(response.status).toBe(200);
      expect(readFileSync(join(worktreeDir, 'ok.md'), 'utf-8')).toBe('# updated');
    });
  });

  // ------------------------------------------------------------------------
  // Nothing anywhere answers 413 for a plain oversize read any more
  // ------------------------------------------------------------------------

  it('no GET shape returns 413 FILE_TOO_LARGE for an oversize editable file', async () => {
    writeSized('big.md', OVER_TEXT);
    writeSized('big.html', OVER_HTML);

    const responses = await Promise.all([
      GET(request('big.md'), params('big.md')),
      GET(request('big.html'), params('big.html')),
      GET(request('big.md?startLine=1&endLine=1'), params('big.md')),
    ]);

    for (const response of responses) {
      expect(response.status).not.toBe(413);
      expect(response.status).toBe(200);
    }
  });
});
