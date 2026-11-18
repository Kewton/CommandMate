#!/usr/bin/env node
/**
 * Measures the two numbers of design §2.3.5 (Issue #4432 PR3):
 *
 *   (1) key hit rate — of the B2-target verify runs in the run-log, the share
 *       whose merge-base table could be used (threshold 80%)
 *   (2) f — Σ duration of the selected tests ÷ Σ duration of all tests, over
 *       the runs that hit (threshold 0.5)
 *
 * Inputs: the run-log (workspace/orchestration/runs/<day>/run-*.jsonl), the
 * tables downloaded from the read-trace CI artifacts, and the verify side's
 * gate-env (`node scripts/read-trace/gate-env.mjs` on the verify machine).
 *
 * Measurement only: it prints numbers. No gate reads its output, and it never
 * changes a selection, a verdict or a ruling.
 *
 * f leaves out (i) of §2.3.2 (the current `related` selection for the branch's
 * code changes) because that needs vitest's graph at each HEAD. It is printed
 * as `fLowerBound` — the real f is at least this large — and no threshold is
 * judged on it (`fMet: null`): a lower bound under 0.5 says nothing about the
 * real f.
 *
 * Diagnostics (never part of the hit / miss judgment, which stays the exact,
 * fail-closed lookup): the miss reasons, which gate-env fields differed and how
 * often, and whether the verify-side gate-env was taken without `CI=true`.
 *
 * Usage:
 *   node scripts/read-trace/measure.mjs --tables <dir> --verify-gate-env <file> \
 *     [--base origin/develop] [--root <repo>] <run-*.jsonl>...
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeF, isB2DataFile, lookupHit, readerKey, selectTests } from './table.mjs';

export const HIT_RATE_THRESHOLD = 0.8;
export const F_THRESHOLD = 0.5;
export const F_LOWER_BOUND_NOTE =
  'lower bound: excludes (i) the related selection for the branch code changes; no threshold is judged';

const SRC_PATTERN = /^src\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_PATTERN = /^tests\/(unit|helpers)\/.+\.(ts|tsx)$/;
const EXCLUDED = (f) =>
  f.startsWith('.commandmate/tasks/') ||
  f.startsWith('dev-reports/') ||
  f.startsWith('changelog.d/') ||
  f === 'CHANGELOG.md' ||
  f === 'docs/module-reference.md';

/**
 * A verify line whose `unit-related` gate actually ran (not `:SKIP`).
 */
export function isUnitRelatedRun(line) {
  if (!line || line.stage !== 'verify' || typeof line.head !== 'string' || typeof line.note !== 'string') return false;
  const gates = [];
  for (const m of line.note.matchAll(/\b(?:passed|failed)=(\S+)/g)) gates.push(...m[1].split(','));
  return gates.some((g) => g.split(/[@:]/)[0] === 'unit-related' && !g.endsWith(':SKIP'));
}

/**
 * The B2 target: the current classification is `full`, and every file that made
 * it full is a data file (`*.md`, `locales/**`, integration / e2e tests).
 */
export function isB2Target(changedFiles) {
  const considered = changedFiles.filter((f) => !EXCLUDED(f));
  const unmatched = considered.filter((f) => !SRC_PATTERN.test(f) && !TEST_PATTERN.test(f));
  return unmatched.length > 0 && unmatched.every(isB2DataFile);
}

/**
 * @param {{
 *   lines: object[],
 *   facts: (head: string) => { mergeBase: string, changedFiles: string[] } | null,
 *   keyOf: (commit: string) => string,
 *   tables: Map<string, unknown>,
 *   verifyGateEnv: object,
 * }} input
 */
export function measureRuns(input) {
  const runs = [];
  let selectedMs = 0;
  let totalMs = 0;
  for (const line of input.lines) {
    if (!isUnitRelatedRun(line)) continue;
    const facts = input.facts(line.head);
    if (!facts || !isB2Target(facts.changedFiles)) continue;
    let expectedKey = '';
    try {
      expectedKey = input.keyOf(facts.mergeBase);
    } catch {
      expectedKey = '';
    }
    const table = input.tables.get(facts.mergeBase);
    const lookup = lookupHit({ table, expectedKey, gateEnv: input.verifyGateEnv });
    const run = { at: line.at ?? null, issue: line.issue ?? null, head: line.head, mergeBase: facts.mergeBase, ...lookup };
    if (lookup.hit) {
      const r = computeF(table, selectTests({ table, changedFiles: facts.changedFiles }));
      run.fLowerBound = r.f;
      selectedMs += r.selectedMs;
      totalMs += r.totalMs;
    }
    runs.push(run);
  }
  const hits = runs.filter((r) => r.hit).length;
  const hitRate = runs.length > 0 ? hits / runs.length : null;
  const fLowerBound = totalMs > 0 ? selectedMs / totalMs : null;
  const reasons = {};
  const gateEnvFieldDiffs = {};
  for (const r of runs) {
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    for (const field of r.diffs ?? []) gateEnvFieldDiffs[field] = (gateEnvFieldDiffs[field] ?? 0) + 1;
  }
  const verifyCi = input.verifyGateEnv && typeof input.verifyGateEnv === 'object' ? input.verifyGateEnv.ci : undefined;
  return {
    targets: runs.length,
    hits,
    hitRate,
    hitRateThreshold: HIT_RATE_THRESHOLD,
    hitRateMet: hitRate !== null && hitRate >= HIT_RATE_THRESHOLD,
    fLowerBound,
    fThreshold: F_THRESHOLD,
    fMet: null,
    fNote: F_LOWER_BOUND_NOTE,
    fExcludesCodeRelated: true,
    reasons,
    diagnostics: {
      usedForJudgment: false,
      missReasons: Object.fromEntries(Object.entries(reasons).filter(([k]) => k !== 'hit')),
      gateEnvFieldDiffs,
      verifyGateEnvCi:
        verifyCi === true
          ? 'ci:true'
          : verifyCi === false
            ? 'ci:false (taken without CI=true; never matches a table built with CI=true)'
            : 'missing',
    },
    runs,
  };
}

export function loadTables(dir) {
  const tables = new Map();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.json')) {
        try {
          const t = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (t && typeof t.commit === 'string') tables.set(t.commit, t);
        } catch {
          // unreadable: the run that would have used it counts as no-table
        }
      }
    }
  };
  walk(dir);
  return tables;
}

export function readRunLog(files) {
  const lines = [];
  for (const file of files) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {
        // a torn line is not a run
      }
    }
  }
  return lines;
}

function parseArgs(argv) {
  const out = { files: [], base: 'origin/develop', root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tables') out.tables = argv[++i];
    else if (a === '--verify-gate-env') out.gateEnv = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else out.files.push(a);
  }
  if (!out.tables || !out.gateEnv || out.files.length === 0) {
    throw new Error('usage: measure.mjs --tables <dir> --verify-gate-env <file> [--base <ref>] [--root <repo>] <run-*.jsonl>...');
  }
  return out;
}

export function main(argv) {
  const args = parseArgs(argv);
  const runGit = (gitArgs) => execFileSync('git', gitArgs, { cwd: args.root, encoding: 'utf8' });
  const facts = (head) => {
    try {
      const mergeBase = runGit(['merge-base', head, args.base]).trim();
      const changedFiles = runGit(['diff', '--name-only', `${mergeBase}..${head}`]).split('\n').filter(Boolean);
      return { mergeBase, changedFiles };
    } catch {
      return null;
    }
  };
  const result = measureRuns({
    lines: readRunLog(args.files),
    facts,
    keyOf: (commit) => readerKey(commit, { runGit }),
    tables: loadTables(args.tables),
    verifyGateEnv: JSON.parse(fs.readFileSync(args.gateEnv, 'utf8')),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
