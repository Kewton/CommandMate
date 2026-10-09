/**
 * The byte cap on the /orchestrate runbook body (Issue #3481).
 *
 * `.claude/commands/orchestrate.md` grew to 151,691 bytes and was cut short by
 * context compaction during a long run. #3481 moved measurements, rationale and
 * on-demand procedures to docs/orchestrate/; scripts/check-orchestrate-size.mjs
 * holds the cap (CI job `orchestrate-size`). This test runs the same script, so
 * the unit gates catch an overgrown body locally too, and pins the boundary,
 * because "at the limit" and "one byte over" are the only two cases a cap has.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ORCHESTRATE_MD_RELATIVE_PATH,
  ORCHESTRATE_MD_SIZE_LIMIT_BYTES,
  checkOrchestrateSize,
} from '../../../scripts/check-orchestrate-size.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

type SizeResult = { size: number; limit: number; ok: boolean };
const check = (root: string): SizeResult => checkOrchestrateSize(root) as SizeResult;

describe('Issue #3481: the cap', () => {
  it('is 118000 bytes', () => {
    expect(ORCHESTRATE_MD_SIZE_LIMIT_BYTES).toBe(118000);
  });

  it('passes for this repository', () => {
    const result = check(REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.size).toBeLessThanOrEqual(ORCHESTRATE_MD_SIZE_LIMIT_BYTES);
  });
});

describe('Issue #3481: the guard actually fires', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-size-'));
  });

  afterEach(() => {
    removeTempDir(root);
  });

  const writeBytes = (count: number): void => {
    const file = path.join(root, ORCHESTRATE_MD_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a'.repeat(count));
  };

  it('accepts a file exactly at the limit — the cap is inclusive', () => {
    writeBytes(ORCHESTRATE_MD_SIZE_LIMIT_BYTES);
    expect(check(root)).toMatchObject({ size: ORCHESTRATE_MD_SIZE_LIMIT_BYTES, ok: true });
  });

  it('rejects a file one byte over the limit', () => {
    writeBytes(ORCHESTRATE_MD_SIZE_LIMIT_BYTES + 1);
    expect(check(root)).toMatchObject({ size: ORCHESTRATE_MD_SIZE_LIMIT_BYTES + 1, ok: false });
  });

  it('throws rather than reporting "under the limit" when orchestrate.md is missing', () => {
    expect(() => check(root)).toThrow(/orchestrate\.md not found/);
  });
});
