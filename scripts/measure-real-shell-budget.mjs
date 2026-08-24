#!/usr/bin/env node
/**
 * Sizes the real-shell subprocess guard from measurement (Issue #1950 / #1985).
 *
 * `tests/helpers/real-shell-budget.ts` carries two numbers — a per-call hang
 * guard and the vitest budget above it — and both are claimed to be derived
 * from a percentile of how long the family actually takes under load. Issue
 * #1985 exists because the *condition* of that measurement was never written
 * down: #1950's `p99.9 = 16.5s` was taken while ONE full `npm run test:unit`
 * was on the machine, and the number was then relied on while two ran at once.
 *
 * A number nobody can recompute cannot be defended, so this script is the
 * recompute. Feed it the JSON reports of a run (or several, from several
 * checkouts) and it prints the family's duration distribution:
 *
 *     NODE_ENV=test npx vitest run tests/unit \
 *       --reporter=json --outputFile=/tmp/run1.json
 *     node scripts/measure-real-shell-budget.mjs --guard=30000 /tmp/run1.json
 *
 * ## Two decisions worth knowing before reading a number out of it
 *
 * 1. **Membership is not re-implemented here.** The family regex is read out of
 *    `tests/helpers/real-shell-budget.ts` at run time, so the set this script
 *    measures and the set `tests/setup.ts` gives the budget to cannot drift.
 *    A copy of the pattern would be a second authority and would eventually
 *    disagree with the first one silently.
 *
 * 2. **The metric is per TEST, while the guard is per subprocess CALL.** An
 *    `it()` may make several guarded calls in sequence, so its duration is an
 *    upper bound on any one call inside it. Sizing a per-call guard from a
 *    per-test percentile therefore errs toward a guard that is too generous,
 *    never one that is too tight — and it is the same metric #1950 used, which
 *    is what makes the two numbers comparable at all. That comparability is the
 *    whole point of #1985: the claim under test is "same metric, different
 *    concurrency", not "a better metric".
 *
 * Percentiles are nearest-rank (`ceil(p * n)`, 1-indexed) over the observed
 * samples. No interpolation: with n around 2000 the p99.9 IS the second-slowest
 * sample, and inventing a value between two real ones would only obscure that.
 *
 * Reports may come from different checkouts. Paths are matched from the
 * `tests/` segment onward and resolved against THIS repository, so a report
 * produced in a second worktree classifies against the same sources.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const BUDGET_SOURCE = path.join(REPO, 'tests/helpers/real-shell-budget.ts');

/**
 * Read the family pattern out of the helper rather than restating it.
 *
 * Deliberately strict: if the declaration is ever reshaped the script stops
 * with a message instead of falling back to a guess, because a silent fallback
 * would report a distribution for the wrong set of tests.
 */
export function readRealShellMarkers(source) {
  const match = source.match(/export const REAL_SHELL_MARKERS\s*=\s*\/(.+?)\/([gimsuy]*);/);
  if (!match) {
    throw new Error(
      `could not find "export const REAL_SHELL_MARKERS = /.../" in ${BUDGET_SOURCE}. ` +
        'The pattern is read from there on purpose (single authority); update this reader ' +
        'rather than pasting a copy of the regex here.',
    );
  }
  return new RegExp(match[1], match[2]);
}

/** Nearest-rank percentile over an already-sorted ascending array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The `tests/...` suffix of a path, so reports from other checkouts still map. */
export function repoRelativeTestPath(absolute) {
  const normalized = absolute.split(path.sep).join('/');
  const index = normalized.lastIndexOf('/tests/');
  if (index >= 0) return normalized.slice(index + 1);
  return normalized.startsWith('tests/') ? normalized : null;
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label,
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function formatMs(value) {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function main(argv) {
  const guardArg = argv.find((a) => a.startsWith('--guard='));
  const guardMs = guardArg ? Number(guardArg.slice('--guard='.length)) : null;
  const topArg = argv.find((a) => a.startsWith('--top='));
  const top = topArg ? Number(topArg.slice('--top='.length)) : 15;
  const reports = argv.filter((a) => !a.startsWith('--'));
  if (reports.length === 0) {
    console.error('usage: measure-real-shell-budget.mjs [--guard=MS] [--top=N] report.json...');
    return 2;
  }

  const markers = readRealShellMarkers(readFileSync(BUDGET_SOURCE, 'utf8'));
  const sourceCache = new Map();
  const isFamily = (relative) => {
    if (!sourceCache.has(relative)) {
      let source = '';
      try {
        source = readFileSync(path.join(REPO, relative), 'utf8');
      } catch {
        source = '';
      }
      sourceCache.set(relative, markers.test(source));
    }
    return sourceCache.get(relative);
  };

  const family = [];
  const other = [];
  const rows = [];
  const familyFiles = new Set();
  let unmapped = 0;

  for (const report of reports) {
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    for (const file of parsed.testResults ?? []) {
      const relative = repoRelativeTestPath(file.name ?? '');
      if (relative === null) {
        unmapped += 1;
        continue;
      }
      const member = isFamily(relative);
      if (member) familyFiles.add(relative);
      for (const assertion of file.assertionResults ?? []) {
        const duration = assertion.duration;
        if (typeof duration !== 'number' || Number.isNaN(duration)) continue;
        if (assertion.status !== 'passed' && assertion.status !== 'failed') continue;
        (member ? family : other).push(duration);
        if (member) {
          rows.push({ duration, relative, title: assertion.title, status: assertion.status });
        }
      }
    }
  }

  console.log(`reports        : ${reports.length}`);
  console.log(`family files   : ${familyFiles.size}`);
  if (unmapped > 0) console.log(`unmapped files : ${unmapped}`);
  console.log('');
  console.log('metric: per-TEST duration (an upper bound on any single guarded call inside it)');
  console.log('');
  const table = [summarize('family', family), summarize('non-family', other)];
  console.log('set          n        p50        p90        p99      p99.9        max');
  for (const row of table) {
    console.log(
      row.label.padEnd(12) +
        String(row.n).padStart(6) +
        formatMs(row.p50).padStart(11) +
        formatMs(row.p90).padStart(11) +
        formatMs(row.p99).padStart(11) +
        formatMs(row.p999).padStart(11) +
        formatMs(row.max).padStart(11),
    );
  }

  const familyStats = table[0];
  if (guardMs !== null && familyStats.p999 !== null) {
    console.log('');
    console.log(`guard          : ${guardMs}ms`);
    console.log(`family p99.9   : ${Math.round(familyStats.p999)}ms`);
    console.log(`ratio          : ${(guardMs / familyStats.p999).toFixed(2)}x`);
    const over = family.filter((d) => d >= guardMs).length;
    console.log(`over guard     : ${over} of ${family.length} family tests`);
  }

  if (top > 0 && rows.length > 0) {
    console.log('');
    console.log(`slowest ${top} family tests:`);
    rows
      .sort((a, b) => b.duration - a.duration)
      .slice(0, top)
      .forEach((row) => {
        console.log(
          `  ${formatMs(row.duration).padStart(9)}  ${row.status.padEnd(6)}  ${row.relative} :: ${row.title}`,
        );
      });
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
