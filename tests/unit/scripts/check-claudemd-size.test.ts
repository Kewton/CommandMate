/**
 * Tests for the CLAUDE.md size guard (Issue #809, extracted in #1882).
 *
 * The 35000-byte cap used to be a shell variable inside `.github/workflows/ci-pr.yml`.
 * `.commandmate/verify.yaml` now runs the same check as a gate, so the number has
 * to live in exactly one place — these tests pin both the value and the boundary,
 * because "at the limit" and "one byte over" are the only two cases a cap has.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_MD_SIZE_LIMIT_BYTES,
  checkClaudeMdSize,
} from '../../../scripts/check-claudemd-size.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

type SizeResult = { size: number; limit: number; ok: boolean };
const check = (root: string): SizeResult => checkClaudeMdSize(root) as SizeResult;

describe('Issue #809: the cap', () => {
  it('is 35000 bytes', () => {
    expect(CLAUDE_MD_SIZE_LIMIT_BYTES).toBe(35000);
  });

  it('passes for this repository', () => {
    const result = check(REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.size).toBeLessThanOrEqual(35000);
  });
});

describe('Issue #1882: the guard actually fires', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claudemd-'));
  });

  afterEach(() => {
    removeTempDir(root);
  });

  const writeBytes = (count: number): void => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'a'.repeat(count));
  };

  it('accepts a file one byte under the limit', () => {
    writeBytes(CLAUDE_MD_SIZE_LIMIT_BYTES - 1);
    expect(check(root)).toMatchObject({ size: 34999, ok: true });
  });

  it('accepts a file exactly at the limit — the cap is inclusive, as the shell `-gt` was', () => {
    writeBytes(CLAUDE_MD_SIZE_LIMIT_BYTES);
    expect(check(root).ok).toBe(true);
  });

  it('rejects a file one byte over the limit', () => {
    writeBytes(CLAUDE_MD_SIZE_LIMIT_BYTES + 1);
    expect(check(root)).toMatchObject({ size: 35001, ok: false });
  });

  it('throws rather than reporting "under the limit" when CLAUDE.md is missing', () => {
    expect(() => check(root)).toThrow(/CLAUDE\.md not found/);
  });
});
