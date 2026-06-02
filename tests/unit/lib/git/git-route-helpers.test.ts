/**
 * Unit tests for validateFilesBody (Issue #780).
 *
 * Extracted from the verbatim-duplicated validator in the stage/unstage routes.
 * Uses the REAL isPathSafe (pure path math, no filesystem) and the real
 * MAX_GIT_FILES so the assertions reflect production behavior exactly.
 */

import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import {
  validateFilesBody,
  validateGitBranchName,
  validateStashIndex,
} from '@/lib/git/git-route-helpers';
import { MAX_GIT_FILES, MAX_STASH_INDEX } from '@/config/git-status-config';
// Imported only to assert the new validator behaves DIFFERENTLY than the CLI one
// (S3-003 regression: the CLI pattern allows `-force` and rejects `release/1.2`).
import { BRANCH_NAME_PATTERN } from '@/cli/utils/input-validators';

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

// ----------------------------------------------------------------------------
// validateGitBranchName (Issue #781)
// ----------------------------------------------------------------------------

async function reasonOf(
  result: string | NextResponse
): Promise<{ status: number; reason: string }> {
  if (!(result instanceof NextResponse)) {
    throw new Error('expected a NextResponse error result');
  }
  const body = (await result.json()) as { reason: string };
  return { status: result.status, reason: body.reason };
}

describe('validateGitBranchName (Issue #781)', () => {
  it('accepts a simple branch name', () => {
    expect(validateGitBranchName('feature/781-worktree')).toBe('feature/781-worktree');
  });

  it('accepts a dotted name like release/1.2 (CLI validator would reject this)', () => {
    expect(validateGitBranchName('release/1.2')).toBe('release/1.2');
    // Regression guard: the CLI BRANCH_NAME_PATTERN rejects the dot.
    expect(BRANCH_NAME_PATTERN.test('release/1.2')).toBe(false);
  });

  it('accepts a name with underscores and hyphens in the middle', () => {
    expect(validateGitBranchName('my_branch-2')).toBe('my_branch-2');
  });

  for (const invalid of [
    '',          // empty
    '-force',    // leading hyphen (option injection) — CLI validator ALLOWS this
    '--all',     // leading hyphen
    '/feature',  // leading slash
    'feature/',  // trailing slash
    'a//b',      // double slash
    'a..b',      // double dot
    '.hidden',   // leading dot
    'feature.',  // trailing dot
    'foo.lock',  // trailing .lock
    'foo@{1}',   // @{ sequence
    'foo bar',   // whitespace
    'foo\tbar',  // tab whitespace
    'foo~bar',   // tilde
    'foo^bar',   // caret
    'foo:bar',   // colon
    'foo?bar',   // question mark
    'foo*bar',   // asterisk
    'foo[bar',   // open bracket
    'foo\\bar',  // backslash
    'foo\x00bar', // control char
  ]) {
    it(`rejects invalid name ${JSON.stringify(invalid)} with 400 invalid_branch_name`, async () => {
      const { status, reason } = await reasonOf(validateGitBranchName(invalid));
      expect(status).toBe(400);
      expect(reason).toBe('invalid_branch_name');
    });
  }

  it('rejects names longer than 255 characters', async () => {
    const long = 'a'.repeat(256);
    const { status, reason } = await reasonOf(validateGitBranchName(long));
    expect(status).toBe(400);
    expect(reason).toBe('invalid_branch_name');
  });

  it('accepts a name of exactly 255 characters', () => {
    const max = 'a'.repeat(255);
    expect(validateGitBranchName(max)).toBe(max);
  });

  it('rejects a non-string input', async () => {
    const { status, reason } = await reasonOf(validateGitBranchName(123 as unknown as string));
    expect(status).toBe(400);
    expect(reason).toBe('invalid_branch_name');
  });

  it('regression: CLI validator ALLOWS a leading hyphen but the git validator REJECTS it', async () => {
    // This is the core S3-003 divergence: the CLI pattern is option-injection prone.
    expect(BRANCH_NAME_PATTERN.test('-force')).toBe(true);
    const { reason } = await reasonOf(validateGitBranchName('-force'));
    expect(reason).toBe('invalid_branch_name');
  });
});

describe('validateStashIndex (Issue #782)', () => {
  async function reasonOf(
    result: number | NextResponse
  ): Promise<{ status: number; reason: string }> {
    if (!(result instanceof NextResponse)) {
      throw new Error('expected a NextResponse error result');
    }
    const body = (await result.json()) as { reason: string };
    return { status: result.status, reason: body.reason };
  }

  it('accepts a non-negative integer number and returns it', () => {
    expect(validateStashIndex(0)).toBe(0);
    expect(validateStashIndex(5)).toBe(5);
  });

  it('accepts a numeric string and coerces to number', () => {
    expect(validateStashIndex('0')).toBe(0);
    expect(validateStashIndex('12')).toBe(12);
  });

  it('accepts the maximum index', () => {
    expect(validateStashIndex(MAX_STASH_INDEX)).toBe(MAX_STASH_INDEX);
  });

  it('rejects an index above the maximum with 400 invalid_stash_index', async () => {
    const { status, reason } = await reasonOf(validateStashIndex(MAX_STASH_INDEX + 1));
    expect(status).toBe(400);
    expect(reason).toBe('invalid_stash_index');
  });

  it('rejects a negative index', async () => {
    const { reason } = await reasonOf(validateStashIndex(-1));
    expect(reason).toBe('invalid_stash_index');
  });

  it('rejects a non-integer (decimal) string', async () => {
    const { reason } = await reasonOf(validateStashIndex('1.5'));
    expect(reason).toBe('invalid_stash_index');
  });

  it('rejects a non-numeric string', async () => {
    const { reason } = await reasonOf(validateStashIndex('abc'));
    expect(reason).toBe('invalid_stash_index');
  });

  it('rejects an empty string', async () => {
    const { reason } = await reasonOf(validateStashIndex(''));
    expect(reason).toBe('invalid_stash_index');
  });

  it('rejects undefined / null', async () => {
    expect((await reasonOf(validateStashIndex(undefined))).reason).toBe('invalid_stash_index');
    expect((await reasonOf(validateStashIndex(null))).reason).toBe('invalid_stash_index');
  });

  it('rejects a string with a leading sign / whitespace', async () => {
    expect((await reasonOf(validateStashIndex('+1'))).reason).toBe('invalid_stash_index');
    expect((await reasonOf(validateStashIndex(' 1'))).reason).toBe('invalid_stash_index');
  });
});
