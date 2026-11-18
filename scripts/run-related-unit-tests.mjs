#!/usr/bin/env node
/**
 * Runs unit tests related to changed files in the working tree / branch.
 *
 * Used by `/orchestrate` verify gate `unit-related` (Issue #2639).
 * Runs only tests affected by the diff plus tests that scan repository files.
 * Changes outside src/ and tests/ do not switch to the whole unit suite
 * (Issue #4467): CI's Unit Tests runs it for every PR.
 * Excludes metadata files (.commandmate/tasks/, dev-reports/, changelog.d/,
 * CHANGELOG.md, docs/module-reference.md).
 *
 * Usage: node scripts/run-related-unit-tests.mjs --base <ref>
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
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

/**
 * Default runner for child processes.
 */
export function defaultRun(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (res.error) {
    throw res.error;
  }
  return res.status ?? 1;
}

/**
 * Entry point for run-related-unit-tests.
 *
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun,
 *   log?: typeof console.log,
 *   root?: string,
 *   collectChangedFiles?: typeof collectChangedFiles,
 *   findTextScanTests?: typeof findTextScanTests,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const {
    run = defaultRun,
    log = console.log,
    root = process.cwd(),
  } = deps;
  const collect = deps.collectChangedFiles ?? deps.collectFiles ?? collectChangedFiles;
  const findScan = deps.findTextScanTests ?? deps.findScan ?? findTextScanTests;

  let base = null;
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--base' && argv[1]) {
    base = argv[1];
  } else {
    console.error('Usage: node scripts/run-related-unit-tests.mjs --base <ref>');
    return 2;
  }

  let changed;
  try {
    changed = collect({ cwd: root, base });
  } catch (error) {
    console.error(error.message || String(error));
    return 2;
  }

  const { mode, reason, considered } = classifyChanges(changed.files);

  if (mode === 'none') {
    log('run-related-unit-tests: mode=none');
    return 0;
  }

  const textScanTests = findScan({ root });
  const vitestBin = path.join(root, 'node_modules', '.bin', 'vitest');
  const env = { ...process.env, NODE_ENV: 'test' };

  let code1 = 0;
  let exit1Str;
  if (mode === 'full') {
    // A change outside src/ and tests/ (#4467): the whole unit suite is CI's job.
    // Run the tests the traceable files reach, plus every text-scan test.
    const traced = traceableFiles(considered, root);
    log(
      `run-related-unit-tests: mode=related reason=non-source:${reason} changed=${considered.length} traced=${traced.length} textscan=${textScanTests.length}`
    );
    exit1Str = 'skipped';
    if (traced.length > 0) {
      code1 = run(
        vitestBin,
        ['related', '--run', '--dir', 'tests/unit', ...traced, '--passWithNoTests'],
        { cwd: root, env }
      );
      exit1Str = String(code1);
    }
  } else {
    // mode === 'related'
    log(`run-related-unit-tests: mode=related changed=${considered.length} textscan=${textScanTests.length}`);
    code1 = run(
      vitestBin,
      ['run', 'tests/unit', '--changed', changed.mergeBase, '--passWithNoTests'],
      { cwd: root, env }
    );
    exit1Str = String(code1);
  }

  let code2 = 0;
  let exit2Str = 'skipped';
  if (textScanTests.length > 0) {
    code2 = run(vitestBin, ['run', ...textScanTests], { cwd: root, env });
    exit2Str = String(code2);
  }

  log(`run-related-unit-tests: related exit=${exit1Str} textscan exit=${exit2Str}`);

  const success = code1 === 0 && (exit2Str === 'skipped' || code2 === 0);
  return success ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const exitCode = main(process.argv.slice(2));
  process.exit(exitCode);
}
