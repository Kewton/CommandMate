/**
 * Headroom under the /orchestrate runbook cap (Issue #4276).
 *
 * The cap is 118000 bytes (orchestrate-size-3481), but the body sat 25 bytes
 * under it, so two parallel PRs that each added a little failed together.
 * Details moved to docs/orchestrate/ and the body keeps the steps and a
 * pointer. This pins the 10000-byte headroom so a later addition has to move
 * its detail out instead of eating the margin.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ORCHESTRATE_MD_SIZE_LIMIT_BYTES } from '../../../scripts/check-orchestrate-size.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BODY = path.join(REPO_ROOT, '.claude/commands/orchestrate.md');
const TARGET_BYTES = 108000;

describe('Issue #4276: headroom under the cap', () => {
  it('the body is at most 108000 bytes', () => {
    expect(fs.statSync(BODY).size).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('the target keeps at least 10000 bytes of headroom under the cap', () => {
    expect(ORCHESTRATE_MD_SIZE_LIMIT_BYTES - TARGET_BYTES).toBeGreaterThanOrEqual(10000);
  });
});
