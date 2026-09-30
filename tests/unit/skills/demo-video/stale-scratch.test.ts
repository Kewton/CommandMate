/**
 * Sweep of stale `.commandmate-demo-vitest-<pid>` dirs (#3025).
 * A temp dir under os.tmpdir() stands in for $HOME; the real one is never touched.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { isStaleScratchDir, scratchDirPid, sweepStaleScratchDirs } from './stale-scratch';

/** A pid that really existed and has exited (spawnSync waits for the child). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid as number;
}

describe('scratchDirPid', () => {
  it('extracts the pid from a matching name only', () => {
    expect(scratchDirPid('.commandmate-demo-vitest-123')).toBe(123);
    expect(scratchDirPid('.commandmate-demo-vitest-')).toBeNull();
    expect(scratchDirPid('.commandmate-demo-vitest-12a')).toBeNull();
    expect(scratchDirPid('x.commandmate-demo-vitest-12')).toBeNull();
    expect(scratchDirPid('.commandmate-demo')).toBeNull();
  });
});

describe('isStaleScratchDir', () => {
  it('is false for our own pid and for non-matching names', () => {
    expect(isStaleScratchDir(`.commandmate-demo-vitest-${process.pid}`)).toBe(false);
    expect(isStaleScratchDir('.commandmate-demo')).toBe(false);
  });

  it('is true for an exited pid', () => {
    expect(isStaleScratchDir(`.commandmate-demo-vitest-${deadPid()}`)).toBe(true);
  });
});

describe('sweepStaleScratchDirs', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-scratch-home-'));
  });
  afterEach(() => removeTempDir(home));

  it('removes dead-pid dirs and keeps live-pid and differently named ones', () => {
    const dead = `.commandmate-demo-vitest-${deadPid()}`;
    const live = `.commandmate-demo-vitest-${process.pid}`;
    const other = '.commandmate-demo-vitest-notapid';
    const unrelated = '.commandmate-demo';
    for (const name of [dead, live, other, unrelated]) {
      fs.mkdirSync(path.join(home, name, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(home, name, 'sub', 'f'), 'x');
    }

    expect(sweepStaleScratchDirs(home)).toEqual([dead]);

    expect(fs.existsSync(path.join(home, dead))).toBe(false);
    for (const name of [live, other, unrelated]) {
      expect(fs.existsSync(path.join(home, name, 'sub', 'f'))).toBe(true);
    }
  });
});
