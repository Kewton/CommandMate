/**
 * The Quick Tunnel must outlive `commandmate remote` (Issue #2146).
 *
 * ## Why this file exists at all
 *
 * R2's suite was 12/12 green while shipping a tunnel that died a second or two
 * after the command returned, and the reason is structural rather than an
 * oversight: `deps.spawn` is a test double, so no real process is ever created,
 * no real pipe is ever opened, and the parent never exits. The failure mode is
 * made entirely of those three things. **Another mocked test would have been
 * green too**, so this file uses real processes.
 *
 * ## The mechanism, measured in `docs/qa/1937-remote-uat-record.md` D-1
 *
 * `commandmate remote up` takes the URL from the metrics API at about t+6.5s
 * and calls `process.exit()`. If fd 2 of the child is a **pipe**, the parent
 * owns the read end; exiting closes it, and cloudflared — Go, which does not
 * ignore SIGPIPE — dies on its next write to fd 2. At t+6.5s it is still mid
 * log-burst, so the next write is milliseconds away. The public URL then answers
 * HTTP 530 before anyone can point a phone at the QR code.
 *
 * ## How this reproduces it without cloudflared
 *
 * Nothing about the bug is specific to cloudflared, to Cloudflare, or to the
 * network. Two throwaway scripts are enough:
 *
 * - `tests/fixtures/remote/stderr-writer.cjs` — writes to fd 2 every 10ms and
 *   does not catch the error, so a broken pipe ends it. That is the one
 *   property of cloudflared that matters here.
 * - `tests/fixtures/remote/short-lived-parent.cjs` — spawns it with a stdio
 *   shape given on the command line, prints the pid, and exits immediately.
 *   That is `remote up` with everything else removed.
 *
 * The test is the grandparent: it runs the parent to completion, then asks
 * whether the grandchild is still there.
 *
 * ## What makes it bite rather than merely pass
 *
 * 1. The shape the parent is driven with is **read out of the production
 *    Provider** by running `start()` against a spawn double and capturing the
 *    options. Putting `stdio: ['ignore', 'ignore', 'pipe']` back into
 *    `cloudflare.ts` therefore changes what this test runs, and it goes red.
 *    (Verified by doing exactly that before the fix was written.)
 * 2. The pipe form is run too, as a **positive control**, and is asserted to
 *    kill the grandchild. Without it, "the grandchild survived" would be equally
 *    consistent with a harness that cannot observe death at all.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, type SpawnOptions } from 'child_process';
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  CLOUDFLARED_LOG_NAME,
  createCloudflareProvider,
  type QuickTunnelProcess,
} from '@/lib/remote/cloudflare';

const STANDIN_SCRIPT = resolve(__dirname, '../../../fixtures/remote/stderr-writer.cjs');
const PARENT_SCRIPT = resolve(__dirname, '../../../fixtures/remote/short-lived-parent.cjs');

/**
 * A private state directory per test process.
 *
 * Not a fixed path under /tmp: sibling git worktrees run this suite at the same
 * time on this machine, and a shared file name is how those runs poison each
 * other's log.
 */
const STATE_DIR = mkdtempSync(join(tmpdir(), 'cm-remote-2146-'));

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Reading the shape out of the production Provider
// ---------------------------------------------------------------------------

/**
 * What slot 2 of `stdio` is, in a form that survives being handed to another
 * process. A descriptor number is meaningless outside the process that opened
 * it, so a descriptor is reported as `'file'` and the parent script opens the
 * same path itself.
 */
type StderrKind = 'pipe' | 'ignore' | 'inherit' | 'file';

interface SpawnShape {
  stderr: StderrKind;
  detached: boolean;
  unref: boolean;
  /** True when slot 2 was a descriptor and it pointed at a regular file. */
  stderrIsRegularFile: boolean;
}

/**
 * Runs the real `start()` against a spawn double and reports the shape it built.
 *
 * This is the coupling between the mechanism proven below and the code that
 * ships. Everything the parent script is told comes from here.
 */
async function productionSpawnShape(): Promise<SpawnShape> {
  let captured: SpawnOptions | undefined;
  let stderrIsRegularFile = false;
  let unrefCalls = 0;

  const child: QuickTunnelProcess = {
    pid: 424242,
    once: () => child,
    kill: () => true,
    unref: () => {
      unrefCalls += 1;
      return child;
    },
  };

  const provider = createCloudflareProvider({
    spawn: (_command, _args, options) => {
      captured = options;
      const slot = (options.stdio as unknown[])[2];
      // Checked here rather than after `start()` returns: the Provider closes
      // its own copy of the descriptor the moment `spawn` comes back.
      if (typeof slot === 'number') stderrIsRegularFile = fstatSync(slot).isFile();
      return child;
    },
    findFreePort: async () => 45678,
    fetchHostname: async () => 'shape-probe.trycloudflare.com',
    resolveStateDir: () => STATE_DIR,
    timing: { urlWaitMs: 2000, metricsPreferenceMs: 0, pollIntervalMs: 1 },
  });

  await provider.start({ port: 3000, signal: new AbortController().signal });

  if (captured === undefined) throw new Error('start() did not spawn anything');
  const slot = (captured.stdio as unknown[])[2];

  return {
    stderr: typeof slot === 'number' ? 'file' : (slot as StderrKind),
    detached: captured.detached === true,
    unref: unrefCalls > 0,
    stderrIsRegularFile,
  };
}

// ---------------------------------------------------------------------------
// Driving real processes
// ---------------------------------------------------------------------------

interface ParentSpec {
  standin: string;
  stderr: StderrKind;
  logPath: string;
  detached: boolean;
  unref: boolean;
}

/** Runs the short-lived parent to completion and returns the grandchild's pid. */
function runShortLivedParent(spec: Omit<ParentSpec, 'standin' | 'logPath'>): number {
  const payload: ParentSpec = {
    standin: STANDIN_SCRIPT,
    logPath: join(STATE_DIR, 'standin-stderr.log'),
    ...spec,
  };
  const result = spawnSync(process.execPath, [PARENT_SCRIPT, JSON.stringify(payload)], {
    encoding: 'utf-8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  // `spawnSync` returns only after the parent has exited, so by the time this
  // assertion runs the read end of any pipe is already closed.
  expect(result.status, result.stderr).toBe(0);

  const pid = (JSON.parse(result.stdout.trim()) as { pid: number }).pid;
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

/** EPERM means the process exists and belongs to somebody else — still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

async function diedWithin(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(10);
  }
  return !isAlive(pid);
}

async function stayedAliveFor(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return false;
    await delay(10);
  }
  return isAlive(pid);
}

function reap(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, which is the state this wanted anyway.
  }
}

// ---------------------------------------------------------------------------

describe('a Quick Tunnel survives the CLI that started it (Issue #2146)', () => {
  it(
    'positive control: with fd 2 on a pipe, the child dies when the parent exits',
    async () => {
      // This is mutation A from the UAT record, run every time so that the
      // survival assertion below cannot be vacuously green. If this ever stops
      // being red-making, the harness has stopped modelling the bug and the
      // test underneath it means nothing.
      const pid = runShortLivedParent({ stderr: 'pipe', detached: false, unref: false });
      try {
        await expect(diedWithin(pid, 5000)).resolves.toBe(true);
      } finally {
        reap(pid);
      }
    },
    20_000,
  );

  it(
    'the shape start() actually builds leaves the child running',
    async () => {
      // The shape is not written down here on purpose — it is read out of the
      // Provider. Reverting cloudflare.ts to `['ignore', 'ignore', 'pipe']`
      // turns this into the positive control above, and it fails.
      const shape = await productionSpawnShape();

      const pid = runShortLivedParent({
        stderr: shape.stderr,
        detached: shape.detached,
        unref: shape.unref,
      });
      try {
        await expect(stayedAliveFor(pid, 750)).resolves.toBe(true);
      } finally {
        reap(pid);
      }
    },
    20_000,
  );

  it('puts a real file on fd 2, and never a pipe', async () => {
    const shape = await productionSpawnShape();

    expect(shape.stderr).toBe('file');
    expect(shape.stderrIsRegularFile).toBe(true);
    // Named separately from the check above so the failure message says which
    // of the two mistakes was made.
    expect(shape.stderr).not.toBe('pipe');
  });

  it('detaches the child and drops the event-loop reference to it', async () => {
    // `detached` is what keeps a Ctrl-C in the launching terminal from reaching
    // the tunnel; `unref` is what stops the CLI's event loop being held open by
    // a child it never waits for. Neither fixes the pipe, and neither is
    // sufficient on its own — they are the other half of "outlives the CLI".
    const shape = await productionSpawnShape();

    expect(shape.detached).toBe(true);
    expect(shape.unref).toBe(true);
  });

  it('creates the log file where a human can find it', async () => {
    await productionSpawnShape();

    const logPath = join(STATE_DIR, CLOUDFLARED_LOG_NAME);
    expect(existsSync(logPath)).toBe(true);
    // Opened with 'w', so a previous session's banner cannot be read back as
    // this session's URL.
    expect(readFileSync(logPath, 'utf-8')).toBe('');
  });
});
