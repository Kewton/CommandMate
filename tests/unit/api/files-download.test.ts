/**
 * Unit tests for GET /api/worktrees/:id/files/:path (?download=1 branch)
 * Issue #1024: mobile file download (server-side attachment delivery)
 *
 * Verifies the raw-attachment download branch:
 * - Content-Type: application/octet-stream (always, not the real MIME)
 * - Content-Disposition: attachment with filename + filename*=UTF-8''
 * - filename sanitization (newline / Japanese / symbol names)
 * - path validation is enforced (worktree-outside + symlink rejected)
 * - 404 FILE_NOT_FOUND for a non-existent path
 * - Cache-Control: no-store, private
 * - strict gate: `?download` absent/other value leaves existing behavior intact
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/security/path-validator', () => ({
  isPathSafe: vi.fn().mockReturnValue(true),
  resolveAndValidateRealPath: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GET } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { getWorktreeById } from '@/lib/db';
import { readFile } from 'fs/promises';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';

// ============================================================================
// Helpers
// ============================================================================

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

function mockWorktree(workPath = '/test/worktree'): void {
  (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({
    id: 'test-wt',
    path: workPath,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/worktrees/:id/files/:path (?download=1 branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (resolveAndValidateRealPath as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('returns octet-stream attachment with the raw bytes for ?download=1', async () => {
    mockWorktree();
    const bytes = Buffer.from('raw-binary-payload');
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(bytes);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/docs/report.txt?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['docs', 'report.txt'] }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');

    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="report.txt"');
    expect(disposition).toContain("filename*=UTF-8''report.txt");

    // Body must be the raw bytes (NOT a base64 JSON envelope).
    const text = await response.text();
    expect(text).toBe('raw-binary-payload');
  });

  it('serves an image with octet-stream (bypasses base64 preview path)', async () => {
    mockWorktree();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(bytes);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/pic.png?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['pic.png'] }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('filename="pic.png"');
    // Raw bytes, not a `data:image/png;base64,...` JSON payload.
    const buf = Buffer.from(await response.arrayBuffer());
    expect(Array.from(buf)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('percent-encodes a Japanese filename and strips it in the ASCII fallback', async () => {
    mockWorktree();
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('x'));

    const response = await GET(
      createRequest(
        `/api/worktrees/test-wt/files/${encodeURIComponent('レポート.txt')}?download=1`,
      ),
      { params: Promise.resolve({ id: 'test-wt', path: ['レポート.txt'] }) },
    );

    expect(response.status).toBe(200);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe('レポート.txt');
    // Header must not carry raw non-ASCII bytes in the value.
    expect(disposition).not.toMatch(/[^\x20-\x7e]/);
  });

  it('does not allow header injection via CR/LF in the filename', async () => {
    mockWorktree();
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('x'));

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/evil.txt?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['evil\r\nSet-Cookie: p=1.txt'] }) },
    );

    expect(response.status).toBe(200);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('rejects a worktree-outside path (isPathSafe=false) before reading', async () => {
    mockWorktree();
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/outside?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['..', '..', 'etc', 'passwd'] }) },
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_PATH');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a symlink-escaping path (resolveAndValidateRealPath=false)', async () => {
    mockWorktree();
    (resolveAndValidateRealPath as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/link?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['evil-link'] }) },
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_PATH');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns 404 FILE_NOT_FOUND when the file does not exist', async () => {
    mockWorktree();
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/missing.bin?download=1'),
      { params: Promise.resolve({ id: 'test-wt', path: ['missing.bin'] }) },
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('FILE_NOT_FOUND');
  });

  it('returns WORKTREE_NOT_FOUND for an unknown worktree even with ?download=1', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/ghost/files/any.bin?download=1'),
      { params: Promise.resolve({ id: 'ghost', path: ['any.bin'] }) },
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
  });

  it('strict gate: ?download absent leaves existing (non-download) behavior', async () => {
    // A .png without ?download=1 must still hit the image base64 branch.
    mockWorktree();
    // Minimal valid PNG (magic + size ok) is not required here; we only assert
    // that the octet-stream download branch was NOT taken. The image branch
    // will attempt validation and likely error, but the key point is the
    // response is JSON (not an octet-stream attachment).
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/pic.png'),
      { params: Promise.resolve({ id: 'test-wt', path: ['pic.png'] }) },
    );

    expect(response.headers.get('Content-Type')).not.toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('strict gate: ?download=0 (non-"1" value) is treated as non-download', async () => {
    mockWorktree();
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/pic.png?download=0'),
      { params: Promise.resolve({ id: 'test-wt', path: ['pic.png'] }) },
    );

    expect(response.headers.get('Content-Type')).not.toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });
});
