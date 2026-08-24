#!/usr/bin/env tsx
/**
 * check-detector-freshness (Issue #1929, 方針書 §4 D2)
 *
 * Reports whether each tool module's detection rules were read off the CLI build
 * that is installed on THIS machine. `src/lib/detection/tools/verified-against.ts`
 * holds one half of the comparison; `DETECTOR_VERSION_PROBES` reads the other.
 *
 * Usage:
 *   npm run check:detector-freshness            # report; always exit 0
 *   npm run check:detector-freshness -- --json  # machine-readable report
 *   npm run check:detector-freshness -- --strict  # exit 1 if anything is stale
 *
 * **Advisory by default, and CI runs it manually** (§4 D2: 「CI では …（任意実行）
 * で警告」). It cannot be a required gate: the answer depends on which CLIs the
 * runner happens to have installed, so a hosted runner with none of them would
 * report "all fresh" and a developer machine that upgraded copilot yesterday
 * would fail a build that has nothing to do with copilot. `--strict` exists for
 * a human who deliberately wants the non-zero exit.
 *
 * A tool that is not installed is reported as `not installed` and is never
 * stale — no executable resolved on PATH means no probe ran and no child
 * process was spawned (DR4-010 (2)).
 */

import {
  getDetectorFreshness,
  type DetectorFreshnessRow,
} from '../src/lib/detection/version-probes';

const UNMEASURED = 'unmeasured';

function formatRow(row: DetectorFreshnessRow): string {
  const installed = row.installed ?? 'not installed';
  if (row.stale) {
    return `  STALE      ${row.tool.padEnd(12)} installed ${installed}, rules read off ${row.verifiedAgainst}`;
  }
  if (row.verifiedAgainst === UNMEASURED) {
    return `  UNMEASURED ${row.tool.padEnd(12)} installed ${installed}, no frames ever captured`;
  }
  if (row.installed === null) {
    return `  SKIPPED    ${row.tool.padEnd(12)} not installed (rules read off ${row.verifiedAgainst})`;
  }
  return `  ok         ${row.tool.padEnd(12)} installed ${installed}, rules read off ${row.verifiedAgainst}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');

  const rows = await getDetectorFreshness();
  const stale = rows.filter((row) => row.stale);

  if (json) {
    console.log(JSON.stringify({ stale: stale.length, rows }, null, 2));
  } else {
    console.log('Detector freshness (rules vs. the CLI installed here)');
    console.log('-'.repeat(72));
    for (const row of rows) console.log(formatRow(row));
    console.log('-'.repeat(72));
    console.log(
      stale.length === 0
        ? 'No detector is behind its installed CLI.'
        : `${stale.length} detector rule set(s) were read off an older CLI than the one installed.\n`
          + 'Re-capture fixtures for those tools and update tools/verified-against.ts.'
    );
  }

  process.exitCode = strict && stale.length > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('check-detector-freshness failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
