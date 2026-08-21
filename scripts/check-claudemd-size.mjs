#!/usr/bin/env node
/**
 * Fails when CLAUDE.md grows past its hard byte cap.
 *
 * [Issue #809] CLAUDE.md is loaded into every session's context. Module detail,
 * function signatures and Issue history belong in docs/module-reference.md; the
 * cap is what stops the file from absorbing them one append at a time.
 *
 * [Issue #1882] This file is the SINGLE authority for the limit.
 * `.github/workflows/ci-pr.yml` (job `claudemd-size`) and
 * `.commandmate/verify.yaml` (gate `claudemd-size`) both run this script and
 * hold no copy of the number, because a limit written twice is a limit that
 * gets raised in one place and enforced at the old value in the other.
 *
 * Usage: node scripts/check-claudemd-size.mjs [repoRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** 35kB hard cap. Store module detail in docs/module-reference.md instead. */
export const CLAUDE_MD_SIZE_LIMIT_BYTES = 35000;

export const CLAUDE_MD_RELATIVE_PATH = 'CLAUDE.md';

/**
 * @param root repository root to check (defaults to this repository)
 * @returns `{ size, limit, ok }` — `ok` is false when the cap is exceeded
 * @throws when CLAUDE.md is missing; a guard that found nothing to measure must
 *         not report "under the limit"
 */
export function checkClaudeMdSize(root) {
  const file = path.join(root, CLAUDE_MD_RELATIVE_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`${CLAUDE_MD_RELATIVE_PATH} not found at ${file}`);
  }
  const size = fs.statSync(file).size;
  return { size, limit: CLAUDE_MD_SIZE_LIMIT_BYTES, ok: size <= CLAUDE_MD_SIZE_LIMIT_BYTES };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = checkClaudeMdSize(root);
  } catch (error) {
    console.error(`::error::CLAUDE.md size guard could not run — ${error.message}`);
    process.exit(2);
  }
  if (!result.ok) {
    console.error(
      `::error::CLAUDE.md size ${result.size} exceeds limit ${result.limit} bytes. See docs/module-reference.md for detail storage.`
    );
    process.exit(1);
  }
  console.log(`CLAUDE.md size: ${result.size} bytes (under ${result.limit})`);
}
