/**
 * Issue #2132 — a supported way to start in the background WITHOUT building.
 *
 * Before this Issue, `grep -c daemon scripts/start.sh` answered 0: the script
 * either handed over to PM2 or ran `npm start` in the foreground. The only
 * background start in the repository was `scripts/build-and-start.sh --daemon`,
 * which runs `npm run build:all` first and so writes a new `.next/BUILD_ID` —
 * the reason `.commandmate/verify.yaml` sets `skipInPrimaryCheckout: true`, and
 * the reason every already-open browser tab breaks. Operators facing a restart
 * that must not rebuild reached for a hand-rolled `nohup npm start` instead,
 * which is how the `.env` was lost (see load-env-shell-guard-2132.test.ts).
 *
 * ## Why "did not build" is asserted statically
 *
 * The direct check — start a server, compare `.next/BUILD_ID` before and after —
 * needs a running server, and this machine carries the user's production server
 * on port 3000 with parallel workers attached to it. A unit suite must not be
 * able to touch that, not even by mistyping a port. So the assertion is that no
 * command line in these scripts invokes a build, with `npm start` as the
 * positive control that the search is looking at command lines at all.
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
const START_SH = path.join(REPO_ROOT, 'scripts/start.sh');
const RESTART_SH = path.join(REPO_ROOT, 'scripts/restart-nobuild.sh');

function run(script: string, args: string[], cwd = REPO_ROOT, env?: ShellEnvOverride) {
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  assertSubprocessCompleted(result, `bash ${path.basename(script)} ${args.join(' ')}`);
  return result;
}

/** The lines of a shell script that actually run — comments and blanks dropped. */
function executableLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(#|$)/.test(line));
}

const BUILD_COMMAND = /\bnpm run build\b|\bnext build\b|\bbuild:(all|cli|server)\b/;

describe('Issue #2132: scripts/start.sh --help', () => {
  it('exits 0 and documents --daemon', () => {
    const result = run(START_SH, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--daemon');
    expect(result.stdout).toContain('-d, --daemon');
  });

  it('says the help answers before the environment is touched', () => {
    // `--help` must work in a checkout with no .env and no build. Running it
    // from a bare temp directory proves it does not depend on either.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-help-'));
    try {
      const result = run(START_SH, ['-h'], bare);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--daemon');
    } finally {
      removeTempDir(bare);
    }
  });

  it('rejects an unknown option instead of silently starting a server', () => {
    const result = run(START_SH, ['--rebuild-everything']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option');
    expect(result.stdout).not.toContain('Starting CommandMate');
  });
});

describe('Issue #2132: scripts/restart-nobuild.sh --help', () => {
  it('exits 0 and names both halves of the restart', () => {
    const result = run(RESTART_SH, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('stop-server.sh');
    expect(result.stdout).toContain('start.sh --daemon');
  });

  it('rejects an unknown option', () => {
    const result = run(RESTART_SH, ['--force']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option');
  });
});

describe('Issue #2132: neither script builds', () => {
  for (const [name, file] of [
    ['scripts/start.sh', START_SH],
    ['scripts/restart-nobuild.sh', RESTART_SH],
  ] as const) {
    it(`${name} runs no build command`, () => {
      const offenders = executableLines(file).filter((line) => BUILD_COMMAND.test(line));
      expect(offenders).toEqual([]);
    });
  }

  it('start.sh does start the server — the positive control for the search above', () => {
    // Without this, deleting the whole file would pass the assertions above.
    const lines = executableLines(START_SH);
    expect(lines.some((line) => /\bnpm start\b/.test(line))).toBe(true);
    expect(lines.some((line) => /\bnohup npm start\b/.test(line))).toBe(true);
  });

  it('build-and-start.sh still does build — the negative control', () => {
    // If BUILD_COMMAND stopped matching anything, the two assertions above
    // would pass vacuously for every script in the repository.
    const lines = executableLines(path.join(REPO_ROOT, 'scripts/build-and-start.sh'));
    expect(lines.some((line) => BUILD_COMMAND.test(line))).toBe(true);
  });
});

describe('Issue #2132: the daemon path keeps build-and-start.sh’s guarantees', () => {
  const source = fs.readFileSync(START_SH, 'utf8');

  it('restricts the PID file to the owner [S4-003]', () => {
    expect(source).toMatch(/echo \$SERVER_PID > "\$PID_FILE" && chmod 600 "\$PID_FILE"/);
  });

  it('restricts the log file [S4-005] and refuses to rotate a symlink [S4-006]', () => {
    expect(source).toContain('chmod 640 "$LOG_FILE"');
    expect(source).toContain('[S4-006]');
  });

  it('refuses to start over a live server, by PID file and by port [D1-004]', () => {
    expect(source).toContain('Server is already running (PID:');
    expect(source).toContain('Port $PORT is already in use by process(es):');
  });
});

describe('Issue #2132: start.sh --daemon refuses rather than half-starting', () => {
  // Both cases below return before anything is spawned and before any port is
  // probed, which is what makes them safe to run on a machine hosting the
  // user's production server.
  let sandbox: string;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-start-daemon-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'));
    for (const name of ['start.sh', 'load-env.sh']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', name), path.join(sandbox, 'scripts', name));
    }
  });

  afterAll(() => {
    removeTempDir(sandbox);
  });

  const startDaemon = (env: ShellEnvOverride) =>
    run(path.join(sandbox, 'scripts/start.sh'), ['--daemon'], sandbox, env);

  it('rejects a nonsense port before it looks at anything else [S4-001]', () => {
    const result = startDaemon({ CM_PORT: 'not-a-port', MCBD_PORT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid port number');
  });

  it('names the missing build instead of writing a PID file for a corpse', () => {
    // A script that never builds can only start something already built. The
    // old alternative — `nohup npm start` by hand — wrote a PID file and
    // reported success for a process that died with MODULE_NOT_FOUND.
    const result = startDaemon({ CM_PORT: '39871', MCBD_PORT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/server/server.js not found');
    expect(result.stderr).toContain('build-and-start.sh');
    expect(fs.existsSync(path.join(sandbox, 'logs/server.pid'))).toBe(false);
  });
});
