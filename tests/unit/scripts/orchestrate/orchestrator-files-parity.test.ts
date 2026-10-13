/**
 * ORCHESTRATOR_FILES has two copies (#3588): pr-common.mjs, where merge-pr
 * looks past the 6-4 fold commit to the worker's HEAD, and scope-gate.ts, where
 * the scope gate drops what only that commit changed. They must name the same
 * files, or the merge side and the gate disagree again.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_FILES as MJS_ORCHESTRATOR_FILES } from '../../../../scripts/orchestrate/pr-common.mjs';
import { ORCHESTRATOR_FILES, isOrchestratorOnlyCommit } from '@/lib/verification/scope-gate';

describe('ORCHESTRATOR_FILES parity (#3588)', () => {
  it('has the same contents in pr-common.mjs and scope-gate.ts', () => {
    expect([...ORCHESTRATOR_FILES]).toEqual([...MJS_ORCHESTRATOR_FILES]);
  });

  it('judges a commit the way workHeads does: non-empty and every file listed', () => {
    expect(isOrchestratorOnlyCommit([...MJS_ORCHESTRATOR_FILES])).toBe(true);
    expect(isOrchestratorOnlyCommit([])).toBe(false);
    expect(isOrchestratorOnlyCommit([...MJS_ORCHESTRATOR_FILES, 'src/a.ts'])).toBe(false);
  });
});
