/**
 * Regression tests for the sandbox teardown helper (Issue #1663).
 *
 * The flake being fixed is a race, so these tests reproduce it with a real
 * writer on a real filesystem: a worker thread re-creates files inside the
 * sandbox while the main thread walks it, which is what git does to
 * `.git/objects` when a test tears down a repository it just spawned git in.
 * No git here — the write is what matters, not who writes it.
 *
 * The race is *verified*, not assumed. The writer only stops when the helper's
 * retry hook says so, and a round in which the walk finished before the writer
 * ever got in the way proves nothing: such a round is discarded and retried
 * against a bigger tree, and a test that never manages to race fails rather
 * than passing on an unexercised path.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  getLeakedTempDirs,
  makeTempDir,
  removeTempDir,
  resetLeakedTempDirs,
  TEMP_DIR_LEAK_PREFIX,
} from '@tests/helpers/temp-dir';

/** Shared flag slots between the test and its writer thread. */
const RUN = 0;
const STARTED = 1;
const STOPPED = 2;
const WRITES = 3;

/** Sibling directories in the first round; later rounds get a bigger tree. */
const BASE_RACE_DIRS = 16;
const FILES_PER_DIR = 20;
/** Rounds to spend trying to make the writer and the walk actually collide. */
const RACE_ROUNDS = 4;
const FLAG_TIMEOUT_MS = 10000;
/**
 * These two tests do real filesystem work against a writer that is deliberately
 * hammering the same tree, so they are far slower than an assertion-only test —
 * and slower still on a loaded CI box. The default 5s is not enough.
 */
const RACE_TEST_TIMEOUT_MS = 60000;

const WRITER_SOURCE = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { workerData } = require('node:worker_threads');

const flags = new Int32Array(workerData.flags);
Atomics.store(flags, ${STARTED}, 1);
Atomics.notify(flags, ${STARTED});

while (Atomics.load(flags, ${RUN}) === 1) {
  for (const name of workerData.dirs) {
    try {
      const objects = join(workerData.dir, name, 'objects');
      mkdirSync(objects, { recursive: true });
      writeFileSync(join(objects, 'racer'), 'x');
      Atomics.add(flags, ${WRITES}, 1);
    } catch {
      // The walk removed a parent between our mkdir and our write. Keep going.
    }
  }
}

Atomics.store(flags, ${STOPPED}, 1);
Atomics.notify(flags, ${STOPPED});
`;

interface Racer {
  /** Sandbox the writer keeps repopulating. */
  dir: string;
  /** Stop the writer and wait until it acknowledges: no write outlives this. */
  stop: () => void;
  /** Files the writer has created so far. */
  writes: () => number;
  terminate: () => Promise<void>;
}

function awaitFlag(flags: Int32Array, index: number, label: string): void {
  const deadline = Date.now() + FLAG_TIMEOUT_MS;
  while (Atomics.load(flags, index) === 0) {
    if (Date.now() > deadline) throw new Error(`writer never signalled ${label}`);
    Atomics.wait(flags, index, 0, 50);
  }
}

/** A sandbox with a writer thread already actively repopulating it. */
function startRacer(dirCount: number): Racer {
  const dirs = Array.from({ length: dirCount }, (_, i) => `race-${String(i).padStart(3, '0')}`);
  const dir = makeTempDir('temp-dir-race-');
  for (const name of dirs) {
    mkdirSync(join(dir, name), { recursive: true });
    for (let i = 0; i < FILES_PER_DIR; i++) {
      writeFileSync(join(dir, name, `file-${i}`), 'payload\n');
    }
  }

  const shared = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(shared);
  Atomics.store(flags, RUN, 1);

  const worker = new Worker(WRITER_SOURCE, {
    eval: true,
    workerData: { dir, dirs, flags: shared },
  });
  worker.unref();

  awaitFlag(flags, STARTED, 'start');
  // "Thread is alive" is not enough — a writer that has not been scheduled onto
  // a core yet loses the race for reasons that have nothing to do with the
  // helper. Wait for a full sweep of real filesystem writes.
  const deadline = Date.now() + FLAG_TIMEOUT_MS;
  while (Atomics.load(flags, WRITES) < dirCount) {
    if (Date.now() > deadline) throw new Error('writer never completed a sweep');
    // Yield a core to the writer instead of spinning against it.
    Atomics.wait(flags, RUN, 1, 1);
  }

  let stopped = false;
  return {
    dir,
    stop: () => {
      if (stopped) return;
      stopped = true;
      Atomics.store(flags, RUN, 0);
      awaitFlag(flags, STOPPED, 'stop');
    },
    writes: () => Atomics.load(flags, WRITES),
    terminate: async () => {
      Atomics.store(flags, RUN, 0);
      await worker.terminate();
    },
  };
}

const racers: Racer[] = [];

/**
 * Run `round` against a live writer until the writer actually interferes.
 *
 * `round` reports `raced: false` when the walk finished unobstructed; that
 * round is thrown away and retried against a bigger tree.
 */
function withRacer<T>(round: (active: Racer) => { raced: boolean; result: T }): T {
  for (let attempt = 1; attempt <= RACE_ROUNDS; attempt++) {
    const active = startRacer(BASE_RACE_DIRS * attempt);
    racers.push(active);
    const { raced, result } = round(active);
    active.stop();
    if (raced) return result;
    removeTempDir(active.dir);
  }
  throw new Error(`the writer never collided with the walk in ${RACE_ROUNDS} rounds`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (racers.length > 0) {
    const leftover = racers.pop();
    if (!leftover) continue;
    await leftover.terminate();
    removeTempDir(leftover.dir);
  }
  resetLeakedTempDirs();
});

describe('removeTempDir — a writer racing the walk', () => {
  it('re-walks the tree and removes the sandbox anyway', () => {
    const { dir, removed, retries, writes } = withRacer((active) => {
      const seen: number[] = [];
      const done = removeTempDir(active.dir, {
        onRetry: (error, attempt) => {
          seen.push(attempt);
          expect(error.code).toBe('ENOTEMPTY');
          // Let the writer finish, so the next walk sees a tree that holds still.
          active.stop();
        },
      });
      return {
        // A walk that never had to retry did not exercise the fix.
        raced: seen.length > 0 || !done,
        result: { dir: active.dir, removed: done, retries: seen, writes: active.writes() },
      };
    });

    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
    // The first walk failed and the second one cleaned up: drop the retry and
    // this is the ENOTEMPTY that turned PR #1660 red.
    expect(retries).toEqual([1]);
    expect(writes).toBeGreaterThan(0);
  }, RACE_TEST_TIMEOUT_MS);

  it("gives up and reports the leftover when Node's own maxRetries is all it gets", () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { active, removed } = withRacer((racing) => {
      // attempts: 1 still passes maxRetries/retryDelay down to rmSync. Those
      // retries only re-issue rmdir() on the same path — they never re-read the
      // directory — so a re-created child defeats them every time.
      const done = removeTempDir(racing.dir, { attempts: 1 });
      return { raced: !done, result: { active: racing, removed: done } };
    });

    const reported = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();

    expect(removed).toBe(false);
    expect(existsSync(active.dir)).toBe(true);
    // Cleanup failure is reported, never thrown — but it is never silent either.
    expect(reported).toContain(TEMP_DIR_LEAK_PREFIX);
    expect(reported).toContain(active.dir);
    expect(getLeakedTempDirs()).toContain(active.dir);

    expect(removeTempDir(active.dir)).toBe(true);
  }, RACE_TEST_TIMEOUT_MS);
});

describe('removeTempDir — quiet paths', () => {
  it('treats an already-removed sandbox as success', () => {
    const dir = makeTempDir('temp-dir-gone-');
    expect(removeTempDir(dir)).toBe(true);
    expect(removeTempDir(dir)).toBe(true);
    expect(getLeakedTempDirs()).toHaveLength(0);
  });

  it('accepts an unset path, so teardown needs no null guard', () => {
    expect(removeTempDir(undefined)).toBe(true);
    expect(removeTempDir(null)).toBe(true);
    expect(removeTempDir('')).toBe(true);
  });
});

describe('makeTempDir', () => {
  it('creates a unique directory under the OS temp dir', () => {
    const first = makeTempDir('temp-dir-unique-');
    const second = makeTempDir('temp-dir-unique-');

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(first.startsWith(join(tmpdir(), 'temp-dir-unique-'))).toBe(true);

    removeTempDir(first);
    removeTempDir(second);
  });
});
