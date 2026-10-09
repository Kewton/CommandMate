#!/usr/bin/env node
/**
 * Runs `npm run lint:sh` (shellcheck) only when the branch touches a `.sh` file.
 *
 * Used by the `lint-sh` gate of `.commandmate/verify.yaml` (Issue #3478).
 * `npm run lint:sh` is a step of CI's Lint job, but neither `npm run lint` nor
 * any verify gate ran it, so PR #3405 passed every local gate and then went red
 * in CI on SC2034 / SC1091 / SC2174. The path condition lives HERE, in the
 * command, because a verify gate has no path condition (verify-config.ts accepts
 * only id / command / timeoutSec / mutex / retryOnFail / flakyIsPass) and a task
 * contract can only narrow the gate list, not make a gate conditional.
 *
 * Decisions (Issue #3478):
 *   - Changed `.sh` = `git diff --name-only --diff-filter=ACMRD <base>...HEAD`.
 *     Deletions count: removing a file another script `source`s breaks `-x`.
 *     Only committed changes count — the verify gates judge commits.
 *     No `.sh` in that list → print a line saying so and exit 0 without
 *     looking for shellcheck at all.
 *   - `--base <ref>` is an argument; the default is `origin/develop`.
 *   - shellcheck version: CI pins 0.11.0 (ci-pr.yml, `Shell script lint`).
 *     A different local version, or no shellcheck at all, is a WARNING, not a
 *     failure — workers do not all have shellcheck, and a gate that is red for a
 *     missing tool says nothing about the diff. A different version still runs
 *     `lint:sh`; a missing one exits 0 with a warning that states the `.sh`
 *     changes were NOT linted, so a green result never hides that.
 *   - Scope: this runs `lint:sh` exactly as package.json declares it, so its
 *     `find` roots (scripts, tests/scripts, .claude/lib) are what is checked.
 *     `.claude/skills/**` is not scanned; it is left unchanged until #3477
 *     decides where its tooling lives.
 *
 * Usage: node scripts/run-lint-sh-if-changed.mjs [--base <ref>]
 */
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/** The shellcheck version CI installs (ci-pr.yml `SHELLCHECK_VERSION`). */
export const CI_SHELLCHECK_VERSION = '0.11.0';

export const DEFAULT_BASE = 'origin/develop';

/**
 * @param {string[]} argv
 * @returns {{ base: string }}
 */
export function parseArgs(argv) {
  let base = DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--base requires a ref');
      }
      base = value;
      i++;
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
      if (!base) throw new Error('--base requires a ref');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { base };
}

/**
 * Files changed on this branch since it left `base`, including deletions and
 * both sides of a rename.
 *
 * @param {{ cwd: string, base: string }} options
 * @returns {string[]}
 */
export function listChangedFiles({ cwd, base }) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
export function selectShellScripts(files) {
  return files.filter((file) => file.endsWith('.sh'));
}

/**
 * Reads the version out of `shellcheck --version` output.
 *
 * @param {string} output
 * @returns {string | null}
 */
export function parseShellcheckVersion(output) {
  const match = /^version:\s*(\S+)/m.exec(output);
  return match ? match[1] : null;
}

/**
 * @returns {string | null} the installed version, or null when not installed
 */
function detectShellcheckVersion() {
  const result = spawnSync('shellcheck', ['--version'], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;
  return parseShellcheckVersion(result.stdout ?? '') ?? 'unknown';
}

/**
 * @param {string} cwd
 * @returns {number}
 */
function runLintSh(cwd) {
  const result = spawnSync('npm', ['run', 'lint:sh'], { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`run-lint-sh-if-changed: failed to start npm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   listChanged?: (options: { cwd: string, base: string }) => string[],
 *   shellcheckVersion?: () => string | null,
 *   lintSh?: (cwd: string) => number,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const listChanged = deps.listChanged ?? listChangedFiles;
  const shellcheckVersion = deps.shellcheckVersion ?? detectShellcheckVersion;
  const lintSh = deps.lintSh ?? runLintSh;
  const log = deps.log ?? ((message) => console.log(message));
  const warn = deps.warn ?? ((message) => console.error(message));

  let base;
  try {
    ({ base } = parseArgs(argv));
  } catch (error) {
    warn(`run-lint-sh-if-changed: ${error.message}`);
    return 2;
  }

  let changed;
  try {
    changed = listChanged({ cwd, base });
  } catch (error) {
    // Fail closed: without the diff we cannot say no `.sh` changed.
    const msg = error.stderr ? error.stderr.toString().trim() : error.message;
    warn(`run-lint-sh-if-changed: git diff against ${base}...HEAD failed: ${msg}`);
    return 1;
  }

  const shellScripts = selectShellScripts(changed);
  if (shellScripts.length === 0) {
    log(`run-lint-sh-if-changed: no .sh changed in ${base}...HEAD; shellcheck skipped`);
    return 0;
  }

  log(
    `run-lint-sh-if-changed: ${shellScripts.length} .sh changed in ${base}...HEAD: ${shellScripts.join(', ')}`
  );

  const version = shellcheckVersion();
  if (version === null) {
    warn(
      'run-lint-sh-if-changed: WARNING: shellcheck is not installed. ' +
        `The .sh changes above were NOT linted; CI's Lint job runs shellcheck ${CI_SHELLCHECK_VERSION} and will. ` +
        'Exiting 0 without a shellcheck verdict.'
    );
    return 0;
  }
  if (version !== CI_SHELLCHECK_VERSION) {
    warn(
      `run-lint-sh-if-changed: WARNING: shellcheck ${version} is installed; CI pins ${CI_SHELLCHECK_VERSION}. ` +
        'Findings can differ between versions (e.g. 0.9.0 reports SC2002, 0.11.0 does not). Continuing.'
    );
  }

  return lintSh(cwd);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
