/**
 * The read table for B2 (Issue #4432 PR3, design §2.3.2・§2.3.3・§2.3.5).
 *
 * Measurement only. Nothing in run-related-unit-tests / precheck / merge-pr /
 * wait-verify reads this module or its output; the numbers it produces (key hit
 * rate, f) are written to the design doc by a human and decide whether PR4 is
 * built at all.
 *
 * Every lookup is fail-closed: no table, an unreadable table, a different
 * version, a different reader key, or a different gate-env is a miss.
 */

import crypto from 'node:crypto';
import { compareGateEnv } from './gate-env.mjs';

export const TABLE_VERSION = 1;

/** The reader tree of the merge-base key (design appendix C, `keyhit`). */
export const READER_PATHS = ['package-lock.json', 'scripts', 'src', 'tests', 'vitest.config.ts'];

/** Always selected by the composite selection, (iv) of §2.3.2. */
export const ALWAYS_SELECTED_PREFIXES = ['tests/unit/guards/', 'tests/unit/docs/'];

/** fs operations that look at a directory's entries rather than one file. */
const DIRECTORY_OP = /(readdir|opendir|glob|watch|cp|rm)/i;

/**
 * Reader key of a commit: hash of `git rev-parse <commit>:<path>` for every
 * reader path. A path that does not exist contributes `missing`.
 *
 * @param {string} commit
 * @param {{ runGit: (args: string[]) => string }} deps  throws on non-zero exit
 */
export function readerKey(commit, { runGit }) {
  const lines = READER_PATHS.map((p) => {
    let object = 'missing';
    try {
      object = runGit(['rev-parse', `${commit}:${p}`]).trim() || 'missing';
    } catch {
      object = 'missing';
    }
    return `${p}=${object}`;
  });
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A data-file change that B2 would no longer send to the full suite. */
export function isB2DataFile(file) {
  return /\.md$/.test(file) || file.startsWith('locales/') || /^tests\/(integration|e2e)\//.test(file);
}

function toRepoRelative(name, repoRoot) {
  const normRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normName = name.replace(/\\/g, '/');
  return normName.startsWith(`${normRoot}/`) ? normName.slice(normRoot.length + 1) : normName;
}

/**
 * Builds the table from the tracer records and the vitest JSON report.
 *
 * Opaque (always selected) when: any child process (M5) / worker thread (M6),
 * any test in the file not `passed` or the file not `passed` (M7), the file in
 * the report but with no trace, or the file traced but absent from the report.
 *
 * @param {{
 *   commit: string, key: string, gateEnv: object,
 *   traces: Array<{ testPath: string | null, reads: Record<string, string[]>, children: unknown[], workers: number }>,
 *   report: { testResults?: Array<{ name: string, status: string, startTime?: number, endTime?: number, assertionResults?: Array<{ status: string }> }> },
 *   repoRoot: string,
 * }} input
 */
export function buildTable(input) {
  /** @type {Record<string, { reads: Record<string, string[]>, durationMs: number, opaque: boolean, reasons: string[], traced?: boolean, reported?: boolean }>} */
  const files = {};
  const entry = (testPath) => {
    files[testPath] ??= { reads: {}, durationMs: 0, opaque: false, reasons: [], traced: false, reported: false };
    return files[testPath];
  };
  const addReason = (e, reason) => {
    e.opaque = true;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
  };

  for (const trace of input.traces) {
    if (!trace || typeof trace.testPath !== 'string') continue;
    const e = entry(trace.testPath);
    e.traced = true;
    for (const [p, ops] of Object.entries(trace.reads ?? {})) {
      e.reads[p] = [...new Set([...(e.reads[p] ?? []), ...ops])].sort();
    }
    if ((trace.children ?? []).length > 0) addReason(e, 'child-process');
    if ((trace.workers ?? 0) > 0) addReason(e, 'worker-thread');
  }

  for (const result of input.report.testResults ?? []) {
    const e = entry(toRepoRelative(result.name, input.repoRoot));
    e.reported = true;
    const start = Number(result.startTime);
    const end = Number(result.endTime);
    e.durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
    const assertions = result.assertionResults ?? [];
    if (result.status !== 'passed' || assertions.length === 0 || assertions.some((a) => a.status !== 'passed')) {
      addReason(e, 'not-passed');
    }
  }

  for (const e of Object.values(files)) {
    if (!e.traced) addReason(e, 'no-trace');
    if (!e.reported) addReason(e, 'not-reported');
    delete e.traced;
    delete e.reported;
  }

  return { version: TABLE_VERSION, commit: input.commit, key: input.key, gateEnv: input.gateEnv, files };
}

/**
 * Whether `table` can be used for a run whose merge-base reader key is
 * `expectedKey` and whose verify side ran under `gateEnv`.
 *
 * @returns {{ hit: boolean, reason: 'hit' | 'no-table' | 'unreadable' | 'version' | 'key-mismatch' | 'gate-env-mismatch', diffs?: string[] }}
 */
export function lookupHit({ table, expectedKey, gateEnv }) {
  try {
    if (table === undefined || table === null) return { hit: false, reason: 'no-table' };
    if (typeof table !== 'object' || typeof table.files !== 'object' || table.files === null) {
      return { hit: false, reason: 'unreadable' };
    }
    if (table.version !== TABLE_VERSION) return { hit: false, reason: 'version' };
    if (typeof expectedKey !== 'string' || expectedKey === '' || table.key !== expectedKey) {
      return { hit: false, reason: 'key-mismatch' };
    }
    const env = compareGateEnv(table.gateEnv, gateEnv);
    if (!env.same) return { hit: false, reason: 'gate-env-mismatch', diffs: env.diffs };
    return { hit: true, reason: 'hit' };
  } catch {
    return { hit: false, reason: 'unreadable' };
  }
}

function ancestorsOf(file) {
  const parts = file.split('/');
  const out = ['.'];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * The composite selection (ii)–(iv) of §2.3.2 over a table that already hit.
 * (i) — the current `related` selection for the branch's code changes — needs
 * vitest's graph and is passed in as `relatedTests` when it is known.
 *
 * A test is selected when it: touched a changed data file (any fs op), ran a
 * directory op on an ancestor of one (new / deleted / renamed files, M8), is
 * opaque, changed itself, sits under tests/unit/guards or tests/unit/docs, or
 * is in `relatedTests`.
 *
 * @param {{ table: object, changedFiles: string[], relatedTests?: string[] }} input
 * @returns {Set<string>}
 */
export function selectTests({ table, changedFiles, relatedTests = [] }) {
  const selected = new Set();
  const dataFiles = changedFiles.filter(isB2DataFile);
  const ancestorDirs = new Set(dataFiles.flatMap(ancestorsOf));
  for (const [testPath, e] of Object.entries(table.files)) {
    if (e.opaque) {
      selected.add(testPath);
      continue;
    }
    if (changedFiles.includes(testPath) || ALWAYS_SELECTED_PREFIXES.some((p) => testPath.startsWith(p))) {
      selected.add(testPath);
      continue;
    }
    for (const [readPath, ops] of Object.entries(e.reads)) {
      if (dataFiles.includes(readPath) || (ancestorDirs.has(readPath) && ops.some((op) => DIRECTORY_OP.test(op)))) {
        selected.add(testPath);
        break;
      }
    }
  }
  for (const t of relatedTests) selected.add(t);
  return selected;
}

/**
 * f = Σ duration(selected) ÷ Σ duration(all) over the table's files.
 *
 * @returns {{ f: number | null, selectedMs: number, totalMs: number, selectedCount: number, totalCount: number }}
 */
export function computeF(table, selected) {
  let selectedMs = 0;
  let totalMs = 0;
  let selectedCount = 0;
  const entries = Object.entries(table.files);
  for (const [testPath, e] of entries) {
    totalMs += e.durationMs;
    if (selected.has(testPath)) {
      selectedMs += e.durationMs;
      selectedCount += 1;
    }
  }
  return { f: totalMs > 0 ? selectedMs / totalMs : null, selectedMs, totalMs, selectedCount, totalCount: entries.length };
}
