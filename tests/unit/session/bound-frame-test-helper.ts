/**
 * The test helper that makes BoundFrames (Issue #4304 F1-a, design §4.3: "試験は
 * 試験用の作り手（試験の helper の中だけ）で BoundFrame を作る").
 *
 * Production code can get a `BoundFrame` only from `captureBoundFrame`
 * (`src/lib/session/cli-session.ts`). Tests that replace that module, or the
 * tmux module under it, make theirs here — and nowhere else: the guard
 * `tests/unit/guards/bound-frame-answer-entry-4304.test.ts` holds every
 * `as BoundFrame` cast to `cli-session.ts` and this file.
 *
 * Three kinds of double:
 *
 * - {@link testBoundFrame}: a frame bound to {@link TEST_PANE_GENERATION}.
 * - {@link withPaneGenerationTmuxDoubles}: wraps a `vi.mock('@/lib/tmux/tmux')`
 *   factory's object with `samePaneGeneration` / `readPaneGeneration` /
 *   `readPaneGenerationById` / `capturePaneById`. Each session is one pane of
 *   one server unless a test moves it ({@link setTestPaneGeneration});
 *   `capturePaneById` reads through that object's own `capturePane(session,
 *   lines)` when it has one, so a test that feeds `capturePane` feeds the bound
 *   capture too.
 * - {@link withBoundCaptureCliSessionDoubles}: wraps a
 *   `vi.mock('@/lib/session/cli-session')` factory's object with
 *   `captureBoundFrame` / `checkPaneGeneration`, reading through that object's
 *   `captureSessionOutput` / `captureSessionOutputFresh` (and, for a session
 *   named directly, the wrapped tmux object's `capturePane`).
 *
 * The wrappers keep the very object the factory returns, so the doubles read
 * the test's `vi.fn`s synchronously — no `import()` of a mocked module at call
 * time (that can still be pending when a fake-timer test asserts, and inside
 * the module's own factory it resolves to the REAL module).
 */

import type {
  BoundCapture,
  BoundFrame,
  BoundFrameTarget,
  PaneGeneration,
  PaneGenerationCheck,
} from '@/lib/session/cli-session';
import type { PaneGenerationReading } from '@/lib/tmux/tmux';

/** The generation every double answers with unless a test moves it. */
export const TEST_PANE_GENERATION: PaneGeneration = Object.freeze({
  serverStartTime: '1794589716',
  serverPid: '4242',
  paneId: '%7',
});

/** A frame bound to `generation` (default {@link TEST_PANE_GENERATION}). */
export function testBoundFrame(
  frame: string,
  options: { sessionName?: string; generation?: PaneGeneration; dead?: boolean; headCut?: boolean } = {},
): BoundFrame {
  return {
    kind: 'bound',
    sessionName: options.sessionName ?? 'test-session',
    frame,
    generation: options.generation ?? TEST_PANE_GENERATION,
    dead: options.dead ?? false,
    headCut: options.headCut ?? false,
  } as BoundFrame;
}

/** sessionName → its reading (null: cannot be read), and paneId → sessionName. */
const bySession = new Map<string, PaneGenerationReading | null>();
const byPane = new Map<string, string>();

/** The objects the wrappers were given (one of each per test file). */
const sources: { tmux?: Record<string, unknown>; cliSession?: Record<string, unknown> } = {};

function readingFor(sessionName: string): PaneGenerationReading | null {
  if (!bySession.has(sessionName)) bySession.set(sessionName, { generation: TEST_PANE_GENERATION, dead: false });
  const reading = bySession.get(sessionName) ?? null;
  if (reading !== null) byPane.set(reading.generation.paneId, sessionName);
  return reading;
}

/**
 * Move a session to another pane (a replaced pane), make it unreadable
 * (`null`), or mark it dead. Applies to every double of this module.
 */
export function setTestPaneGeneration(sessionName: string, reading: PaneGenerationReading | null): void {
  bySession.set(sessionName, reading);
  if (reading !== null) byPane.set(reading.generation.paneId, sessionName);
}

/** Forget every session's pane: each is {@link TEST_PANE_GENERATION} again. Call in `beforeEach`. */
export function resetTestPaneGenerations(): void {
  bySession.clear();
  byPane.clear();
}

function sameGeneration(a: PaneGeneration, b: PaneGeneration): boolean {
  return a.serverStartTime === b.serverStartTime && a.serverPid === b.serverPid && a.paneId === b.paneId;
}

type CaptureFn = (session: string, lines?: number) => Promise<string>;
type SessionReadFn = (worktreeId: string, cliToolId: string, lines?: number, instanceId?: string) => Promise<string>;

/** The tmux doubles {@link withPaneGenerationTmuxDoubles} adds. */
export interface PaneGenerationTmuxDoubles {
  samePaneGeneration: (a: PaneGeneration, b: PaneGeneration) => boolean;
  readPaneGeneration: (sessionName: string) => Promise<PaneGenerationReading | null>;
  readPaneGenerationById: (paneId: string) => Promise<PaneGenerationReading | null>;
  capturePaneById: (paneId: string, lines: number) => Promise<string>;
}

/**
 * `vi.mock('@/lib/tmux/tmux', async () => (await import(helper)).withPaneGenerationTmuxDoubles({ … }))`.
 * The factory's own entries win over the doubles; a partial mock passes the
 * real module as `base`, which the doubles win over (its `readPaneGeneration`
 * would reach the tmux server the test runs under).
 */
export function withPaneGenerationTmuxDoubles<T extends object>(
  module: T,
  base: object = {},
): PaneGenerationTmuxDoubles & T {
  sources.tmux = module as Record<string, unknown>;
  const doubles: PaneGenerationTmuxDoubles = {
    samePaneGeneration: sameGeneration,
    readPaneGeneration: async (sessionName) => readingFor(sessionName),
    readPaneGenerationById: async (paneId) => {
      const sessionName = byPane.get(paneId);
      if (sessionName === undefined) return null;
      const reading = readingFor(sessionName);
      return reading !== null && reading.generation.paneId === paneId ? reading : null;
    },
    capturePaneById: async (paneId, lines) => {
      const sessionName = byPane.get(paneId);
      if (sessionName === undefined) throw new Error(`Failed to capture pane: can't find pane: ${paneId}`);
      const capturePane = (module as Record<string, unknown>).capturePane;
      if (typeof capturePane !== 'function') return '';
      return (await (capturePane as CaptureFn)(sessionName, lines)) ?? '';
    },
  };
  return { ...base, ...doubles, ...module } as PaneGenerationTmuxDoubles & T;
}

function targetSession(target: BoundFrameTarget): string {
  return 'sessionName' in target ? target.sessionName : `${target.cliToolId}:${target.worktreeId}:${target.instanceId ?? ''}`;
}

/** The cli-session doubles {@link withBoundCaptureCliSessionDoubles} adds. */
export interface BoundCaptureCliSessionDoubles {
  captureBoundFrame: (
    target: BoundFrameTarget,
    options?: { lines?: number; expected?: PaneGeneration; window?: 'sliced' | 'tmux' },
  ) => Promise<BoundCapture>;
  checkPaneGeneration: (sessionName: string, expected: PaneGeneration) => Promise<PaneGenerationCheck>;
  readSessionPaneGeneration: (sessionName: string) => Promise<PaneGenerationReading | null>;
}

/**
 * `vi.mock('@/lib/session/cli-session', async () => (await import(helper)).withBoundCaptureCliSessionDoubles({ … }))`.
 * The factory's own entries win over the doubles.
 *
 * The frame of a worktree target is what the object's `captureSessionOutputFresh`
 * (routes: no window named) or `captureSessionOutput` (the Auto-Yes poller: a
 * window named) answers — the one that caller read before #4304, falling back
 * to the other; a throw is a `capture-failed` unknown. A session named
 * directly (the sender's own reads) reads the tmux object wrapped by
 * {@link withPaneGenerationTmuxDoubles}, when there is one.
 */
export function withBoundCaptureCliSessionDoubles<T extends object>(module: T): BoundCaptureCliSessionDoubles & T {
  sources.cliSession = module as Record<string, unknown>;
  const doubles: BoundCaptureCliSessionDoubles = {
    captureBoundFrame: async (target, options = {}) => {
      const sessionName = targetSession(target);
      const before = readingFor(sessionName);
      if (before === null) return { kind: 'unknown', reason: 'generation-unreadable', sessionName };
      if (options.expected !== undefined && !sameGeneration(before.generation, options.expected)) {
        return { kind: 'unknown', reason: 'generation-mismatch', sessionName };
      }
      let frame: string | undefined = '';
      try {
        if (!('sessionName' in target)) {
          const cached = sources.cliSession?.captureSessionOutput;
          const fresh = sources.cliSession?.captureSessionOutputFresh;
          const read = (options.lines === undefined ? fresh ?? cached : cached ?? fresh) as SessionReadFn | undefined;
          if (typeof read === 'function') {
            frame = await read(target.worktreeId, target.cliToolId, options.lines, target.instanceId);
          }
        } else {
          const capturePane = sources.tmux?.capturePane;
          if (typeof capturePane === 'function') frame = await (capturePane as CaptureFn)(target.sessionName, options.lines);
        }
      } catch {
        return { kind: 'unknown', reason: 'capture-failed', sessionName };
      }
      return testBoundFrame(frame ?? '', { sessionName, generation: before.generation, dead: before.dead });
    },
    checkPaneGeneration: async (sessionName, expected) => {
      const now = readingFor(sessionName);
      if (now === null) return 'generation-unreadable';
      if (!sameGeneration(now.generation, expected)) return 'generation-mismatch';
      return now.dead ? 'pane-dead' : 'same';
    },
    readSessionPaneGeneration: async (sessionName) => readingFor(sessionName),
  };
  return { ...doubles, ...module };
}
