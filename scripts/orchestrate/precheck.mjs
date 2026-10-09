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
 *   build          npm run build (only with --build; otherwise the PR's CI Build decides, 6-2 / 6-3)
 *   related        npx vitest related --run --dir tests/unit <changed src/scripts code>
 *   tests          npx vitest run <changed tests> <tests naming a changed path> tests/unit/guards tests/unit/docs
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
 * Exit code: 0 ok (or reused), 1 a step failed, 2 usage error or a dirty tree
 * (the result would not belong to HEAD).
 *
 * Usage:
 *   node scripts/orchestrate/precheck.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--base origin/develop] [--kind <feature|bug|refactor|docs>] [--metrics] [--build] [--allow-removed-tests] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, readRecords } from './run-log.mjs';

export const DEFAULT_BASE = 'origin/develop';
/** Run order: cheap and decisive first, the test runs last. */
export const STEPS = ['changelog', 'removed-tests', 'eslint', 'lint-sh', 'suppressions', 'tsc', 'related', 'tests'];
/** The verify-stage gate whose pass on the same HEAD already covers a step. */
export const COVERED_BY_GATE = {
  eslint: ['lint'],
  tsc: ['typecheck'],
  'lint-sh': ['lint-sh'],
};
/** Run only when asked (`--build`); the PR's CI Build is the default judge (6-2 / 6-3). */
export const OPTIONAL_STEPS = ['build'];
/** Always part of the test step (2-4-2: the guards are never left out). */
export const ALWAYS_TESTS = ['tests/unit/guards', 'tests/unit/docs'];
/** Files the orchestrator leaves in a worktree that are not the worker's work. */
const IGNORED_DIRTY = ['.commandmate/tasks/', 'dev-reports/'];
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
 * @param {{ base: string, kind?: string, metrics?: boolean, namingTests?: string[] }} options
 * @returns {Record<string, { command: [string, string[]] | null, reason?: string }>}
 */
export function planSteps({ changed, deleted }, { base, kind, metrics = false, build = false, namingTests = [] }) {
  /** @type {Record<string, { command: [string, string[]] | null, reason?: string }>} */
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
  if (build) plan.build = { command: ['npm', ['run', 'build']] };
  // `--dir tests/unit`: the same tree the unit gates cover; integration / e2e are CI's.
  plan.related =
    sources.length > 0
      ? { command: ['npx', ['vitest', 'related', '--run', '--dir', 'tests/unit', '--passWithNoTests', ...sources]] }
      : { command: null, reason: 'no changed src/scripts code' };
  plan.tests = { command: ['npx', ['vitest', 'run', ...tests, ...ALWAYS_TESTS]] };
  return plan;
}

/** `name=status` pairs of a precheck / verify note. */
export function parseNote(note) {
  /** @type {Record<string, string>} */
  const steps = {};
  for (const match of String(note ?? '').matchAll(/(?:^|\s)([a-z-]+)=(ok|fail|skip)\b/g)) steps[match[1]] = match[2];
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

function git(run, worktree, args) {
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

const USAGE = `Usage:
  node scripts/orchestrate/precheck.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--base ${DEFAULT_BASE}] [--kind <feature|bug|refactor|docs>] [--metrics] [--build] [--allow-removed-tests] [--force]`;

const FLAGS = { '--run-dir': 'runDir', '--issues': 'issues', '--issue': 'issue', '--worktree': 'worktree', '--base': 'base', '--kind': 'kind' };
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
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun,
 *   findTestsNaming?: typeof findTestsNaming,
 *   now?: () => Date,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, now = () => new Date() } = deps;
  const findNaming = deps.findTestsNaming ?? findTestsNaming;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const issue = Number(o.issue);

  try {
    const head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
    const short = head.slice(0, 7);
    const dirty = lines(git(run, o.worktree, ['status', '--porcelain']))
      .map((line) => line.replace(/^\S+\s+/, ''))
      .filter((file) => !IGNORED_DIRTY.some((prefix) => file.startsWith(prefix)));
    if (dirty.length > 0) {
      error(`precheck #${issue}: uncommitted changes in ${o.worktree} — the result would not belong to ${short}:\n  ${dirty.join('\n  ')}`);
      return 2;
    }

    const range = `${o.base}...HEAD`;
    const changed = lines(git(run, o.worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', range]));
    const deleted = lines(git(run, o.worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=D', range]));
    const plan = planSteps(
      { changed, deleted },
      { base: o.base, kind: o.kind, metrics: o.metrics, build: o.build, namingTests: findNaming(o.worktree, [...changed, ...deleted]) }
    );
    const steps = [...STEPS, ...OPTIONAL_STEPS.filter((step) => plan[step])];
    const toRun = steps.filter((step) => plan[step].command !== null || step === 'removed-tests');
    const opts = optionsToken(o);

    const { records } = readRecords(o.runDir, o.issues);
    if (!o.force) {
      const previous = findLatest(records, { issue, stage: 'precheck', head });
      if (previous && previous.result === 'ok') {
        const done = parseNote(previous.note);
        const missing = toRun.filter((step) => done[step] !== 'ok');
        const sameOptions = (previous.note ?? '').split(/\s+/).includes(opts);
        if (missing.length === 0 && sameOptions) {
          log(`precheck #${issue} reused: ok at ${short} (${previous.at}) — pass --force to run again`);
          return 0;
        }
        log(`precheck #${issue}: the ok record at ${short} ${sameOptions ? `did not run ${missing.join(', ')}` : 'was taken with other options'} — running`);
      }
    }
    const verified = passedGates(findLatest(records, { issue, stage: 'verify', head }));

    const logFile = path.join(o.runDir, `precheck-${issue}-${short}.log`);
    fs.mkdirSync(o.runDir, { recursive: true });
    fs.writeFileSync(logFile, `precheck #${issue} ${head} base=${o.base}\n`);
    const started = now();
    const results = {};
    for (const step of steps) {
      const { command, reason } = plan[step];
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
      const t0 = Date.now();
      const out = run(cmd, args, { cwd: o.worktree });
      fs.appendFileSync(logFile, `\n## ${step}: ${cmd} ${args.join(' ')} -> exit ${out.status}\n${out.stdout}${out.stderr}`);
      results[step] = out.status === 0 ? 'ok' : 'fail';
      log(`  ${step} ${results[step]} (exit ${out.status}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }

    const result = Object.values(results).includes('fail') ? 'fail' : 'ok';
    const note = `${steps.map((step) => `${step}=${results[step]}`).join(' ')} ${opts}`;
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    const { file } = appendRecord(o.runDir, o.issues, { issue, stage: 'precheck', result, head, durationSec, note }, now());
    log(`precheck #${issue} ${short} ${result}: ${note}`);
    log(`recorded -> ${file} (log: ${logFile})`);
    return result === 'ok' ? 0 : 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
