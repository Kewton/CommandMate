/**
 * `server.ts` starts OpenCode V2's startup sweep (Issue #2934, D3 / D5).
 *
 * Same method as `server-opencode-reattach-2108.test.ts`: the block is cut out
 * of the shipped `server.ts` between its own comment and v1's, compiled with a
 * stand-in loader and console, and run. What is pinned: it loads
 * `opencode-v2/reattach` and calls the sweep, it does not hold up what follows,
 * it logs counts only, and a failure is contained.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/** Comment that opens the Issue #2934 block in server.ts. */
const BLOCK_START_ANCHOR = '    // Issue #2934: re-open the event streams of OpenCode V2 (`opencode-v2`)';
/** Comment that immediately follows the block: v1's own sweep (Issue #2108). */
const BLOCK_END_ANCHOR = '    // Issue #2108: re-open the event streams of opencode panes that outlived';

const SERVER_TS_PATH = path.resolve(process.cwd(), 'server.ts');

/** The module path the block is required to load. */
const REATTACH_MODULE = './src/lib/hooks/sources/opencode-v2/reattach';

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
        'update tests/unit/server-opencode-v2-reattach-2934.test.ts to match.'
    );
  }
  const endIndex = source.indexOf(BLOCK_END_ANCHOR, startIndex);
  if (endIndex === -1) {
    throw new Error(
      `server.ts no longer contains the anchor ${BLOCK_END_ANCHOR}; ` +
        'update tests/unit/server-opencode-v2-reattach-2934.test.ts to match.'
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

describe('[#2934] server.ts starts the OpenCode V2 reattach sweep', () => {
  const run = compileReattachBlock();

  it('loads the sweep module and calls it, logging counts only', async () => {
    const reattachOpencodeV2EventStreams = vi
      .fn()
      .mockResolvedValue({ known: 3, candidates: 1, reattached: 1, swept: 2 });
    const load = vi.fn(async () => ({ reattachOpencodeV2EventStreams }));
    const recorder = recordingConsole();

    await run(load, recorder.console, () => {});
    await vi.waitFor(() => expect(reattachOpencodeV2EventStreams).toHaveBeenCalledTimes(1));

    expect(load).toHaveBeenCalledWith(REATTACH_MODULE);
    await vi.waitFor(() =>
      expect(recorder.log).toEqual([
        'opencode-v2 streams reattached: 1/1 live pane(s) (known=3 swept=2)',
      ])
    );
  });

  it('lets what follows start before the sweep settles', async () => {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reattachOpencodeV2EventStreams = vi.fn(async () => {
      await settled;
      return { known: 1, candidates: 1, reattached: 1, swept: 0 };
    });
    const recorder = recordingConsole();
    const next = vi.fn();

    await run(async () => ({ reattachOpencodeV2EventStreams }), recorder.console, next);

    expect(next).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(reattachOpencodeV2EventStreams).toHaveBeenCalled());
    expect(recorder.log).toEqual([]);
    release();
    await vi.waitFor(() => expect(recorder.log).toHaveLength(1));
  });

  it('says nothing when nothing is on disk', async () => {
    const recorder = recordingConsole();
    await run(
      async () => ({
        reattachOpencodeV2EventStreams: vi
          .fn()
          .mockResolvedValue({ known: 0, candidates: 0, reattached: 0, swept: 0 }),
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

    expect(recorder.error[0][0]).toBe('Error reattaching opencode-v2 event streams:');
    expect(rejections).toEqual([]);
  });

  it('never names a password or reads a file itself', () => {
    const block = extractReattachBlock();
    expect(block).not.toMatch(/readFile|readOpencodeV2Password|OPENCODE_SERVER_PASSWORD/);
    expect(block).not.toMatch(/console\.log\([^)]*password/i);
  });
});
