/**
 * Unit tests for validateFilesBody (Issue #780).
 *
 * Extracted from the verbatim-duplicated validator in the stage/unstage routes.
 * Uses the REAL isPathSafe (pure path math, no filesystem) and the real
 * MAX_GIT_FILES so the assertions reflect production behavior exactly.
 */

import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import { validateFilesBody } from '@/lib/git/git-route-helpers';
import { MAX_GIT_FILES } from '@/config/git-status-config';

const ROOT = '/path/to/worktree';

async function errorOf(result: string[] | NextResponse): Promise<{ status: number; error: string }> {
  if (!(result instanceof NextResponse)) {
    throw new Error('expected a NextResponse error result');
  }
  const body = (await result.json()) as { error: string };
  return { status: result.status, error: body.error };
}

describe('validateFilesBody (Issue #780)', () => {
  it('returns the array unchanged for valid relative paths', () => {
    const files = ['a.ts', 'src/b.ts'];
    const result = validateFilesBody(files, ROOT);
    expect(result).toEqual(files);
    expect(result).not.toBeInstanceOf(NextResponse);
  });

  it('rejects a non-array with 400', async () => {
    const { status, error } = await errorOf(validateFilesBody('a.ts', ROOT));
    expect(status).toBe(400);
    expect(error).toBe('files must be a non-empty array');
  });

  it('rejects an empty array with 400', async () => {
    const { status, error } = await errorOf(validateFilesBody([], ROOT));
    expect(status).toBe(400);
    expect(error).toBe('files must be a non-empty array');
  });

  it('rejects more than MAX_GIT_FILES entries with 400', async () => {
    const files = Array.from({ length: MAX_GIT_FILES + 1 }, (_, i) => `f${i}.ts`);
    const { status, error } = await errorOf(validateFilesBody(files, ROOT));
    expect(status).toBe(400);
    expect(error).toBe(`files exceeds the maximum of ${MAX_GIT_FILES}`);
  });

  it('accepts exactly MAX_GIT_FILES entries', () => {
    const files = Array.from({ length: MAX_GIT_FILES }, (_, i) => `f${i}.ts`);
    const result = validateFilesBody(files, ROOT);
    expect(Array.isArray(result)).toBe(true);
  });

  it('rejects a non-string entry with 400', async () => {
    const { status, error } = await errorOf(validateFilesBody([123], ROOT));
    expect(status).toBe(400);
    expect(error).toBe('files must contain only non-empty strings');
  });

  it('rejects an empty-string entry with 400', async () => {
    const { status, error } = await errorOf(validateFilesBody([''], ROOT));
    expect(status).toBe(400);
    expect(error).toBe('files must contain only non-empty strings');
  });

  it('rejects a path-traversal entry with 400 (Invalid file path)', async () => {
    const { status, error } = await errorOf(validateFilesBody(['../../etc/passwd'], ROOT));
    expect(status).toBe(400);
    expect(error).toBe('Invalid file path');
  });

  it('rejects a null-byte entry with 400 (Invalid file path)', async () => {
    const { status, error } = await errorOf(validateFilesBody(['a\x00.ts'], ROOT));
    expect(status).toBe(400);
    expect(error).toBe('Invalid file path');
  });
});
