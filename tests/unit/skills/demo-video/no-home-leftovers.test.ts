/**
 * The demo-video env tests must not leave anything in the user's home (#1553).
 *
 * `env-scripts.test.ts` has to put its scratch dir under $HOME — env-up.sh
 * refuses anywhere else, because validateDbPath rejects /tmp and /var as system
 * directories. That makes forgetting to remove it a leak into a real home
 * directory: one `.commandmate-demo-vitest-<pid>` per `npm run test:unit`, with
 * nothing to ever collect them. Eight had accumulated before this guard existed.
 *
 * A hook that runs last cannot be observed from inside its own file, so this
 * test runs that file in a child process with `HOME` pointed at a scratch
 * directory and inspects what survives. `os.homedir()` returns `$HOME` on
 * POSIX, so the child's scratch dir lands where this test can see it.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stripAnsi } from '@/lib/detection/ansi';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
const TARGET = 'tests/unit/skills/demo-video/env-scripts.test.ts';

/**
 * Chosen deliberately: this case writes to `STATE_FILE` inside the scratch dir
 * before doing anything else, so it can only pass if `beforeAll` really created
 * that directory. Child exit 0 therefore proves the directory existed during
 * the run, and the absence check below proves `afterAll` removed it — neither
 * half is inferred. It is also cheap: env-up bails on the pre-existing state
 * file before it picks a port or starts a server.
 */
const TEST_NAME = 'refuses to start on top of an existing state file';

const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-home-'));

function leftovers(home: string): string[] {
  return fs.readdirSync(home).filter((entry) => entry.startsWith('.commandmate-demo-vitest-'));
}

/**
 * How many tests the child reported passing, or null when it printed no
 * summary at all (no matching test, crash).
 *
 * ANSI is stripped first. Vitest colours its summary on GitHub Actions but not
 * in a local pipe, so the colourless form is all a developer ever sees: the
 * original `/Tests {2}1 passed/` matched locally and failed in CI, where the
 * line arrives as `Tests \x1b[22m \x1b[1m\x1b[32m1 passed` and the two spaces
 * are no longer adjacent. Anchoring on bytes that carry colour is the same
 * mistake orchestrate-monitor records as regression #3: compare after
 * stripping, never before. `\s+` rather than a fixed run of spaces so the
 * assertion also survives a change in vitest's column padding.
 */
export function passedTestCount(output: string): number | null {
  const match = /Tests\s+(\d+) passed/.exec(stripAnsi(output));
  return match ? Number(match[1]) : null;
}

let child: ReturnType<typeof spawnSync>;

beforeAll(() => {
  child = spawnSync(process.execPath, [VITEST_BIN, 'run', TARGET, '-t', TEST_NAME], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: SCRATCH_HOME,
      NODE_ENV: 'test',
      // Belt: keep the child's summary colourless wherever it runs, so local
      // and CI see the same bytes. Braces: `passedTestCount` strips ANSI anyway,
      // because vitest decides on colour by its own rules and has already
      // surprised us once (PR #1559).
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
}, 200_000);

afterAll(() => {
  removeTempDir(SCRATCH_HOME);
});

describe('env-scripts.test.ts cleans up after itself', () => {
  it('runs the probe case in the child process', () => {
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    // Exactly one. Without this, a filter typo would run zero tests and the
    // emptiness check below would pass for the wrong reason.
    expect(passedTestCount(output)).toBe(1);
    expect(child.status).toBe(0);
  });

  it('leaves no .commandmate-demo-vitest-* directory behind in $HOME', () => {
    expect(leftovers(SCRATCH_HOME)).toEqual([]);
  });

  it('counts the child summary whether or not vitest coloured it', () => {
    // Colour is not reproducible on demand: vitest leaves the summary plain in
    // a local pipe *and* under a pty, and colours it on GitHub Actions. So the
    // coloured form is pinned with the bytes CI actually produced (PR #1559,
    // Unit Tests) rather than with an environment flag that does not bite here.
    const COLOURED_CI = [
      '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.2\u001b[39m /home/runner/work/CommandMate/CommandMate',
      '',
      '\u001b[1m\u001b[32m Test Files \u001b[39m\u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m (1)',
      '\u001b[1m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m | 10 skipped\u001b[39m (11)',
    ].join('\n');
    const PLAIN_LOCAL = [
      ' RUN  v4.1.2 /Users/dev/CommandMate',
      '',
      ' Test Files  1 passed (1)',
      '      Tests  1 passed | 10 skipped (11)',
    ].join('\n');

    expect(passedTestCount(COLOURED_CI)).toBe(1);
    expect(passedTestCount(PLAIN_LOCAL)).toBe(1);

    // The assertion this replaced. Keeping it here records *why* the helper
    // strips first: on the real CI bytes the two spaces are split by an SGR
    // reset, so the old pattern could never match. Deleting the strip from
    // `passedTestCount` turns the first expectation above red.
    expect(PLAIN_LOCAL).toMatch(/Tests {2}1 passed/);
    expect(COLOURED_CI).not.toMatch(/Tests {2}1 passed/);
  });

  it('still distinguishes "one test ran" from zero or many', () => {
    // The point of the assertion is to catch a filter typo silently running
    // nothing, so tolerating ANSI must not have made it tolerate a wrong count.
    expect(passedTestCount('No test files found, exiting with code 1')).toBeNull();
    expect(passedTestCount(' Test Files  no tests\n      Tests  0 passed (0)')).toBe(0);
    expect(passedTestCount('      Tests  11 passed (11)')).toBe(11);
    expect(
      passedTestCount('\u001b[1m      Tests \u001b[22m \u001b[1m\u001b[32m11 passed\u001b[39m (11)'),
    ).toBe(11);
  });

  it('the leftover check can actually see such a directory', () => {
    // Proves the assertion above is not passing because the glob never matches
    // anything: plant one and confirm it is detected.
    const planted = path.join(SCRATCH_HOME, '.commandmate-demo-vitest-planted');
    fs.mkdirSync(planted, { recursive: true });
    try {
      // `toContain`, not `toEqual`: if the child did leak, that is the previous
      // test's finding to report — this one only has to stay a valid control.
      expect(leftovers(SCRATCH_HOME)).toContain('.commandmate-demo-vitest-planted');
    } finally {
      removeTempDir(planted);
    }
  });
});
