/**
 * `model` / `reasoningEffort` on the current-output payload (Issue #1785).
 *
 * Phase 3 is exposure, not retention: Phase 1 (#1783) already latches the model
 * the agent reports about itself, and this suite's job is to prove the value
 * actually reaches the payload `commandmate capture --json` prints — the join
 * that `agent-model-state-1783` (the latch) cannot see from its side.
 *
 * Three things are pinned here that a careless version of this suite would miss:
 *
 *  - **not-running answers null**, and it has to be asserted *after* a model was
 *    latched. The latch deliberately never expires (an eight-hour turn is on the
 *    same model at the end as at the start), so "the session is dead" is the one
 *    thing that must override it, and a test that never latches anything first
 *    is green whether the override exists or not.
 *  - **`reasoningEffort` is checked as a schema, never as a value.** Its holding
 *    layer is Phase 2 (#1784), landing in parallel, so today the honest answer
 *    is null for every session. Asserting `toBeNull()` would turn #1784's
 *    arrival into a red suite in a file it has no business editing; asserting
 *    "present, and a string or null" is true before and after.
 *  - **the fields orchestrate-monitor parses are still there.** #1785 is
 *    additive by requirement, and the recipe that supervises parallel workers
 *    reads `content` / `realtimeSnippet` / `sessionStatus` / `sessionStatusReason`
 *    off this same payload.
 *
 * The state lives on `globalThis` and CI runs with `fileParallelism: false`, so
 * `clearAgentStopEvents` runs before *and* after each test — a model latched
 * here and read by an unrelated suite is a failure that only reproduces in CI,
 * in file order.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1785:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';

const WT = 'wt-1785';
const INSTANCE = 'claude-2';
const NOW = 1_800_000_000_000;

/** A frame with nothing interesting in it: no assertion here turns on detection. */
const PLAIN_FRAME = 'building the thing\nstill building the thing\n';

/** One hook delivery that carries a model, the way claude's `SessionStart` does. */
function reportModel(model: string, instanceId = INSTANCE): void {
  recordAgentEvent(WT, 'claude', instanceId, {
    event: 'session_start',
    at: NOW,
    detail: null,
    sessionId: 'ses-1785',
    model,
  });
}

async function build(): Promise<Awaited<ReturnType<typeof buildCurrentOutput>>> {
  return buildCurrentOutput({} as Database.Database, WT, 'claude', INSTANCE);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(PLAIN_FRAME);
});

afterEach(() => {
  clearAgentStopEvents();
});

describe('model', () => {
  it('publishes the model the agent reported about itself', async () => {
    reportModel('claude-opus-5[1m]');

    const payload = await build();

    expect(payload.model).toBe('claude-opus-5[1m]');
  });

  it('publishes it verbatim — no parsing, no prettifying', async () => {
    // The value is compared against what the agent says about itself (`/status`,
    // `agy models`, the codex footer). Anything the CLI "cleaned up" on the way
    // out would break that comparison exactly when someone is using it.
    reportModel('gpt-5.6-sol');

    expect((await build()).model).toBe('gpt-5.6-sol');
  });

  it('publishes null when nothing has ever reported one', async () => {
    // The ordinary state for gemini and copilot, which put no model in any hook
    // payload, and for any session that predates this server process.
    expect((await build()).model).toBeNull();
  });

  it("does not leak another instance's model", async () => {
    reportModel('claude-opus-5[1m]', 'claude-3');

    expect((await build()).model).toBeNull();
  });

  it('publishes null for a stopped session even after a model was latched', async () => {
    reportModel('claude-opus-5[1m]');
    expect((await build()).model).toBe('claude-opus-5[1m]');

    isRunning.mockResolvedValue(false);
    const payload = await build();

    expect(payload.isRunning).toBe(false);
    expect(payload.model).toBeNull();
  });
});

describe('reasoningEffort', () => {
  // Schema, never a value — see the file header. These two assertions hold
  // today (always null) and go on holding once #1784 starts filling it in.
  const isEffort = (value: unknown): boolean => value === null || typeof value === 'string';

  it('is always present on a running session', async () => {
    reportModel('gpt-5.6-sol');

    const payload = await build();

    expect(payload).toHaveProperty('reasoningEffort');
    expect(isEffort(payload.reasoningEffort)).toBe(true);
  });

  it('is always present on a stopped session', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await build();

    expect(payload).toHaveProperty('reasoningEffort');
    expect(isEffort(payload.reasoningEffort)).toBe(true);
  });

  it('is null while no layer holds an effort (pre-#1784 state, stated not asserted)', async () => {
    // Deliberately phrased as "the retention layer answers nothing yet" rather
    // than "the field is null": when #1784 lands it will report an effort for
    // codex/claude sessions, and this expectation is written to be *deleted*
    // then, not edited. Every other assertion in this file survives untouched.
    expect((await build()).reasoningEffort).toBeNull();
  });
});

describe('additivity (Issue #1785 requirement 3)', () => {
  it('leaves every field the orchestrate-monitor recipe parses in place', async () => {
    reportModel('claude-opus-5[1m]');

    const payload = await build();

    expect(payload.content).toContain('building the thing');
    expect(typeof payload.realtimeSnippet).toBe('string');
    expect(typeof payload.sessionStatus).toBe('string');
    expect(typeof payload.sessionStatusReason).toBe('string');
    expect(payload.fullOutput).toBe(PLAIN_FRAME);
  });
});
