/**
 * Issue #2015: hold the `statusEvidence` docstring to what the code actually does.
 *
 * #2011 split `statusEvidence` from `isUnclassifiedActive` and left the CLI
 * mirror's docstring describing the #1927-era world in which they were one
 * fact. A docstring is not executable, so "revert it and watch a test go red"
 * is not available the way it is for a behavioural fix. What IS available is
 * pinning the two checkable claims the rewritten comment makes:
 *
 *   1. the reason tokens it names by hand are real members of the detector's
 *      vocabulary, and `input_prompt` is on the classified side of the split —
 *      the exact confusion #2011 fixed;
 *   2. the union it publishes is still exactly the server's `StatusEvidence`.
 *
 * ## What this CANNOT prove, stated plainly
 *
 * The authority for claim 1 is `UNCLASSIFIED_FRAME_REASONS` in
 * `src/lib/session/status-evidence.ts`, which #2011 keeps module-private, so
 * this file compares the docstring against `STATUS_REASON` constants instead of
 * against that set. A typo, a phantom reason, or `input_prompt` creeping back
 * into the unclassified list all fail here; a fourth member being ADDED to
 * `UNCLASSIFIED_FRAME_REASONS` server-side would not. Closing that needs one
 * word — `export` on that constant — which belongs to #2011's diff, not to a
 * docs Issue whose scope forbids `src/lib/**`.
 *
 * Deliberately reads the docstring as TEXT. Comments are erased before anything
 * this suite could import exists, and the point is to catch prose drifting away
 * from code, which is a property of the prose.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { STATUS_REASON } from '../../../../src/lib/detection/status-reason';
import type { StatusEvidence } from '../../../../src/lib/session/status-evidence';
import type { CurrentOutputResponse } from '../../../../src/cli/types/api-responses';

const API_RESPONSES_PATH = fileURLToPath(
  new URL('../../../../src/cli/types/api-responses.ts', import.meta.url),
);
const SOURCE = readFileSync(API_RESPONSES_PATH, 'utf8');

/**
 * The backticked tokens on the one docstring line beginning with `marker`.
 *
 * Bounded to a single line on purpose. A regex that ran on across the paragraph
 * would also swallow the file paths and the `'none'` literals the surrounding
 * prose backticks, and a guard that matches more than it means is the kind that
 * gets loosened rather than fixed.
 */
function tokensOnMarkerLine(marker: string): string[] {
  const lines = SOURCE.split('\n').filter((line) => line.includes(marker));
  if (lines.length !== 1) {
    throw new Error(`expected exactly 1 line containing "${marker}", found ${lines.length}`);
  }
  return [...lines[0].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

const UNCLASSIFIED_MARKER = 'Unclassified reasons:';
const UNPROVEN_MARKER = 'Classified-but-unproven:';

describe('[#2015] statusEvidence docstring ↔ detector vocabulary', () => {
  // Positive control for the parser itself. Every 0-length or "not found"
  // result below is only meaningful if the reader can both find a marker that
  // is there and refuse one that is not.
  it('the marker reader finds real markers and throws on absent ones', () => {
    expect(tokensOnMarkerLine(UNCLASSIFIED_MARKER).length).toBeGreaterThan(0);
    expect(tokensOnMarkerLine(UNPROVEN_MARKER).length).toBeGreaterThan(0);
    expect(() => tokensOnMarkerLine('Reasons that do not appear in this file:')).toThrow(
      /found 0/,
    );
  });

  it('names exactly the three reasons isUnclassifiedFrame treats as unclassified', () => {
    expect(new Set(tokensOnMarkerLine(UNCLASSIFIED_MARKER))).toEqual(
      new Set([
        STATUS_REASON.NO_RECENT_OUTPUT,
        STATUS_REASON.UNKNOWN_FRAME,
        STATUS_REASON.DEFAULT,
      ]),
    );
  });

  it('keeps input_prompt off the unclassified list and on the unproven one (#2011)', () => {
    expect(tokensOnMarkerLine(UNCLASSIFIED_MARKER)).not.toContain(STATUS_REASON.INPUT_PROMPT);
    expect(tokensOnMarkerLine(UNPROVEN_MARKER)).toContain(STATUS_REASON.INPUT_PROMPT);
  });

  it('names no reason the detector cannot produce', () => {
    const vocabulary = new Set<string>(Object.values(STATUS_REASON));
    for (const token of [
      ...tokensOnMarkerLine(UNCLASSIFIED_MARKER),
      ...tokensOnMarkerLine(UNPROVEN_MARKER),
    ]) {
      expect(vocabulary.has(token)).toBe(true);
    }
  });

  it('no longer claims the two fields carry one fact', () => {
    // The #1927-era sentence, verbatim. Its return is the regression.
    expect(SOURCE).not.toContain('the same fact {@link isUnclassifiedActive} carries');
  });
});

/**
 * The union width, held type-side.
 *
 * Same device and same reason as `_ServerReasonsAllKnownToCli` in
 * tests/unit/cli/config/cross-validation.test.ts: a union has no runtime
 * representation, and `src/cli` cannot import the server module to compare
 * (tsconfig.cli.json sets `"paths": {}`), so the CLI holds a copy and the copy
 * is checked here. Widen either side alone and `npx tsc --noEmit` stops — which
 * is what the docstring's "adding a third would be a breaking change" is worth.
 */
type AssertAssignable<Super, Sub extends Super> = Sub;
type _ServerEvidenceKnownToCli = AssertAssignable<
  NonNullable<CurrentOutputResponse['statusEvidence']>,
  StatusEvidence
>;
type _CliEvidenceExistsOnServer = AssertAssignable<
  StatusEvidence,
  NonNullable<CurrentOutputResponse['statusEvidence']>
>;

describe('[#2015] statusEvidence union width', () => {
  it('is enforced at compile time (see the assertions above this describe)', () => {
    const fromServer: StatusEvidence[] = ['positive', 'none'];
    const asPublished: NonNullable<CurrentOutputResponse['statusEvidence']>[] = fromServer;
    expect(new Set(asPublished).size).toBe(2);
  });
});
