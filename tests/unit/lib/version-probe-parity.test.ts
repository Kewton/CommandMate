/**
 * The two probe tables must not drift apart (Issue #1929).
 *
 * `slash-command-catalog.ts` asks "is the bundled slash-command list behind?"
 * and `detection/version-probes.ts` asks "were these detection rules read off
 * the build that is installed?". Two questions, two tables — §4 D2 says the
 * second is 「`VERSION_PROBES` と同型」, not that it is the same object, and
 * nothing requires the two to name the same tools forever.
 *
 * They do share one thing that would be a silent bug to duplicate wrongly: what
 * counts as a version and which of two versions is newer. Each module owns its
 * own copy, because the catalog module cannot be imported from the CLI bundle
 * (`tsconfig.cli.json` sets `"paths": {}`, and the catalog reaches `@/` modules)
 * while `commandmate status` has to read the detector's. This file is the guard
 * that the two copies agree — on real banners, on the ordering trap that makes
 * a lexical compare wrong, and on what is not a version at all.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCliVersion as parseDetectorVersion,
  compareCliVersions as compareDetectorVersions,
} from '@/lib/detection/version-probes';
import {
  parseCliVersion as parseCatalogVersion,
  compareCliVersions as compareCatalogVersions,
} from '@/lib/slash-command-catalog';

/** Real `--version` banners, measured 2026-08-23, plus the non-answers. */
const PARSE_VECTORS = [
  '2.1.240 (Claude Code)',
  'codex-cli 0.148.0',
  '1.1.18',
  'GitHub Copilot CLI 1.0.80.',
  '0.55.1',
  '1.18.21',
  'unknown build',
  '',
  'unmeasured',
  '0.4.x',
];

const COMPARE_VECTORS: [string, string][] = [
  ['2.2.0', '2.1.218'],
  ['2.1.218', '2.1.218'],
  ['2.1.0', '2.1.218'],
  ['0.9.0', '0.10.0'],
  ['1.1.18', '0.4.0'],
  ['10.0.0', '9.99.99'],
];

describe('[#1929] the detector and catalog version helpers agree', () => {
  it.each(PARSE_VECTORS)('parses %j the same way', (input) => {
    expect(parseDetectorVersion(input)).toBe(parseCatalogVersion(input));
  });

  it.each(COMPARE_VECTORS)('orders %s against %s the same way', (a, b) => {
    expect(compareDetectorVersions(a, b)).toBe(compareCatalogVersions(a, b));
    // And the ordering is antisymmetric, which a lexical compare is not.
    // Summed rather than negated: `toBe` is Object.is, and -0 !== 0 there.
    expect(compareDetectorVersions(b, a) + compareCatalogVersions(a, b)).toBe(0);
  });
});
