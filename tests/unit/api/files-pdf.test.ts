/**
 * Unit tests for GET /api/worktrees/:id/files/:path (PDF branch)
 * Issue #673: PDF viewer implementation
 *
 * Tests the PDF-specific branch that reads a PDF file as binary,
 * validates size and magic bytes, and returns a Base64 data URI.
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
import {
  createMinimalPdfBuffer,
  createPdfBufferOfSize,
  createBrokenPdfBuffer,
} from '@tests/helpers/pdf-fixtures';
import { PDF_MAX_SIZE_BYTES } from '@/config/pdf-extensions';

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

describe('GET /api/worktrees/:id/files/:path (PDF branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Base64 data URI with isPdf=true for a valid .pdf file', async () => {
    mockWorktree();
    const buffer = createMinimalPdfBuffer();
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(buffer);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/docs/sample.pdf'),
      { params: { id: 'test-wt', path: ['docs', 'sample.pdf'] } },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.isPdf).toBe(true);
    expect(data.mimeType).toBe('application/pdf');
    expect(data.content).toMatch(/^data:application\/pdf;base64,/);
    expect(data.path).toBe('docs/sample.pdf');
    expect(data.extension).toBe('pdf');
  });

  it('returns PDF_SIZE_EXCEEDED error when the PDF exceeds 20MB', async () => {
    mockWorktree();
    const tooLarge = createPdfBufferOfSize(PDF_MAX_SIZE_BYTES + 1);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(tooLarge);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/big.pdf'),
      { params: { id: 'test-wt', path: ['big.pdf'] } },
    );

    expect(response.status).toBe(413);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('PDF_SIZE_EXCEEDED');
  });

  it('returns INVALID_MAGIC_BYTES error when file does not start with %PDF-', async () => {
    mockWorktree();
    const bogus = createBrokenPdfBuffer();
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(bogus);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/fake.pdf'),
      { params: { id: 'test-wt', path: ['fake.pdf'] } },
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INVALID_MAGIC_BYTES');
  });

  it('returns FILE_NOT_FOUND when readFile throws ENOENT', async () => {
    mockWorktree();
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const response = await GET(
      createRequest('/api/worktrees/test-wt/files/missing.pdf'),
      { params: { id: 'test-wt', path: ['missing.pdf'] } },
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('FILE_NOT_FOUND');
  });

  it('returns WORKTREE_NOT_FOUND when the worktree does not exist', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/ghost/files/any.pdf'),
      { params: { id: 'ghost', path: ['any.pdf'] } },
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
  });

  it('does NOT enter the PDF branch for non-PDF extensions', async () => {
    // Case: a .txt file - readFile should NOT be called via the PDF branch.
    // Instead, the standard text-reading path should run. We assert by
    // ensuring the response does NOT contain isPdf=true.
    mockWorktree();

    // The non-PDF path uses readFileContent + stat, which we intentionally
    // do not fully mock here. Instead, verify that the response (if any) is
    // not marked as PDF. We mock stat to simulate a tiny text file so the
    // standard path can proceed without error.
    const { stat } = await import('fs/promises');
    (stat as ReturnType<typeof vi.fn>).mockResolvedValue({
      size: 10,
      mtime: new Date('2025-01-01'),
    });

    // Mock readFileContent transitively via the standard path: we simply
    // verify that readFile (binary read) is never called for .txt when the
    // PDF branch is skipped. The test is only concerned with the branch
    // routing, so we accept whatever the standard path does.
    try {
      await GET(
        createRequest('/api/worktrees/test-wt/files/note.txt'),
        { params: { id: 'test-wt', path: ['note.txt'] } },
      );
    } catch {
      // Standard text path may throw because we don't fully mock
      // readFileContent. That is acceptable here; the key assertion is that
      // we did not take the PDF binary-read branch.
    }

    // Ensure the binary read path was NOT invoked for a .txt file.
    // (The PDF branch would call readFile once.)
    const readFileMock = readFile as ReturnType<typeof vi.fn>;
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
