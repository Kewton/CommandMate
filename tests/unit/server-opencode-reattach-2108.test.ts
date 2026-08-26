/**
 * The startup call that makes the sweep happen at all (Issue #2108).
 *
 * `src/lib/hooks/sources/opencode/reattach.ts` was never the missing piece —
 * `recoverOpencodePort` had done the whole recovery since #1763. What was
 * missing was a **caller at startup**, so the property worth pinning is not the
 * sweep's behaviour (that is `tests/unit/hooks/sources/opencode-reattach-2108`
 * and `tests/integration/opencode-reattach-startup-2108`) but the two things
 * `server.ts` promises about it:
 *
 *  1. it runs on boot, and
 *  2. it does **not** block the boot — the managers after it must not queue
 *     behind a health probe against a pane whose server has died.
 *
 * Shaped like `tests/unit/proxy/server-raw-url.test.ts` and for the same reason
 * (#1804 / #1428): `server.ts` cannot be imported from a test — importing it
 * boots Next, opens a port, runs migrations and registers signal handlers — and
 * the block must not be refactored into an importable helper, because adding a
 * module graph to server.ts's eval-time graph perturbs Next's AsyncLocalStorage
 * bootstrap under `tsx server.ts`. So the shipped bytes are read, the block is
 * cut out by anchors and **executed** against a fake loader, which keeps every
 * assertion behavioural rather than a source-text pattern match.
 *
 * The one substitution is `await import(` -> `await __load(`: a dynamic import
 * of a real path would pull `better-sqlite3` and the whole hooks graph into
 * this test, which is exactly what the production code defers it to avoid.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/** Comment that opens the Issue #2108 block in server.ts. */
const BLOCK_START_ANCHOR = '    // Issue #2108: re-open the event streams of opencode panes that outlived';
/** Comment that immediately follows the block. */
const BLOCK_END_ANCHOR = '    // Issue #1623: reconcile the `prefix+g` reading-mode binding';

const SERVER_TS_PATH = path.resolve(process.cwd(), 'server.ts');

/** The module path the block is required to load. */
const REATTACH_MODULE = './src/lib/hooks/sources/opencode/reattach';

/**
 * Cut the block out of the shipped `server.ts`.
 *
 * Throws when either anchor moves, so a relocated block fails loudly instead of
 * making every assertion below vacuously pass against an empty string.
 */
function extractReattachBlock(): string {
  const source = readFileSync(SERVER_TS_PATH, 'utf8');
  const startIndex = source.indexOf(BLOCK_START_ANCHOR);
  if (startIndex === -1) {
    throw new Error(
      `server.ts no longer contains the anchor ${BLOCK_START_ANCHOR}; ` +
        'update tests/unit/server-opencode-reattach-2108.test.ts to match.'
    );
  }
  const endIndex = source.indexOf(BLOCK_END_ANCHOR, startIndex);
  if (endIndex === -1) {
    throw new Error(
      `server.ts no longer contains the anchor ${BLOCK_END_ANCHOR}; ` +
        'update tests/unit/server-opencode-reattach-2108.test.ts to match.'
    );
  }
  const block = source.slice(startIndex, endIndex);
  if (!block.includes(REATTACH_MODULE)) {
    throw new Error(`the extracted block does not load ${REATTACH_MODULE}`);
  }
  return block.replace(/await import\(/g, 'await __load(');
}

type Loader = (specifier: string) => Promise<Record<string, unknown>>;

/** `new Function` for async bodies, so a block that `await`s still compiles. */
const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<void>;

/**
 * Compile the block into `(__load, console, __next) => Promise<void>`, with
 * `__next()` appended.
 *
 * `__next` stands for `initScheduleManager()` and the managers after it: the
 * block is inside `server.listen`'s async callback, so "does not block the
 * boot" means precisely "the next statement runs before the sweep settles".
 * Compiled as an **async** function on purpose — a regression that `await`s the
 * sweep has to be compilable here, or the test would go red for a syntax error
 * instead of for the property it is about.
 */
function compileReattachBlock(): (
  load: Loader,
  log: typeof console,
  next: () => void
) => Promise<void> {
  return new AsyncFunction(
    '__load',
    'console',
    '__next',
    `${extractReattachBlock()}\n__next();`
  ) as (load: Loader, log: typeof console, next: () => void) => Promise<void>;
}

/** A console that records instead of printing. */
function recordingConsole(): { log: string[]; error: unknown[][]; console: typeof console } {
  const log: string[] = [];
  const error: unknown[][] = [];
  return {
    log,
    error,
    console: {
      log: (message: string) => log.push(message),
      error: (...args: unknown[]) => error.push(args),
    } as unknown as typeof console,
  };
}

describe('[#2108] server.ts starts the opencode reattach sweep', () => {
  const run = compileReattachBlock();

  it('loads the sweep module and calls it', async () => {
    const reattachOpencodeEventStreams = vi
      .fn()
      .mockResolvedValue({ persisted: 3, candidates: 1, reattached: 1, skipped: 0 });
    const load = vi.fn(async () => ({ reattachOpencodeEventStreams }));
    const recorder = recordingConsole();

    await run(load, recorder.console, () => {});
    await vi.waitFor(() => expect(reattachOpencodeEventStreams).toHaveBeenCalledTimes(1));

    expect(load).toHaveBeenCalledWith(REATTACH_MODULE);
    await vi.waitFor(() =>
      expect(recorder.log).toEqual([
        'opencode streams reattached: 1/1 live pane(s) (persisted=3 skipped=0)',
      ])
    );
  });

  it('lets the managers after it start before the sweep settles', async () => {
    // The acceptance condition "起動を遅らせないこと". A pane whose server has
    // died costs a health-probe timeout, and `initScheduleManager()` and the
    // managers after it must not wait for it.
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reattachOpencodeEventStreams = vi.fn(async () => {
      await settled;
      return { persisted: 1, candidates: 1, reattached: 1, skipped: 0 };
    });
    const recorder = recordingConsole();
    const next = vi.fn();

    await run(async () => ({ reattachOpencodeEventStreams }), recorder.console, next);

    expect(next).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(reattachOpencodeEventStreams).toHaveBeenCalled());
    // Still in flight, and the boot has moved on without it.
    expect(recorder.log).toEqual([]);
    release();
    await vi.waitFor(() => expect(recorder.log).toHaveLength(1));
  });

  it('says nothing when there was no live pane to reattach', async () => {
    const recorder = recordingConsole();
    await run(
      async () => ({
        reattachOpencodeEventStreams: vi
          .fn()
          .mockResolvedValue({ persisted: 7, candidates: 0, reattached: 0, skipped: 0 }),
      }),
      recorder.console,
      () => {}
    );

    await vi.waitFor(() => expect(recorder.error).toEqual([]));
    expect(recorder.log).toEqual([]);
  });

  it('does not take the boot down when the sweep cannot be loaded', async () => {
    const recorder = recordingConsole();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await run(
        async () => {
          throw new Error('module not found');
        },
        recorder.console,
        () => {}
      );
      await vi.waitFor(() => expect(recorder.error).toHaveLength(1));
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(recorder.error[0][0]).toBe('Error reattaching opencode event streams:');
    expect(rejections).toEqual([]);
  });
});
