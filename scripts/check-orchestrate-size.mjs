#!/usr/bin/env node
/**
 * Fails when .claude/commands/orchestrate.md grows past its hard byte cap.
 *
 * [Issue #3481] `/orchestrate` loads the whole runbook into the session, and a
 * long run's context compaction truncated it mid-way ("truncated for
 * compaction"). Measurements, rationale and procedures that a run reads only
 * on demand (exit-code handling, switching the assignee, monitor) live in
 * docs/orchestrate/; the body keeps one line per rule and says when to read
 * which document. The cap is what stops the body from absorbing them again.
 *
 * Same shape as scripts/check-claudemd-size.mjs (Issue #809 / #1882): this
 * file is the SINGLE authority for the limit. `.github/workflows/ci-pr.yml`
 * (job `orchestrate-size`) and tests/unit/docs/orchestrate-size-3481.test.ts
 * run this script and hold no copy of the number.
 *
 * Usage: node scripts/check-orchestrate-size.mjs [repoRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * 118kB hard cap: the body after #3481 (107,511 bytes) plus about 10%.
 * Put measurements and rationale in docs/orchestrate/ instead.
 */
export const ORCHESTRATE_MD_SIZE_LIMIT_BYTES = 118000;

export const ORCHESTRATE_MD_RELATIVE_PATH = '.claude/commands/orchestrate.md';

/**
 * @param root repository root to check (defaults to this repository)
 * @returns `{ size, limit, ok }` — `ok` is false when the cap is exceeded
 * @throws when orchestrate.md is missing; a guard that found nothing to measure
 *         must not report "under the limit"
 */
export function checkOrchestrateSize(root) {
  const file = path.join(root, ORCHESTRATE_MD_RELATIVE_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`${ORCHESTRATE_MD_RELATIVE_PATH} not found at ${file}`);
  }
  const size = fs.statSync(file).size;
  return { size, limit: ORCHESTRATE_MD_SIZE_LIMIT_BYTES, ok: size <= ORCHESTRATE_MD_SIZE_LIMIT_BYTES };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = checkOrchestrateSize(root);
  } catch (error) {
    console.error(`::error::orchestrate.md size guard could not run — ${error.message}`);
    process.exit(2);
  }
  if (!result.ok) {
    console.error(
      `::error::${ORCHESTRATE_MD_RELATIVE_PATH} size ${result.size} exceeds limit ${result.limit} bytes. Move measurements and rationale to docs/orchestrate/.`
    );
    process.exit(1);
  }
  console.log(`${ORCHESTRATE_MD_RELATIVE_PATH} size: ${result.size} bytes (under ${result.limit})`);
}
