#!/usr/bin/env node
/**
 * `/orchestrate` 6-1-1: the fast local check before a PR, recorded per HEAD
 * (Issue #3477).
 *
 * It reads only — nothing is pushed or written outside the run directory. The
 * steps, each skipped when it cannot apply:
 *   changelog      node scripts/changelog-fragments.mjs check
 *   removed-tests  it / test / describe lines the branch removes (2-4-2 forbids it)
 *   eslint         ESLint on the changed .js/.ts files
 *   lint-sh        node scripts/run-lint-sh-if-changed.mjs (only when a .sh changed, #3478)
 *   suppressions   node scripts/count-suppressions.mjs (refactor / metrics Issues only, #3483)
 *   tsc            npx tsc --noEmit
 *   build          npm run build        ┐ only with --build: the three steps of CI's `Build` job
 *   build-cli      npm run build:cli    │ (.github/workflows/ci-pr.yml), so build / build-cli /
 *   build-server   npm run build:server ┘ build-server all ok stands in for it (6-2 / 6-3)
 *   related        npx vitest related --run --dir tests/unit <changed src/scripts code>
 *   tests          npx vitest run <changed tests> <tests naming a changed path> tests/unit/guards tests/unit/docs
 *
 * A wide `related` / `tests` step runs under the machine-wide `cpu.heavy` lock
 * the verify gates `unit` / `integration` / `unit-related` hold (Issue #3884
 * H-10), so it does not run beside another worktree's suite and flip a verdict
 * by load. A narrow one does not: the guards and docs alone never take the lock
 * (HEAVY_TEST_FILES / HEAVY_RELATED_SOURCES). The lock wait is recorded apart
 * from the execution (`mutexSec` / `runSec` of the record). A lock that stays
 * held for the whole budget leaves the step unrun and the precheck undecided
 * (`<step>=held`, result `skip`, exit 3) — neither ok nor a failed test, and
 * worth running again once the machine is quieter.
 *
 * The result goes to the `precheck` stage of `run-log.mjs` with the HEAD it
 * ran on. An `ok` precheck for the same HEAD and the same options (base, kind,
 * metrics, allow-removed-tests, build) is reused instead of run again — every
 * step reads only the committed tree (a dirty tree is refused) and the options.
 * A step the `verify` stage already passed on that HEAD is not run twice only
 * where the two are the same check on the same tree: verify.yaml's `lint`
 * covers eslint, `typecheck` tsc, `lint-sh` lint-sh. A gate the contract
 * defined (`<id>@contract`) covers nothing, and no test gate covers the test
 * steps (`unit-related` selects tests differently, so its pass says nothing
 * about the guards or the tests naming a changed path).
 *
 * One Issue can carry several PRs: `--item <work item>` (#3883) reads and
 * writes that work item's records only (run-log.mjs inItem; without it the
 * Issue's own records), and the log is that work item's next free
 * `precheck-<issue>[-<item>]-<short>[.a<n>].log` — a rerun on the same HEAD
 * does not overwrite the log of the run before.
 *
 * Exit code: 0 ok (or reused), 1 a step failed, 2 usage error or a dirty tree
 * (the result would not belong to HEAD), 3 held: a heavy step could not take
 * cpu.heavy within HEAVY_LOCK_TIMEOUT_SEC and was not run (EXIT_HELD; retry).
 *
 * Usage:
 *   node scripts/orchestrate/precheck.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--base origin/develop] [--kind <feature|bug|refactor|docs>] [--metrics] [--build] [--allow-removed-tests] [--force]
 *        [--item <work item>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, readRecords } from './run-log.mjs';
import { itemOption, workHeadOf } from './pr-common.mjs';
import { dirtyPaths } from './dirty-tree.mjs';
import { allocateLog, executionKey, workItemName } from './execution-key.mjs';
import { diffManifest, manifestHash, takeManifest, verifyEnvState } from './env-manifest.mjs';

export const DEFAULT_BASE = 'origin/develop';
/**
 * The exit code of a precheck a heavy step could not run in (Issue #3884 N1):
 * cpu.heavy stayed held for the whole budget. Not a verdict — the same as the
 * verify gate a mutex wait skips (gate-runner.ts mutexWaitTimeoutLog).
 */
export const EXIT_HELD = 3;
/** The step status of a heavy step left unrun for want of the lock. */
export const HELD = 'held';
/** Run order: cheap and decisive first, the test runs last. */
export const STEPS = ['changelog', 'removed-tests', 'eslint', 'lint-sh', 'suppressions', 'tsc', 'related', 'tests'];
/** The verify-stage gate whose pass on the same HEAD already covers a step. */
export const COVERED_BY_GATE = {
  eslint: ['lint'],
  tsc: ['typecheck'],
  'lint-sh': ['lint-sh'],
};
/**
 * Run only when asked (`--build`); the PR's CI Build is the default judge (6-2 / 6-3).
 * They are the steps of CI's `Build` job, one for one: a pass of `npm run build`
 * alone says nothing about the CLI or the server build, so all three are needed
 * before merge-pr.mjs stops waiting for `Build`.
 */
export const BUILD_STEPS = ['build', 'build-cli', 'build-server'];
export const OPTIONAL_STEPS = [...BUILD_STEPS];
/** Always part of the test step (2-4-2: the guards are never left out). */
export const ALWAYS_TESTS = ['tests/unit/guards', 'tests/unit/docs'];
/**
 * The machine-wide lock a wide test step takes (Issue #3884 H-10): the
 * `mutex` of verify.yaml's `unit` / `integration` and of the contract gate
 * `unit-related` (contract.mjs UNIT_RELATED_GATE), at the path both runners
 * use (`<CM_VERIFY_LOCK_ROOT or ~/.commandmate/locks>/<name>.lock`,
 * src/lib/verification/machine-lock.ts).
 */
export const HEAVY_MUTEX = 'cpu.heavy';
/**
 * A test step is heavy from this many test files on, the guards and docs not
 * counted (they run in every precheck and stay outside the lock). 50 is about
 * 2% of tests/unit (2436 files on 2026-10-25) and close to the 58 files of
 * tests/unit/guards + tests/unit/docs that have always run unlocked without a
 * load-flipped verdict on record — so a step under it adds no more than that
 * already-accepted load, and one over it is a slice of the suite worth
 * serializing.
 */
export const HEAVY_TEST_FILES = 50;
/**
 * `vitest related` is heavy from this many changed sources on, whatever the
 * estimate says: the estimate (estimateRelatedTests) follows the static import
 * graph, and a change across 20 modules is wide whatever the graph misses
 * (a path built at run time, a setup file).
 */
export const HEAVY_RELATED_SOURCES = 20;
/** The wait budget: the `timeoutSec` of the `unit` gate the lock is shared with (verify.yaml). */
export const HEAVY_LOCK_TIMEOUT_SEC = 5400;
const LOCK_POLL_MS = 250;
const CODE_FILE = /\.(?:[cm]?js|jsx|tsx?)$/;
const TEST_FILE = /^tests\/unit\/.+\.test\.tsx?$/;
const RELATED_SOURCE = /^(?:src|scripts)\/.+\.(?:[cm]?js|jsx|tsx?)$/;
const TEST_CALL = /^\s*(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^)]*\))?)*\s*\(/;

function defaultRun(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Test files under `tests/unit` whose text names one of `paths` (repo-relative). */
export function findTestsNaming(worktree, paths) {
  const root = path.join(worktree, 'tests', 'unit');
  if (paths.length === 0 || !fs.existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (paths.some((p) => text.includes(p))) found.push(path.relative(worktree, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The import specifier a test names a changed source by: `@/lib/x` for src/lib/x.ts, `scripts/x` for scripts/x.mjs. */
function sourceSpecifiers(file) {
  const bare = file.replace(/\.(?:[cm]?js|jsx|tsx?)$/, '');
  const specifiers = [file, bare.startsWith('src/') ? `@/${bare.slice('src/'.length)}` : bare];
  // `@/lib/db` imports src/lib/db/index.ts.
  if (/\/index$/.test(bare)) specifiers.push(specifiers[1].replace(/\/index$/, ''));
  return specifiers;
}

/** Where the import graph of estimateRelatedTests is read: the code a unit test can reach. */
const GRAPH_ROOTS = ['src', 'scripts', 'tests'];
const GRAPH_SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'e2e', 'fixtures']);
/** A static or dynamic module reference: `from '…'`, `import '…'`, `import('…')`, `require('…')`, `vi.mock('…')`. */
const MODULE_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
/** The tsconfig `paths` (and vitest `alias`) of this repository. */
const PATH_ALIASES = [
  ['@/', 'src/'],
  ['@tests/', 'tests/'],
];

/** Every code file under GRAPH_ROOTS, repo-relative with `/`. */
function listGraphFiles(worktree) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!GRAPH_SKIP_DIRS.has(entry.name)) walk(full);
      } else if (CODE_FILE.test(entry.name)) files.push(path.relative(worktree, full).split(path.sep).join('/'));
    }
  };
  for (const root of GRAPH_ROOTS) walk(path.join(worktree, root));
  return files;
}

/** The repo file `specifier` (written in `from`) names, or null for a package or a file outside the graph. */
function resolveModule(from, specifier, known) {
  let target = null;
  for (const [alias, dir] of PATH_ALIASES) {
    if (specifier.startsWith(alias)) target = dir + specifier.slice(alias.length);
  }
  if (target === null && specifier.startsWith('.')) target = path.posix.join(path.posix.dirname(from), specifier);
  if (target === null) return null;
  target = path.posix.normalize(target.split('?')[0]);
  // ESM TypeScript names `./x.js` for x.ts.
  const stems = [target, target.replace(/\.(?:[cm]?js|jsx)$/, '')];
  for (const stem of stems) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (known.has(stem + suffix)) return stem + suffix;
    }
  }
  return null;
}

/**
 * How many unit test files `vitest related` will run for `sources` (Issue #3884
 * H-10 / N2). `vitest related` follows the import graph transitively, so a test
 * reaching a source through another module counts: a change to a module every
 * logger user imports is as wide as the logger's users, however few tests name
 * the module itself. The graph is the static and dynamic module references of
 * src / scripts / tests (aliases `@/` and `@tests/`, relative paths), resolved
 * to files; a test that names a source only by path in its text (a fixture, a
 * `vi.mock` of a path the graph cannot resolve) is counted too. Erring wide is
 * the safe side — a step counted heavy only waits for the lock it should share.
 */
export function estimateRelatedTests(worktree, sources) {
  const root = path.join(worktree, 'tests', 'unit');
  if (sources.length === 0 || !fs.existsSync(root)) return 0;
  const files = listGraphFiles(worktree);
  const known = new Set(files);
  /** @type {Map<string, Set<string>>} module -> the files referencing it */
  const importers = new Map();
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(worktree, file), 'utf8');
    } catch {
      continue;
    }
    texts.set(file, text);
    for (const match of text.matchAll(MODULE_REFERENCE)) {
      const target = resolveModule(file, match[2], known);
      if (target === null || target === file) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  const isUnitTest = (file) => TEST_FILE.test(file);
  const reached = new Set(sources);
  const queue = [...sources];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const importer of importers.get(current) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  const tests = new Set([...reached].filter((file) => isUnitTest(file) && !sources.includes(file)));
  // The tests naming a source by path or import specifier as a whole module name
  // (`@/lib/db` must not count a test of `@/lib/dbx` or `@/lib/db/x`).
  const specifiers = sources.flatMap(sourceSpecifiers);
  const pattern = new RegExp(
    `(?:${specifiers.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w/-])`
  );
  for (const [file, text] of texts) {
    if (isUnitTest(file) && pattern.test(text)) tests.add(file);
  }
  return tests.size;
}

/**
 * `it(` / `test(` / `describe(` lines the diff removes and does not add back
 * verbatim elsewhere (a moved test cancels out; a renamed one counts).
 */
export function countRemovedTests(diffText) {
  const added = new Map();
  const removed = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+') && TEST_CALL.test(line.slice(1))) {
      const key = line.slice(1).trim();
      added.set(key, (added.get(key) ?? 0) + 1);
    } else if (line.startsWith('-') && TEST_CALL.test(line.slice(1))) {
      removed.push(line.slice(1).trim());
    }
  }
  return removed.filter((key) => {
    const left = added.get(key) ?? 0;
    if (left === 0) return true;
    added.set(key, left - 1);
    return false;
  });
}

/**
 * Which steps run, and with what. Pure: the inputs are what git said.
 *
 * @param {{ changed: string[], deleted: string[] }} changes  committed changes against the base
 * A `related` / `tests` step is `heavy` (runs under HEAVY_MUTEX) when it is
 * wide: `relatedTests` is estimateRelatedTests' count for the changed sources.
 *
 * @param {{ base: string, kind?: string, metrics?: boolean, namingTests?: string[], relatedTests?: number }} options
 * @returns {Record<string, { command: [string, string[]] | null, reason?: string, heavy?: boolean }>}
 */
export function planSteps({ changed, deleted }, { base, kind, metrics = false, build = false, namingTests = [], relatedTests = 0 }) {
  /** @type {Record<string, { command: [string, string[]] | null, reason?: string, heavy?: boolean }>} */
  const plan = {};
  const lintable = changed.filter((file) => CODE_FILE.test(file));
  const shChanged = [...changed, ...deleted].some((file) => file.endsWith('.sh'));
  const sources = changed.filter((file) => RELATED_SOURCE.test(file));
  const tests = [...new Set([...changed.filter((file) => TEST_FILE.test(file)), ...namingTests])].sort();

  plan.changelog = { command: ['node', ['scripts/changelog-fragments.mjs', 'check']] };
  plan['removed-tests'] = { command: null, reason: 'internal' };
  plan.eslint = lintable.length > 0 ? { command: ['npx', ['eslint', ...lintable]] } : { command: null, reason: 'no changed .js/.ts' };
  plan['lint-sh'] = shChanged
    ? { command: ['node', ['scripts/run-lint-sh-if-changed.mjs', '--base', base]] }
    : { command: null, reason: 'no changed .sh' };
  plan.suppressions =
    kind === 'refactor' || metrics
      ? { command: ['node', ['scripts/count-suppressions.mjs', '--base', base]] }
      : { command: null, reason: 'not a refactor / metrics Issue' };
  plan.tsc = { command: ['npx', ['tsc', '--noEmit']] };
  if (build) {
    plan.build = { command: ['npm', ['run', 'build']] };
    plan['build-cli'] = { command: ['npm', ['run', 'build:cli']] };
    plan['build-server'] = { command: ['npm', ['run', 'build:server']] };
  }
  // `--dir tests/unit`: the same tree the unit gates cover; integration / e2e are CI's.
  plan.related =
    sources.length > 0
      ? {
          command: ['npx', ['vitest', 'related', '--run', '--dir', 'tests/unit', '--passWithNoTests', ...sources]],
          heavy: sources.length >= HEAVY_RELATED_SOURCES || relatedTests >= HEAVY_TEST_FILES,
        }
      : { command: null, reason: 'no changed src/scripts code' };
  // ALWAYS_TESTS are not counted: the guards alone never take the lock (#3884).
  plan.tests = { command: ['npx', ['vitest', 'run', ...tests, ...ALWAYS_TESTS]], heavy: tests.length >= HEAVY_TEST_FILES };
  return plan;
}

/** `name=status` pairs of a precheck / verify note. */
export function parseNote(note) {
  /** @type {Record<string, string>} */
  const steps = {};
  for (const match of String(note ?? '').matchAll(/(?:^|\s)([a-z-]+)=(ok|fail|skip|held)\b/g)) steps[match[1]] = match[2];
  return steps;
}

/**
 * Gate ids the verify stage passed, from its `passed=a,b` note (wait-verify.mjs).
 * Contract-defined gates (`<id>@contract`) keep their suffix, so they never
 * match a verify.yaml gate id in COVERED_BY_GATE.
 */
export function passedGates(verifyRecord) {
  if (!verifyRecord || verifyRecord.result !== 'ok') return [];
  const match = /(?:^|\s)passed=(\S+)/.exec(verifyRecord.note ?? '');
  return match && match[1] !== '-' ? match[1].split(',') : [];
}

/** The options a precheck result depends on, as one token of its note. */
export function optionsToken({ base, kind, metrics, allowRemovedTests, build }) {
  return `opts=base:${base},kind:${kind ?? '-'},metrics:${metrics},allow-removed:${allowRemovedTests},build:${build}`;
}

/**
 * The precheck flags of an earlier record's `opts=` token (optionsToken), for
 * running the same precheck on another HEAD (merge-pr.mjs after a refresh).
 * Without a token, the defaults with `fallbackBase`.
 */
export function optionsFromNote(note, fallbackBase = DEFAULT_BASE) {
  const token = String(note ?? '').split(/\s+/).find((part) => part.startsWith('opts='));
  if (!token) return ['--base', fallbackBase];
  /** @type {Record<string, string>} */
  const values = {};
  for (const pair of token.slice('opts='.length).split(',')) {
    const at = pair.indexOf(':');
    if (at > 0) values[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return [
    '--base', values.base || fallbackBase,
    ...(values.kind && values.kind !== '-' ? ['--kind', values.kind] : []),
    ...(values.metrics === 'true' ? ['--metrics'] : []),
    ...(values['allow-removed'] === 'true' ? ['--allow-removed-tests'] : []),
    ...(values.build === 'true' ? ['--build'] : []),
  ];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8'));
    return typeof owner.pid === 'number' && typeof owner.token === 'string' ? owner : null;
  } catch {
    return null;
  }
}

/** Only a holder recorded on this host whose pid is gone (ESRCH) is stale — machine-lock.ts isStaleOwner. */
function isStaleOwner(owner) {
  if (owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

/**
 * Take the machine-wide lock `name` the way src/lib/verification/machine-lock.ts
 * does (an atomic `mkdir` of `<root>/<name>.lock` with an owner record; a stale
 * holder is broken once), synchronously — precheck runs its steps with
 * spawnSync. Waits up to `timeoutMs`.
 *
 * @returns {{ acquired: boolean, waitedMs: number, heldBy: string | null, release: () => void }}
 */
export function acquireMachineLockSync(name, { root, timeoutMs, pollMs = LOCK_POLL_MS, sleep = sleepSync }) {
  const lockPath = path.join(root, `${name}.lock`);
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  const broken = new Set();
  fs.mkdirSync(root, { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, host: os.hostname(), token, acquiredAt: Date.now() }));
      return {
        acquired: true,
        waitedMs: Date.now() - startedAt,
        heldBy: null,
        release: () => {
          const current = readLockOwner(lockPath);
          if (current && current.token !== token) return;
          fs.rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const holder = readLockOwner(lockPath);
    if (holder && !broken.has(holder.token) && isStaleOwner(holder)) {
      broken.add(holder.token);
      if (readLockOwner(lockPath)?.token === holder.token) fs.rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      return { acquired: false, waitedMs, heldBy: holder ? `pid ${holder.pid} on ${holder.host || 'unknown host'}` : null, release: () => {} };
    }
    sleep(Math.min(pollMs, timeoutMs - waitedMs));
  }
}

/**
 * `<CM_VERIFY_LOCK_ROOT>`, else `<home>/.commandmate/locks` — machine-lock.ts resolveMachineLockRoot.
 *
 * @param {string} home
 * @param {Record<string, string | undefined>} [env]
 */
export function machineLockRoot(home, env = process.env) {
  const override = env.CM_VERIFY_LOCK_ROOT;
  return override && override.trim() !== '' ? override : path.join(home, '.commandmate', 'locks');
}

function git(run, worktree, args) {
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

const USAGE = `Usage:
  node scripts/orchestrate/precheck.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--base ${DEFAULT_BASE}] [--kind <feature|bug|refactor|docs>] [--metrics] [--build] [--allow-removed-tests] [--force] [--item <work item>]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--worktree': 'worktree',
  '--base': 'base',
  '--kind': 'kind',
  '--item': 'item',
};
const SWITCHES = { '--metrics': 'metrics', '--build': 'build', '--allow-removed-tests': 'allowRemovedTests', '--force': 'force' };

export function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, metrics: false, build: false, allowRemovedTests: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--worktree']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  const item = itemOption(options);
  if ('error' in item) return { error: item.error };
  options.item = item.item;
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun,
 *   findTestsNaming?: typeof findTestsNaming,
 *   estimateRelatedTests?: typeof estimateRelatedTests,
 *   acquireHeavyLock?: (timeoutMs: number) => { acquired: boolean, waitedMs: number, heldBy: string | null, release: () => void },
 *   now?: () => Date,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, now = () => new Date() } = deps;
  const findNaming = deps.findTestsNaming ?? findTestsNaming;
  const estimateRelated = deps.estimateRelatedTests ?? estimateRelatedTests;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const issue = Number(o.issue);
  const item = o.item;
  const name = `#${issue}${item ? `/${item}` : ''}`;

  try {
    const head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
    const short = head.slice(0, 7);
    const dirty = dirtyPaths(run, o.worktree);
    if (dirty.length > 0) {
      error(`precheck ${name}: uncommitted changes in ${o.worktree} — the result would not belong to ${short}:\n  ${dirty.join('\n  ')}`);
      return 2;
    }

    const range = `${o.base}...HEAD`;
    const changed = lines(git(run, o.worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', range]));
    const deleted = lines(git(run, o.worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=D', range]));
    const plan = planSteps(
      { changed, deleted },
      {
        base: o.base,
        kind: o.kind,
        metrics: o.metrics,
        build: o.build,
        namingTests: findNaming(o.worktree, [...changed, ...deleted]),
        relatedTests: estimateRelated(o.worktree, changed.filter((file) => RELATED_SOURCE.test(file))),
      }
    );
    const steps = [...STEPS, ...OPTIONAL_STEPS.filter((step) => plan[step])];
    const toRun = steps.filter((step) => plan[step].command !== null || step === 'removed-tests');
    const opts = optionsToken(o);

    const { records } = readRecords(o.runDir, o.issues);
    const home = deps.home ?? os.homedir();
    const where = { runDir: o.runDir, worktree: o.worktree, home };
    const acquireHeavyLock =
      deps.acquireHeavyLock ?? ((timeoutMs) => acquireMachineLockSync(HEAVY_MUTEX, { root: machineLockRoot(home), timeoutMs }));
    if (!o.force) {
      const previous = findLatest(records, { issue, item, stage: 'precheck', head });
      if (previous && previous.result === 'ok') {
        const done = parseNote(previous.note);
        const missing = toRun.filter((step) => done[step] !== 'ok');
        const sameOptions = (previous.note ?? '').split(/\s+/).includes(opts);
        // The result holds for the environment it was taken in (#3883 N9); one from before env= is reused with a warning.
        const env = verifyEnvState(previous, where);
        if (missing.length === 0 && sameOptions && env.state !== 'changed' && env.state !== 'missing') {
          if (env.state === 'unrecorded') log(`  warning: precheck at ${short}: ${env.detail}`);
          log(`precheck ${name} reused: ok at ${short} (${previous.at}) — pass --force to run again`);
          return 0;
        }
        const why = !sameOptions ? 'was taken with other options' : missing.length > 0 ? `did not run ${missing.join(', ')}` : `was taken in another environment (${env.state} — ${env.detail})`;
        log(`precheck ${name}: the ok record at ${short} ${why} — running`);
      }
    }
    // A pass taken in another environment than this one is not reused (#3883 N3); one from before env= is, with a warning.
    const verifyRecord = findLatest(records, { issue, item, stage: 'verify', head });
    let verified = passedGates(verifyRecord);
    if (verified.length > 0) {
      const env = verifyEnvState(verifyRecord, where);
      if (env.state === 'unrecorded') log(`  warning: verify at ${short}: ${env.detail}`);
      else if (env.state !== 'same') {
        log(`  verify at ${short} not reused: environment ${env.state} — ${env.detail}`);
        verified = [];
      }
    }

    const { file: logFile, attempt } = allocateLog(o.runDir, 'precheck', `${workItemName(issue, item)}-${short}`);
    fs.writeFileSync(logFile, `precheck ${name} ${head} base=${o.base}\n`);
    const started = now();
    // The inputs the checks ran on, kept under this precheck's key next to its log (#3883 N9).
    const key = executionKey({ issues: o.issues, issue, item, taskId: `precheck-${short}`, attempt });
    const envStart = takeManifest({ worktree: o.worktree, home });
    const results = {};
    // The waits and the execution, apart (#3884): `durationSec` is the whole precheck.
    let mutexMs = 0;
    let runMs = 0;
    // Set once a heavy step waited out the budget: the steps after it do not wait again.
    let heldBy = null;
    for (const step of steps) {
      const { command, reason, heavy } = plan[step];
      if (step === 'removed-tests') {
        const removed = countRemovedTests(git(run, o.worktree, ['diff', '--unified=0', '--no-color', range, '--', 'tests']));
        fs.appendFileSync(logFile, `\n## removed-tests (${removed.length})\n${removed.join('\n')}\n`);
        results[step] = removed.length === 0 || o.allowRemovedTests ? 'ok' : 'fail';
        log(`  ${step} ${results[step]} (${removed.length} removed${removed.length > 0 && o.allowRemovedTests ? ', allowed' : ''})`);
        continue;
      }
      if (command === null) {
        results[step] = 'skip';
        log(`  ${step} skip (${reason})`);
        continue;
      }
      const gate = (COVERED_BY_GATE[step] ?? []).find((id) => verified.includes(id));
      if (gate) {
        results[step] = 'ok';
        log(`  ${step} ok (verify passed ${gate} at ${short})`);
        continue;
      }
      const [cmd, args] = command;
      // A wide test step waits for cpu.heavy (#3884 H-10). A lock that stays held for the
      // whole budget leaves the step unrun (N1): running it beside the holder is the
      // load-flipped verdict the lock exists to prevent, and failing it would record
      // a resource conflict as a test failure.
      if (heavy && heldBy !== null) {
        results[step] = HELD;
        fs.appendFileSync(logFile, `\n## ${step}: not run — ${HEAVY_MUTEX} ${heldBy}\n`);
        log(`  ${step} ${HELD} (not run: ${HEAVY_MUTEX} ${heldBy})`);
        continue;
      }
      const lock = heavy ? acquireHeavyLock(HEAVY_LOCK_TIMEOUT_SEC * 1000) : null;
      let waitNote = '';
      if (lock) {
        mutexMs += lock.waitedMs;
        if (!lock.acquired) {
          heldBy = `held${lock.heldBy ? ` by ${lock.heldBy}` : ''} for ${(lock.waitedMs / 1000).toFixed(1)}s`;
          results[step] = HELD;
          fs.appendFileSync(logFile, `\n## ${step}: not run — ${HEAVY_MUTEX} ${heldBy}\n`);
          log(`  ${step} ${HELD} (not run: ${HEAVY_MUTEX} ${heldBy})`);
          continue;
        }
        waitNote = `, waited ${HEAVY_MUTEX} ${(lock.waitedMs / 1000).toFixed(1)}s`;
      }
      const t0 = Date.now();
      let out;
      try {
        out = run(cmd, args, { cwd: o.worktree });
      } finally {
        lock?.release();
      }
      const stepMs = Date.now() - t0;
      runMs += stepMs;
      fs.appendFileSync(logFile, `\n## ${step}: ${cmd} ${args.join(' ')} -> exit ${out.status}\n${out.stdout}${out.stderr}`);
      results[step] = out.status === 0 ? 'ok' : 'fail';
      log(`  ${step} ${results[step]} (exit ${out.status}, ${(stepMs / 1000).toFixed(1)}s${waitNote})`);
    }

    const envEnd = takeManifest({ worktree: o.worktree, home });
    const envMoved = diffManifest(envStart, envEnd);
    const envFile = `${logFile.replace(/\.log$/, '')}.env.json`;
    fs.writeFileSync(
      envFile,
      `${JSON.stringify({ key, start: envStart, verify: envStart, end: envEnd, changed: { duringTask: [], duringVerify: envMoved } }, null, 2)}\n`
    );
    // Inputs that changed while the checks ran: the result belongs to neither environment.
    if (envMoved.length > 0) log(`  the inputs changed during the precheck (${envMoved.join(',')}; see ${path.basename(envFile)}) — fail`);
    // A failed step is a verdict whatever else was held; a held step with no failure is none (#3884 N1).
    const held = Object.values(results).includes(HELD);
    const result = Object.values(results).includes('fail') || envMoved.length > 0 ? 'fail' : held ? 'skip' : 'ok';
    const envNote = `key=${key} env=${manifestHash(envEnd)}${envMoved.length > 0 ? ` env-changed-during-precheck=${envMoved.join(',')}` : ''}`;
    const note = `${steps.map((step) => `${step}=${results[step]}`).join(' ')} ${opts} ${envNote}`;
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    // The work HEAD under this one: a precheck of a refreshed HEAD stands for the
    // published HEAD, not for the worker's checks (run-log.mjs WORK_STAGES).
    const workHead = workHeadOf(run, o.worktree, head);
    const { file } = appendRecord(
      o.runDir,
      o.issues,
      {
        issue,
        item,
        stage: 'precheck',
        result,
        head,
        workHead,
        durationSec,
        mutexSec: Math.round(mutexMs / 1000),
        runSec: Math.round(runMs / 1000),
        note,
        key,
      },
      now()
    );
    log(`precheck ${name} ${short} ${result}: ${note}`);
    if (result === 'skip') {
      log(`  undecided: ${HEAVY_MUTEX} was not free within ${HEAVY_LOCK_TIMEOUT_SEC}s — not a test failure; run the precheck again (exit ${EXIT_HELD})`);
    }
    log(`recorded -> ${file} (log: ${logFile})`);
    return result === 'ok' ? 0 : result === 'skip' ? EXIT_HELD : 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
