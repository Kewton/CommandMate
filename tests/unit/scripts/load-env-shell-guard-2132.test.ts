/**
 * Issue #2132 — `scripts/load-env.sh` must not load nothing quietly.
 *
 * The script resolves its own directory from `${BASH_SOURCE[0]}` and classifies
 * comment lines with bash's `[[ ... =~ ... ]]`. zsh has neither, and — this is
 * the whole defect — fails at neither: `${BASH_SOURCE[0]}` is the empty string,
 * `dirname ""` is `.`, the `.env` one directory above the project is not found,
 * the loop never runs, and `source` returns 0 having exported nothing.
 *
 * Measured on develop f5903168 before the fix:
 *
 *     $ zsh -c 'source scripts/load-env.sh; echo rc=$?; echo "[$CM_PORT]"'
 *     rc=0
 *     []
 *
 * A server started that way during the Epic #2002 device UAT (2026-08-29) ran
 * with none of CM_VAPID_* / CM_DB_PATH / CM_ROOT_DIR / CM_PORT / CM_BIND, Web
 * Push died on every device, and two UAT rounds were spent before the cause was
 * found. So the acceptance condition is not "zsh works" — it is "zsh does not
 * silently succeed", and it is pinned here by running the real shells.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * A partial environment override.
 *
 * Not `NodeJS.ProcessEnv`: this repository augments that interface with a
 * required `NODE_ENV`, so `{ CM_PORT: '39871' }` does not satisfy it. A key
 * whose value is `undefined` is dropped by `spawnSync`, which is how these
 * tests unset an inherited variable.
 */
type ShellEnvOverride = Record<string, string | undefined>;
const LOAD_ENV = path.join(REPO_ROOT, 'scripts/load-env.sh');

/** True when `shell` exists on this machine — zsh is absent on plain CI images. */
function hasShell(shell: string): boolean {
  const probe = spawnSync('/bin/bash', ['-c', `command -v ${shell}`], {
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  return probe.status === 0;
}

function runShell(shell: string, script: string, cwd: string, env?: ShellEnvOverride) {
  const result = spawnSync(shell, ['-c', script], {
    cwd,
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  assertSubprocessCompleted(result, `${shell} -c`);
  return result;
}

describe('Issue #2132: sourcing load-env.sh from a non-bash shell', () => {
  // The guard is the first executable statement in the file, so it fires
  // whether or not a .env exists — the repository's own copy is enough.
  const NON_BASH = ['zsh', 'dash'];

  for (const shell of NON_BASH) {
    const maybe = hasShell(shell) ? it : it.skip;
    // `.`, not `source`: dash has no `source` builtin, and a "not found" exit
    // code would pass the first assertion for entirely the wrong reason.
    const sourceIt = `. ${JSON.stringify(LOAD_ENV)}`;

    maybe(`fails instead of returning 0 (${shell})`, () => {
      const result = runShell(shell, sourceIt, REPO_ROOT);
      expect(result.status).not.toBe(0);
    });

    maybe(`says why, and where to go instead (${shell})`, () => {
      const result = runShell(shell, sourceIt, REPO_ROOT);
      // An exit code nobody reads is what the old behaviour effectively was.
      // The message has to name the cause AND the supported replacement.
      expect(result.stderr).toContain('must be sourced from bash');
      expect(result.stderr).toContain('BASH_SOURCE');
      expect(result.stderr).toContain('./scripts/start.sh --daemon');
      expect(result.stderr).toContain('./scripts/restart-nobuild.sh');
      // Nothing useful may go to stdout: a caller doing `eval "$(...)"` must
      // not swallow the diagnostic.
      expect(result.stdout).toBe('');
    });
  }
});

describe('Issue #2132: sourcing load-env.sh from bash still works', () => {
  // Regression cover for the five scripts that source this file. A sandbox
  // rather than the repository's own .env, because a CI checkout has none.
  let sandbox: string;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-load-env-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'));
    fs.copyFileSync(LOAD_ENV, path.join(sandbox, 'scripts/load-env.sh'));
    fs.writeFileSync(
      path.join(sandbox, '.env'),
      [
        '# a comment',
        '',
        'CM_PORT=39871',
        'CM_TEST_FROM_DOTENV=loaded',
        'CM_TEST_ALREADY_SET=from-file',
      ].join('\n') + '\n',
    );
  });

  afterAll(() => {
    removeTempDir(sandbox);
  });

  const sourceInSandbox = (script: string, env?: ShellEnvOverride) =>
    runShell(
      'bash',
      `source "$PWD/scripts/load-env.sh"\n${script}`,
      sandbox,
      env,
    );

  it('exports the variables the file declares', () => {
    const result = sourceInSandbox('echo "$CM_PORT|$CM_TEST_FROM_DOTENV"', {
      CM_PORT: undefined,
      CM_TEST_FROM_DOTENV: undefined,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('39871|loaded');
  });

  it('leaves a variable that is already set alone', () => {
    // Documented contract, and what lets `CM_PORT=3011 ./scripts/start.sh`
    // beat the .env — the rebuild skill depends on it.
    const result = sourceInSandbox('echo "$CM_TEST_ALREADY_SET"', {
      CM_TEST_ALREADY_SET: 'from-environment',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('from-environment');
  });

  it('says nothing at all when it succeeds', () => {
    const result = sourceInSandbox('true', { CM_PORT: undefined });
    expect(result.stderr).toBe('');
  });
});

describe('Issue #2132: the guard is reachable', () => {
  // A static companion to the shell runs above, so the invariant is still
  // asserted on a machine that has neither zsh nor dash.
  const source = fs.readFileSync(LOAD_ENV, 'utf8');
  // Comment lines discuss `${BASH_SOURCE[0]}` at length; only the lines that
  // run can put it before the guard.
  const executable = source
    .split('\n')
    .filter((line) => !/^\s*(#|$)/.test(line))
    .join('\n');

  it('tests BASH_SOURCE before using any bash-only syntax', () => {
    const guardAt = executable.indexOf('${BASH_SOURCE+x}');
    const firstBashOnlyUse = executable.indexOf('${BASH_SOURCE[0]}');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstBashOnlyUse).toBeGreaterThan(guardAt);
  });

  it('leaves the shell with a failure, not a return value it ignores', () => {
    expect(source).toMatch(/return 1 2>\/dev\/null \|\| exit 1/);
  });
});
