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

let child: ReturnType<typeof spawnSync>;

beforeAll(() => {
  child = spawnSync(process.execPath, [VITEST_BIN, 'run', TARGET, '-t', TEST_NAME], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, HOME: SCRATCH_HOME, NODE_ENV: 'test' },
  });
}, 200_000);

afterAll(() => {
  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
});

describe('env-scripts.test.ts cleans up after itself', () => {
  it('runs the probe case in the child process', () => {
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    // Without this, a filter typo would run zero tests and the emptiness check
    // below would pass for the wrong reason.
    expect(output).toMatch(/Tests {2}1 passed/);
    expect(child.status).toBe(0);
  });

  it('leaves no .commandmate-demo-vitest-* directory behind in $HOME', () => {
    expect(leftovers(SCRATCH_HOME)).toEqual([]);
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
      fs.rmSync(planted, { recursive: true, force: true });
    }
  });
});
