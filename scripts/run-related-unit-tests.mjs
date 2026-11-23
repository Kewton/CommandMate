#!/usr/bin/env node
/**
 * Runs unit tests related to changed files in the working tree / branch.
 *
 * Used by `/orchestrate` verify gate `unit-related` (Issue #2639).
 * Runs only tests affected by the diff plus tests that scan repository files:
 * their union once, split into at most 4 groups by recorded duration (LPT) and
 * run at the same time, each group a serial `vitest run <files>` (Issue #4577).
 * Changes outside src/ and tests/ do not switch to the whole unit suite
 * (Issue #4467): CI's Unit Tests runs it for every PR.
 * Excludes metadata files (.commandmate/tasks/, dev-reports/, changelog.d/,
 * CHANGELOG.md, docs/module-reference.md).
 *
 * Usage: node scripts/run-related-unit-tests.mjs --base <ref>
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Collects changed files against base ref using git.
 *
 * @param {{ cwd: string, base: string }} options
 * @returns {{ mergeBase: string, files: string[] }}
 */
export function collectChangedFiles({ cwd, base }) {
  try {
    const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
      cwd,
      encoding: 'utf-8',
    }).trim();

    const diffMerge = execFileSync('git', ['diff', '--name-only', mergeBase, 'HEAD'], {
      cwd,
      encoding: 'utf-8',
    });

    const diffHead = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
    });

    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf-8',
    });

    const set = new Set();
    for (const output of [diffMerge, diffHead, untracked]) {
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          set.add(trimmed);
        }
      }
    }

    const files = Array.from(set).sort();
    return { mergeBase, files };
  } catch (error) {
    const msg = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`collectChangedFiles failed: ${msg}`);
  }
}

/**
 * Classifies file changes into 'none', 'related', or 'full'.
 * 'full' only marks "this used to run the whole suite" (#4467); main() does not run the whole suite.
 *
 * @param {string[]} files
 * @returns {{ mode: 'none' | 'related' | 'full', reason: string | null, considered: string[] }}
 */
export function classifyChanges(files) {
  const considered = [];
  for (const file of files) {
    if (
      file.startsWith('.commandmate/tasks/') ||
      file.startsWith('dev-reports/') ||
      file.startsWith('changelog.d/') ||
      file === 'CHANGELOG.md' ||
      file === 'docs/module-reference.md'
    ) {
      continue;
    }
    considered.push(file);
  }

  if (considered.length === 0) {
    return { mode: 'none', reason: null, considered: [] };
  }

  const srcPattern = /^src\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const testPattern = /^tests\/(unit|helpers)\/.+\.(ts|tsx)$/;

  const unmatched = [];
  for (const file of considered) {
    if (!srcPattern.test(file) && !testPattern.test(file)) {
      unmatched.push(file);
    }
  }

  if (unmatched.length === 0) {
    return { mode: 'related', reason: null, considered };
  }

  const sortedUnmatched = unmatched.slice().sort();
  return { mode: 'full', reason: sortedUnmatched[0], considered };
}

/**
 * Finds unit tests in tests/unit/ that scan repo files.
 *
 * @param {{ root: string }} options
 * @returns {string[]} sorted relative paths
 */
export function findTextScanTests({ root }) {
  const unitDir = path.join(root, 'tests', 'unit');
  if (!fs.existsSync(unitDir)) {
    return [];
  }

  const regexA = /\b(readFileSync|readdirSync|globSync|execSync|execFileSync|spawnSync)\s*\(/;
  const regexB = /['"`](src|\.claude|\.github|\.commandmate|docs|locales|scripts|tests)\/|REPO_ROOT|repoRoot|process\.cwd\(\)|__dirname/;

  const results = [];

  function scan(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx'))
      ) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (regexA.test(content) && regexB.test(content)) {
          const rel = path.relative(root, fullPath).split(path.sep).join('/');
          results.push(rel);
        }
      }
    }
  }

  scan(unitDir);
  return results.sort();
}

/**
 * Changed files `vitest related` can trace through the module graph (#4467).
 */
const TRACEABLE_PATTERN = /^(src|tests|scripts)\/.+\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * Picks the changed files to hand to `vitest related`: traceable code that still
 * exists (a deleted file cannot be resolved).
 *
 * @param {string[]} files
 * @param {string} root
 * @returns {string[]}
 */
export function traceableFiles(files, root) {
  return files.filter((file) => TRACEABLE_PATTERN.test(file) && fs.existsSync(path.join(root, file)));
}

/*
 * Issue #4577: the union of the related set and the text-scan set, run once,
 * split into at most MAX_GROUPS groups by LPT over vitest's recorded file
 * durations. Each group is a plain `vitest run <files>` (serial under the gate's
 * CI=true), all groups at once, each in its own short TMPDIR.
 */

/** Groups run at once. CI runs its unit tests as 4 shards too. */
export const MAX_GROUPS = 4;

/**
 * Base of each group's TMPDIR. Short on purpose: the real-tmux tests put a
 * unix socket about 50 bytes below their own mkdtemp, and macOS allows 104.
 */
export const SHARD_TMP_PREFIX = '/tmp/cms';

const LOG_PREFIX = 'run-related-unit-tests:';

/**
 * @param {string[]} related
 * @param {string[]} textscan
 * @returns {{ files: string[], related: number, textscan: number, overlap: number }}
 */
export function unionSets(related, textscan) {
  const r = new Set(related);
  const t = new Set(textscan);
  let overlap = 0;
  for (const f of t) {
    if (r.has(f)) overlap++;
  }
  const files = Array.from(new Set([...r, ...t])).sort();
  return { files, related: r.size, textscan: t.size, overlap };
}

/**
 * Reads vitest's own results cache (`node_modules/.vite/vitest/<hash>/results.json`)
 * for per-file durations. Never throws: a missing or unreadable cache only means
 * the split falls back to equal weights; it never changes which files run.
 *
 * @param {{ root: string }} options
 * @returns {{ status: 'ok' | 'missing' | 'corrupt', durations: Map<string, number> }}
 */
export function readDurationCache({ root }) {
  /** @type {Map<string, number>} */
  const durations = new Map();
  const base = path.join(root, 'node_modules', '.vite', 'vitest');
  let files = [];
  try {
    files = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name, 'results.json'))
      .filter((f) => fs.existsSync(f));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return { status: 'missing', durations };
  }
  try {
    for (const file of files) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!parsed || typeof parsed.version !== 'string' || !Array.isArray(parsed.results)) {
        throw new Error('unexpected shape');
      }
      for (const entry of parsed.results) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
          throw new Error('unexpected entry');
        }
        const key = entry[0];
        const rel = key.slice(key.indexOf(':') + 1);
        const duration = entry[1] && entry[1].duration;
        if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
          durations.set(rel, Math.max(durations.get(rel) ?? 0, duration));
        }
      }
    }
  } catch {
    return { status: 'corrupt', durations: new Map() };
  }
  return { status: 'ok', durations };
}

/**
 * Longest-processing-time-first: each file, heaviest first, goes to the group
 * with the smallest load so far; between equal loads, to the one with fewer
 * files. A file without a record weighs the median of the recorded files in the
 * set (1 if none is recorded). No group is left empty: an empty group has load 0
 * and 0 files, so it is always a minimum while it exists (weights are >= 0).
 *
 * @param {string[]} files
 * @param {Map<string, number>} durations
 * @param {number} [maxGroups]
 * @returns {{ groups: string[][], expectedMs: number[], defaultWeight: number, known: number }}
 */
export function splitLpt(files, durations, maxGroups = MAX_GROUPS) {
  const recorded = files
    .filter((f) => durations.has(f))
    .map((f) => /** @type {number} */ (durations.get(f)))
    .sort((a, b) => a - b);
  let defaultWeight = 1;
  if (recorded.length > 0) {
    const mid = Math.floor(recorded.length / 2);
    defaultWeight = recorded.length % 2 === 1 ? recorded[mid] : (recorded[mid - 1] + recorded[mid]) / 2;
  }
  const n = Math.min(Math.max(1, maxGroups), files.length);
  /** @type {string[][]} */
  const groups = Array.from({ length: n }, () => []);
  const expectedMs = Array.from({ length: n }, () => 0);
  const weighted = files
    .map((f) => ({ f, w: durations.has(f) ? /** @type {number} */ (durations.get(f)) : defaultWeight }))
    .sort((a, b) => b.w - a.w || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  for (const { f, w } of weighted) {
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (
        expectedMs[i] < expectedMs[best] ||
        (expectedMs[i] === expectedMs[best] && groups[i].length < groups[best].length)
      ) {
        best = i;
      }
    }
    groups[best].push(f);
    expectedMs[best] += w;
  }
  for (const g of groups) g.sort();
  return { groups, expectedMs, defaultWeight, known: recorded.length };
}

/**
 * A path vitest reports, relative to root with '/' separators. vitest reports
 * real paths (/private/var/... on macOS for a root under /var/...).
 *
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 */
function toRootRelative(root, abs) {
  let base = root;
  try {
    const real = fs.realpathSync(root);
    if (abs.startsWith(real + path.sep)) base = real;
  } catch {
    base = root;
  }
  return path.relative(base, abs).split(path.sep).join('/');
}

/**
 * The related set, resolved the way `vitest run --changed` / `vitest related`
 * resolve it, through vitest's Node API (`vitest list` has no `--related`).
 *
 * @param {{
 *   root: string,
 *   mode: 'related' | 'full',
 *   mergeBase: string,
 *   traced: string[],
 *   loadVitest?: () => Promise<any>,
 * }} options
 * @returns {Promise<string[]>} sorted paths relative to root
 */
export async function collectRelatedSet({ root, mode, mergeBase, traced, loadVitest }) {
  if (mode === 'full' && traced.length === 0) {
    return [];
  }
  const { createVitest } = await (loadVitest ?? (() => import('vitest/node')))();
  const options =
    mode === 'related'
      ? { changed: mergeBase }
      : { related: traced.map((f) => path.resolve(root, f)), dir: 'tests/unit' };
  const filters = mode === 'related' ? ['tests/unit'] : [];
  const ctx = await createVitest('test', { root, watch: false, run: true, passWithNoTests: true, ...options });
  try {
    const specs = await ctx.getRelevantTestSpecifications(filters);
    const rel = specs.map((/** @type {{ moduleId: string }} */ s) => toRootRelative(root, s.moduleId));
    return Array.from(new Set(rel)).sort();
  } finally {
    await ctx.close();
  }
}

/**
 * Runs one group, its stdout and stderr into `logPath`.
 *
 * @param {{
 *   cmd: string,
 *   args: string[],
 *   cwd: string,
 *   env: Record<string, string | undefined>,
 *   logPath: string,
 *   onChild?: (child: import('child_process').ChildProcess | null) => void,
 * }} call
 * @returns {Promise<{ code: number | null, signal: string | null, error?: Error }>}
 */
export function runGroupProcess({ cmd, args, cwd, env, logPath, onChild }) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(logPath, 'w');
    } catch (error) {
      resolve({ code: null, signal: null, error: /** @type {Error} */ (error) });
      return;
    }
    let settled = false;
    /** @param {{ code: number | null, signal: string | null, error?: Error }} r */
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      if (onChild) onChild(null);
      resolve(r);
    };
    try {
      // Its own process group: on a signal the gate stops the group's vitest
      // together with its pool workers (a worker outlives a vitest killed alone).
      const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
      if (onChild) onChild(child);
      child.on('error', (error) => done({ code: null, signal: null, error }));
      child.on('close', (code, signal) => done({ code, signal }));
    } catch (error) {
      done({ code: null, signal: null, error: /** @type {Error} */ (error) });
    }
  });
}

/**
 * Reads a group's vitest json report: the files it ran and the failed tests.
 *
 * @param {string} reportPath
 * @param {string} root
 * @returns {{ ran: string[], failed: string[] } | null} null when unreadable
 */
function readGroupReport(reportPath, root) {
  try {
    const json = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (!json || !Array.isArray(json.testResults)) return null;
    const ran = [];
    const failed = [];
    for (const file of json.testResults) {
      const rel = toRootRelative(root, String(file.name));
      ran.push(rel);
      const failedCases = (Array.isArray(file.assertionResults) ? file.assertionResults : []).filter(
        (/** @type {{ status: string }} */ a) => a.status === 'failed'
      );
      for (const a of failedCases) {
        failed.push(`${rel} > ${a.fullName}`);
      }
      if (file.status === 'failed' && failedCases.length === 0) {
        const first = String(file.message ?? '').split('\n')[0];
        failed.push(`${rel} > (file failed${first ? `: ${first}` : ''})`);
      }
    }
    return { ran, failed };
  } catch {
    return null;
  }
}

/**
 * Picks a base for the groups' TMPDIRs: the short SHARD_TMP_PREFIX where /tmp exists.
 *
 * @returns {string}
 */
function defaultTmpBase() {
  return fs.existsSync(path.dirname(SHARD_TMP_PREFIX)) ? SHARD_TMP_PREFIX : path.join(os.tmpdir(), 'cms');
}

/**
 * Entry point for run-related-unit-tests (sharded since Issue #4577).
 *
 * exit 0: every group exited 0 and ran exactly the files it was given.
 * exit 1: any group non-zero, signalled, unspawnable, or ran a different set.
 * exit 2: usage error, or the changed files / the related set could not be collected.
 *
 * @param {string[]} argv
 * @param {{
 *   log?: (msg: string) => void,
 *   out?: (text: string) => void,
 *   root?: string,
 *   baseEnv?: Record<string, string | undefined>,
 *   maxGroups?: number,
 *   tmpBase?: string,
 *   collectChangedFiles?: typeof collectChangedFiles,
 *   findTextScanTests?: typeof findTextScanTests,
 *   collectSet?: typeof collectRelatedSet,
 *   runGroup?: typeof runGroupProcess,
 *   readCache?: typeof readDurationCache,
 *   split?: typeof splitLpt,
 *   mkdtemp?: (prefix: string) => string,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const out = deps.out ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const root = deps.root ?? process.cwd();
  // A copy taken now: createVitest (collectRelatedSet) writes NODE_ENV, MODE,
  // PROD, ... into this process's env, and the groups must not inherit that.
  const baseEnv = { ...(deps.baseEnv ?? process.env) };
  const maxGroups = deps.maxGroups ?? MAX_GROUPS;
  const tmpBase = deps.tmpBase ?? defaultTmpBase();
  const collect = deps.collectChangedFiles ?? collectChangedFiles;
  const findScan = deps.findTextScanTests ?? findTextScanTests;
  const collectSet = deps.collectSet ?? collectRelatedSet;
  const runGroup = deps.runGroup ?? runGroupProcess;
  const readCache = deps.readCache ?? readDurationCache;
  const split = deps.split ?? splitLpt;
  const mkdtemp = deps.mkdtemp ?? ((/** @type {string} */ prefix) => fs.mkdtempSync(prefix));

  if (!(Array.isArray(argv) && argv.length === 2 && argv[0] === '--base' && argv[1])) {
    console.error('Usage: node scripts/run-related-unit-tests.mjs --base <ref>');
    return 2;
  }

  let changed;
  try {
    changed = collect({ cwd: root, base: argv[1] });
  } catch (error) {
    console.error(/** @type {Error} */ (error).message || String(error));
    return 2;
  }

  const { mode, reason, considered } = classifyChanges(changed.files);
  if (mode === 'none') {
    log(`${LOG_PREFIX} mode=none`);
    return 0;
  }

  const textScanTests = findScan({ root });
  const traced = mode === 'full' ? traceableFiles(considered, root) : [];
  if (mode === 'full') {
    log(
      `${LOG_PREFIX} mode=related reason=non-source:${reason} changed=${considered.length} traced=${traced.length} textscan=${textScanTests.length}`
    );
  } else {
    log(`${LOG_PREFIX} mode=related changed=${considered.length} textscan=${textScanTests.length}`);
  }

  let related;
  try {
    related = await collectSet({ root, mode, mergeBase: changed.mergeBase, traced });
  } catch (error) {
    console.error(`${LOG_PREFIX} could not collect the related set: ${/** @type {Error} */ (error).message || String(error)}`);
    return 2;
  }

  const union = unionSets(related, textScanTests);
  log(
    `${LOG_PREFIX} set related=${union.related} textscan=${union.textscan} overlap=${union.overlap} union=${union.files.length}`
  );
  if (union.files.length === 0) {
    log(`${LOG_PREFIX} result exit=0 (nothing to run)`);
    return 0;
  }

  const cache = readCache({ root });
  const plan = split(union.files, cache.durations, maxGroups);
  const n = plan.groups.length;
  log(
    `${LOG_PREFIX} split=lpt groups=${n} cache=${cache.status} known=${plan.known}/${union.files.length} default-weight=${Math.round(plan.defaultWeight)}ms`
  );

  const vitestBin = path.join(root, 'node_modules', '.bin', 'vitest');
  /** @type {string[]} */
  const tempDirs = [];
  /** @type {Set<import('child_process').ChildProcess>} */
  const children = new Set();
  const cleanup = () => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  // A gate that times out or is cancelled sends SIGTERM (then SIGKILL). Node's
  // default SIGTERM skips `finally`: stop the groups, remove the temp dirs, then
  // die of the same signal.
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    cleanup();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    process.kill(process.pid, signal);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    // Every temp dir exists before any group starts: a failure here starts none.
    let workDir;
    /** @type {(string | null)[]} */
    const groupTmps = [];
    try {
      workDir = mkdtemp(path.join(os.tmpdir(), 'cm-related-shards-'));
      tempDirs.push(workDir);
      for (const files of plan.groups) {
        if (files.length === 0) {
          groupTmps.push(null);
          continue;
        }
        const tmp = mkdtemp(tmpBase);
        tempDirs.push(tmp);
        groupTmps.push(tmp);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} could not create the temp dirs: ${/** @type {Error} */ (error).message || String(error)}`);
      return 2;
    }
    const work = /** @type {string} */ (workDir);

    const runs = plan.groups.map(async (files, i) => {
      const reportPath = path.join(work, `group-${i + 1}.json`);
      const logPath = path.join(work, `group-${i + 1}.log`);
      const tmp = groupTmps[i];
      if (tmp === null) {
        // An empty group would be `vitest run` with no files: the whole suite.
        return { files, reportPath, logPath, outcome: null, seconds: 0 };
      }
      const args = ['run', ...files, '--passWithNoTests', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`];
      const env = { ...baseEnv, NODE_ENV: 'test', TMPDIR: tmp };
      const started = Date.now();
      /** @type {import('child_process').ChildProcess | null} */
      let mine = null;
      const onChild = (/** @type {import('child_process').ChildProcess | null} */ child) => {
        if (child) {
          mine = child;
          children.add(child);
        } else if (mine) {
          children.delete(mine);
        }
      };
      const outcome = await runGroup({ cmd: vitestBin, args, cwd: root, env, logPath, onChild });
      return { files, reportPath, logPath, outcome, seconds: (Date.now() - started) / 1000 };
    });
    const results = await Promise.all(runs);

    let failedAny = false;
    /** @type {string[]} */
    const failedTests = [];
    /** @type {string[]} */
    const groupLines = [];
    results.forEach((r, i) => {
      if (r.outcome === null) {
        groupLines.push(`${LOG_PREFIX} group ${i + 1}/${n} files=0 skipped`);
        return;
      }
      let text = '';
      try {
        text = fs.readFileSync(r.logPath, 'utf-8');
      } catch {
        text = '(no output)\n';
      }
      out(`--- ${LOG_PREFIX} group ${i + 1}/${n} ---\n${text}${text.endsWith('\n') ? '' : '\n'}`);

      const report = readGroupReport(r.reportPath, root);
      const ran = report ? report.ran : [];
      const expected = new Set(r.files);
      const ranSet = new Set(ran);
      const missing = r.files.filter((f) => !ranSet.has(f));
      const extra = ran.filter((f) => !expected.has(f));
      const { code, signal, error } = r.outcome;
      const exitStr = error ? `spawn-error(${error.message})` : signal ? `signal(${signal})` : String(code);
      const ok = !error && !signal && code === 0 && report !== null && missing.length === 0 && extra.length === 0;
      if (!ok) failedAny = true;
      const expectedStr = cache.status === 'ok' && plan.known > 0 ? `${(plan.expectedMs[i] / 1000).toFixed(1)}s` : '-';
      let line = `${LOG_PREFIX} group ${i + 1}/${n} files=${r.files.length} expected=${expectedStr} actual=${r.seconds.toFixed(1)}s ran=${report ? ran.length : 'no-report'} exit=${exitStr}`;
      if (missing.length > 0) line += ` missing=${missing.length}(${missing.slice(0, 3).join(',')})`;
      if (extra.length > 0) line += ` extra=${extra.length}(${extra.slice(0, 3).join(',')})`;
      groupLines.push(line);
      if (report) failedTests.push(...report.failed);
    });

    for (const line of groupLines) log(line);
    for (const name of failedTests) log(`${LOG_PREFIX} failed ${name}`);
    const code = failedAny ? 1 : 0;
    log(`${LOG_PREFIX} result exit=${code} groups=${n} union=${union.files.length}`);
    return code;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    cleanup();
  }
}

/**
 * Ends the process once stdout and stderr have handed everything to the OS. A
 * bare process.exit right after large writes to a pipe drops what is past the
 * pipe's 64 KB on macOS (stdout to a pipe is asynchronous there).
 *
 * @param {number} code
 */
function exitAfterFlush(code) {
  process.exitCode = code;
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (exitCode) => exitAfterFlush(exitCode),
    (error) => {
      console.error(error);
      exitAfterFlush(2);
    }
  );
}
