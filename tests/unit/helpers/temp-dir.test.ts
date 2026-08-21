/**
 * Regression tests for the sandbox teardown helper (Issue #1663, #1869).
 *
 * The flake being fixed is a race, so the first two tests reproduce it with
 * real writers on a real filesystem: worker threads re-create files inside the
 * sandbox while the main thread walks it, which is what git does to
 * `.git/objects` when a test tears down a repository it just spawned git in.
 * No git here — the write is what matters, not who writes it.
 *
 * Staging that race is the harness's job, and a machine that refuses to stage
 * it is not a defect in the code under test. Issue #1869 measured what actually
 * happens on a loaded box — the writer is *not* starved of CPU: 462 of its
 * writes landed during a 101ms walk and the walk still finished cleanly.
 * Node's recursive remove re-scans and retries on its own, so an ENOTEMPTY
 * escapes it only while the tree stays dirty across that whole internal retry
 * ladder — and a single writer thread that loses its core for a millisecond at
 * the wrong moment hands the walk exactly the gap it needs. Escapes per 12
 * rounds, one writer against eight, same tree:
 *
 *     CPU burners     1 writer     8 writers
 *     none              9/10         12/12
 *     24               11/12         12/12
 *     64                0/12         10/12
 *
 * So the race is staged by several independent writers rather than one (they
 * would have to lose their cores *simultaneously* to open that gap), retried
 * against a bigger tree, and — when the machine still never lets the two
 * overlap — reported and skipped rather than failed. The re-walk those tests
 * are really about does not depend on that luck at all: it is pinned by the
 * deterministic tests further down, which obstruct the first walk outright.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

/** Shared flag slots between the test and its writer threads. */
const RUN = 0;
const STARTED = 1;
const STOPPED = 2;
const WRITES = 3;
const SWEEPS = 4;
const FLAG_SLOTS = 5;

/** Sibling directories in the first round; later rounds get a bigger tree. */
const BASE_RACE_DIRS = 16;
const FILES_PER_DIR = 20;
/**
 * Writer threads per round. One is not enough on a loaded machine — see the
 * table in the file header: a lone writer fell from 11/12 rounds under 24 CPU
 * burners to 0/12 under 64, while eight writers held at 10/12 and reached
 * 12/12 once the tree grew. Threads are cheap here and the odds compound.
 */
const WRITER_THREADS = 8;
/** Rounds to spend trying to make the writers and the walk actually collide. */
const RACE_ROUNDS = 4;
/**
 * Wall clock a single test may spend staging the race. Rounds get slower as
 * the tree grows, and a round that runs into its flag timeouts costs seconds:
 * stop starting new ones well before the test timeout turns a shy machine into
 * a red test.
 */
const RACE_BUDGET_MS = 30000;
const FLAG_TIMEOUT_MS = 10000;
/**
 * These tests do real filesystem work against writers that are deliberately
 * hammering the same tree, so they are far slower than an assertion-only test —
 * and slower still on a loaded CI box. The default 5s is not enough.
 */
const RACE_TEST_TIMEOUT_MS = 60000;

/** Prefix of the stderr line written when the machine never staged the race. */
const UNSTAGED_PREFIX = '[temp-dir] race not staged:';

const WRITER_SOURCE = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { workerData } = require('node:worker_threads');

const flags = new Int32Array(workerData.flags);
Atomics.add(flags, ${STARTED}, 1);
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
  Atomics.add(flags, ${SWEEPS}, 1);
  Atomics.notify(flags, ${SWEEPS});
}

Atomics.add(flags, ${STOPPED}, 1);
Atomics.notify(flags, ${STOPPED});
`;

interface Racer {
  /** Sandbox the writers keep repopulating. */
  dir: string;
  /** Stop the writers and wait until they acknowledge: no write outlives this. */
  stop: () => void;
  /** Files the writers have created so far. */
  writes: () => number;
  terminate: () => Promise<void>;
}

/** Wait until a counting flag reaches `target`, or say which one did not. */
function awaitCount(flags: Int32Array, index: number, target: number, label: string): void {
  const deadline = Date.now() + FLAG_TIMEOUT_MS;
  let seen = Atomics.load(flags, index);
  while (seen < target) {
    if (Date.now() > deadline) {
      throw new Error(`writers never signalled ${label} (${seen}/${target})`);
    }
    Atomics.wait(flags, index, seen, 50);
    seen = Atomics.load(flags, index);
  }
}

/** A sandbox with writer threads already actively repopulating it. */
function startRacer(dirCount: number): Racer {
  const dirs = Array.from({ length: dirCount }, (_, i) => `race-${String(i).padStart(3, '0')}`);
  const dir = makeTempDir('temp-dir-race-');
  for (const name of dirs) {
    mkdirSync(join(dir, name), { recursive: true });
    for (let i = 0; i < FILES_PER_DIR; i++) {
      writeFileSync(join(dir, name, `file-${i}`), 'payload\n');
    }
  }

  const shared = new SharedArrayBuffer(FLAG_SLOTS * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(shared);
  Atomics.store(flags, RUN, 1);

  const workers = Array.from(
    { length: WRITER_THREADS },
    () => new Worker(WRITER_SOURCE, { eval: true, workerData: { dir, dirs, flags: shared } })
  );
  for (const worker of workers) worker.unref();

  awaitCount(flags, STARTED, WRITER_THREADS, 'start');
  // "The threads are alive" is not enough — a writer that has not been
  // scheduled onto a core yet cannot obstruct anything. Wait until every one of
  // them has completed a full sweep of real filesystem writes.
  awaitCount(flags, SWEEPS, WRITER_THREADS, 'a sweep');

  let stopped = false;
  return {
    dir,
    stop: () => {
      if (stopped) return;
      stopped = true;
      Atomics.store(flags, RUN, 0);
      awaitCount(flags, STOPPED, WRITER_THREADS, 'stop');
    },
    writes: () => Atomics.load(flags, WRITES),
    terminate: async () => {
      Atomics.store(flags, RUN, 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

const racers: Racer[] = [];

/** A sandbox whose first walk is guaranteed to fail, plus the switch to clear it. */
interface BlockedSandbox {
  dir: string;
  /** False when this process can read a 0o000 directory anyway (root). */
  blocks: boolean;
  unblock: () => void;
}

const blockedSandboxes: BlockedSandbox[] = [];

/** Either the round the writers won, or why no round was ever staged. */
type RaceOutcome<T> = { raced: true; result: T } | { raced: false; note: string };

/**
 * Run `round` against live writers until they actually interfere.
 *
 * `round` reports `raced: false` when the walk finished unobstructed; that
 * round is thrown away and retried against a bigger tree. Running out of rounds
 * is *not* a failure — it says the machine never let the writers and the walk
 * overlap, which is a fact about the machine, not about `removeTempDir`
 * (#1869) — so the caller is handed a note to skip with.
 */
function withRacer<T>(round: (active: Racer) => { raced: boolean; result: T }): RaceOutcome<T> {
  const deadline = Date.now() + RACE_BUDGET_MS;
  let rounds = 0;

  for (let attempt = 1; attempt <= RACE_ROUNDS; attempt++) {
    const active = startRacer(BASE_RACE_DIRS * attempt);
    racers.push(active);
    rounds = attempt;

    const { raced, result } = round(active);
    active.stop();
    if (raced) return { raced: true, result };

    removeTempDir(active.dir);
    if (Date.now() > deadline) break;
  }

  return {
    raced: false,
    note:
      `${WRITER_THREADS} writers never obstructed the walk in ${rounds} round(s) — ` +
      'this machine never let them overlap, which says nothing about removeTempDir',
  };
}

/**
 * Report and skip.
 *
 * A round the machine never staged is not a failing assertion about
 * `removeTempDir`; treating it as one is what made this file red under load
 * (#1869). It must not pass silently either, so the reason goes to stderr
 * before the test is skipped.
 */
function skipUnstaged(ctx: { skip: (note?: string) => void }, note: string): void {
  process.stderr.write(`${UNSTAGED_PREFIX} ${note}\n`);
  ctx.skip(note);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (racers.length > 0) {
    const leftover = racers.pop();
    if (!leftover) continue;
    await leftover.terminate();
    removeTempDir(leftover.dir);
  }
  while (blockedSandboxes.length > 0) {
    const leftover = blockedSandboxes.pop();
    if (!leftover) continue;
    leftover.unblock();
    removeTempDir(leftover.dir);
  }
  resetLeakedTempDirs();
});

describe('removeTempDir — writers racing the walk', () => {
  it('re-walks the tree and removes the sandbox anyway', (ctx) => {
    const outcome = withRacer((active) => {
      const seen: number[] = [];
      const done = removeTempDir(active.dir, {
        onRetry: (error, attempt) => {
          seen.push(attempt);
          expect(error.code).toBe('ENOTEMPTY');
          // Let the writers finish, so the next walk sees a tree that holds still.
          active.stop();
        },
      });
      return {
        // A walk that never had to retry did not exercise the fix.
        raced: seen.length > 0 || !done,
        result: { dir: active.dir, removed: done, retries: seen, writes: active.writes() },
      };
    });
    if (!outcome.raced) return skipUnstaged(ctx, outcome.note);

    const { dir, removed, retries, writes } = outcome.result;
    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
    // The first walk failed and the second one cleaned up: drop the retry and
    // this is the ENOTEMPTY that turned PR #1660 red.
    expect(retries).toEqual([1]);
    expect(writes).toBeGreaterThan(0);
  }, RACE_TEST_TIMEOUT_MS);

  it("gives up and reports the leftover when Node's own maxRetries is all it gets", (ctx) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const outcome = withRacer((racing) => {
      // attempts: 1 still passes maxRetries/retryDelay down to rmSync. Those
      // retries only re-issue rmdir() on the same path — they never re-read the
      // directory — so a re-created child defeats them every time.
      const done = removeTempDir(racing.dir, { attempts: 1 });
      return { raced: !done, result: { active: racing, removed: done } };
    });

    const reported = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    if (!outcome.raced) return skipUnstaged(ctx, outcome.note);

    const { active, removed } = outcome.result;
    expect(removed).toBe(false);
    expect(existsSync(active.dir)).toBe(true);
    // Cleanup failure is reported, never thrown — but it is never silent either.
    expect(reported).toContain(TEMP_DIR_LEAK_PREFIX);
    expect(reported).toContain(active.dir);
    expect(getLeakedTempDirs()).toContain(active.dir);

    expect(removeTempDir(active.dir)).toBe(true);
  }, RACE_TEST_TIMEOUT_MS);
});

/**
 * Obstruct the walk without needing a race.
 *
 * An unreadable child cannot be emptied, so the sandbox cannot be `rmdir`ed,
 * and Node's own retries cannot help: they re-issue `rmdir` on a path whose
 * contents they never re-read. Only a *second* walk, run after the obstruction
 * is gone, finishes the job — which is precisely the attempt loop
 * `removeTempDir` wraps around `rmSync`. Unlike the writers above, this needs
 * nothing from the scheduler, so it pins that loop on any machine however
 * loaded (#1869).
 */
function makeBlockedSandbox(): BlockedSandbox {
  const dir = makeTempDir('temp-dir-blocked-');
  const blocked = join(dir, 'objects');
  mkdirSync(blocked);
  writeFileSync(join(blocked, 'racer'), 'x');
  chmodSync(blocked, 0o000);

  let blocks = false;
  try {
    readdirSync(blocked);
  } catch {
    blocks = true;
  }

  const sandbox: BlockedSandbox = {
    dir,
    blocks,
    unblock: () => {
      try {
        chmodSync(blocked, 0o700);
      } catch {
        // Already removed by a successful walk. Nothing left to unblock.
      }
    },
  };
  blockedSandboxes.push(sandbox);
  return sandbox;
}

function skipUnblockable(ctx: { skip: (note?: string) => void }): void {
  ctx.skip('this process reads a 0o000 directory anyway (root?), so the obstruction is not one');
}

describe('removeTempDir — a walk that has to run twice', () => {
  it('re-walks after a failed attempt and removes the sandbox', (ctx) => {
    const sandbox = makeBlockedSandbox();
    if (!sandbox.blocks) return skipUnblockable(ctx);

    const seen: number[] = [];
    const removed = removeTempDir(sandbox.dir, {
      onRetry: (error, attempt) => {
        seen.push(attempt);
        // Node 24 on macOS reports the sandbox's own ENOTEMPTY — the code that
        // turned PR #1660 red; a platform that names the unreadable child
        // instead reports EACCES. Either way the walk failed and only another
        // walk can finish it.
        expect(['ENOTEMPTY', 'EACCES']).toContain(error.code);
        sandbox.unblock();
      },
    });

    expect(seen).toEqual([1]);
    expect(removed).toBe(true);
    expect(existsSync(sandbox.dir)).toBe(false);
    expect(getLeakedTempDirs()).toHaveLength(0);
  });

  it('reports the sandbox it could not remove instead of throwing', (ctx) => {
    const sandbox = makeBlockedSandbox();
    if (!sandbox.blocks) return skipUnblockable(ctx);

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Nothing clears the obstruction, so every attempt fails.
    const removed = removeTempDir(sandbox.dir);
    const reported = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();

    expect(removed).toBe(false);
    expect(existsSync(sandbox.dir)).toBe(true);
    expect(reported).toContain(TEMP_DIR_LEAK_PREFIX);
    expect(reported).toContain(sandbox.dir);
    expect(getLeakedTempDirs()).toContain(sandbox.dir);

    sandbox.unblock();
    expect(removeTempDir(sandbox.dir)).toBe(true);
  });
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
