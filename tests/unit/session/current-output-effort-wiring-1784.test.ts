/**
 * The join between the effort's holder (#1784) and its exposure (#1785).
 *
 * Phase 2 (#1784) built the retention layer and Phase 3 (#1785) built the
 * payload key, the `EFFORT` column and the `capture --json` field — in parallel,
 * each green on its own, with a `return null` seam between them that nobody
 * removed. So `commandmate capture <id> --json | jq '.reasoningEffort'` answered
 * null on every session in the world, including the ones whose effort #1784
 * could see perfectly well, and no suite in the repo could notice: #1784's tests
 * stop at the retention layer's own readers, and #1785's assert the field as a
 * *schema* ("present, string or null") precisely so #1784's arrival would not
 * turn them red.
 *
 * This file is the assertion neither of them could make: a value latched on one
 * side comes out the other. It asserts the effort as a VALUE, which is the whole
 * point — re-stub `resolveReasoningEffort`-style constant null and every test
 * here goes red.
 *
 * `model` is pinned here too, for the coherence rule the builder now depends on:
 * both halves come out of ONE `getResolvedAgentModelInfo` call, so the payload
 * can never publish an effort next to a null model.
 *
 * The state lives on `globalThis` and CI runs with `fileParallelism: false`, so
 * `clearAgentStopEvents` runs before *and* after each test.
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
  buildCompositeKey: vi.fn(() => 'wt-wiring:codex'),
}));

import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';

const WT = 'wt-wiring';

/** A frame with nothing interesting in it: no assertion here turns on detection. */
const PLAIN_FRAME = 'building the thing\nstill building the thing\n';

/**
 * Latch what a capture showed, exactly the way the status poll does
 * (`worktree-status-helper` → `recordCapturedModelInfo`). The screen is the only
 * source of an effort — no agent's hook payload carries one.
 */
function reportCapture(
  cliToolId: CLIToolType,
  instanceId: string,
  info: { model?: string | null; effort?: string | null }
): void {
  recordCapturedModelInfo(WT, cliToolId, instanceId, {
    model: info.model ?? null,
    effort: info.effort ?? null,
  });
}

/** One hook delivery carrying a model, the way claude's `SessionStart` does. */
function reportHookModel(cliToolId: CLIToolType, instanceId: string, model: string): void {
  recordAgentEvent(WT, cliToolId, instanceId, {
    event: 'session_start',
    at: 1_800_000_000_000,
    detail: null,
    sessionId: 'ses-wiring',
    model,
  });
}

async function build(
  cliToolId: CLIToolType,
  instanceId: string
): Promise<Awaited<ReturnType<typeof buildCurrentOutput>>> {
  return buildCurrentOutput({} as Database.Database, WT, cliToolId, instanceId);
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

describe('reasoningEffort reaches the payload (Issue #1784 → #1785)', () => {
  it('publishes the effort the retention layer holds for this instance', async () => {
    // The regression this file exists for: before the wiring, this session —
    // whose effort #1784 had already latched — still answered null.
    reportCapture('codex', 'codex', { model: 'gpt-5.6-sol', effort: 'xhigh' });

    const payload = await build('codex', 'codex');

    expect(payload.reasoningEffort).toBe('xhigh');
  });

  it('publishes it verbatim, with the model beside it', async () => {
    reportCapture('codex', 'codex', { model: 'gpt-5.6-sol', effort: 'low' });

    const payload = await build('codex', 'codex');

    expect(payload).toEqual(
      expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'low' })
    );
  });

  it('publishes null — never throws — when no layer holds an effort', async () => {
    // The ordinary state for gemini and copilot, whose chrome shows neither, and
    // for any session that predates this server process.
    const payload = await build('gemini', 'gemini');

    expect(payload).toHaveProperty('reasoningEffort');
    expect(payload.reasoningEffort).toBeNull();
  });

  it('publishes null for a stopped session even after an effort was latched', async () => {
    // The latch deliberately never expires (an eight-hour turn is at the same
    // effort at the end as at the start), so "the session is dead" is the one
    // thing that has to override it — exactly the rule #1785 fixed for `model`.
    // Asserted AFTER a successful read, or it would be green with no rule at all.
    reportCapture('codex', 'codex', { model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect((await build('codex', 'codex')).reasoningEffort).toBe('xhigh');

    isRunning.mockResolvedValue(false);
    const payload = await build('codex', 'codex');

    expect(payload.isRunning).toBe(false);
    expect(payload.reasoningEffort).toBeNull();
    expect(payload.model).toBeNull();
  });

  it("does not leak another instance's effort", async () => {
    reportCapture('codex', 'codex-2', { model: 'gpt-5.6-sol', effort: 'xhigh' });

    expect((await build('codex', 'codex')).reasoningEffort).toBeNull();
  });
});

describe('one resolution for both halves', () => {
  it('applies antigravity\'s id-derived effort, which the scraped half alone would drop', async () => {
    // agy encodes the level in the id it reports on every event, and
    // `mergeModelInfo` prefers it over the status bar. Reading the scraped
    // effort directly would answer null here — this is the assertion that pins
    // the builder to the *resolver* rather than to the raw latch.
    reportHookModel('antigravity', 'antigravity', 'gemini-3.7-flash-high');

    const payload = await build('antigravity', 'antigravity');

    expect(payload.model).toBe('gemini-3.7-flash-high');
    expect(payload.reasoningEffort).toBe('high');
  });

  it('lets the hook-reported model win over the screen, as #1784 specifies', async () => {
    reportHookModel('codex', 'codex', 'gpt-5.6-sol');
    reportCapture('codex', 'codex', { model: 'GPT-5.6 (sol)', effort: 'medium' });

    const payload = await build('codex', 'codex');

    expect(payload.model).toBe('gpt-5.6-sol');
    expect(payload.reasoningEffort).toBe('medium');
  });

  it('never publishes an effort next to a null model', async () => {
    // The claude-before-its-first-hook case: the poll scraped the banner, no
    // `SessionStart` has arrived. Taking `model` off the hook latch while taking
    // `reasoningEffort` off the resolver produced exactly the row
    // `buildModelByInstance` documents as unreachable — an effort with nothing
    // to attach it to, which the CLI's EFFORT column would print on its own.
    reportCapture('claude', 'claude', { model: 'Claude Opus 5', effort: 'xhigh' });

    const payload = await build('claude', 'claude');

    expect(payload.reasoningEffort).toBe('xhigh');
    expect(payload.model).toBe('Claude Opus 5');
  });
});

describe('the field both CLI surfaces read', () => {
  it('is the one key `capture --json` and `instances` pass through verbatim', async () => {
    // Both CLI commands read this payload and forward `?? null` without a rule
    // of their own (`capture.ts`, `instances.ts` — pinned by
    // capture-model-1785 / instances-model-1785). So the value asserted here is
    // literally what `jq '.reasoningEffort'` and the EFFORT column print, and
    // this payload is the only place the join could have been made.
    reportCapture('codex', 'codex', { model: 'gpt-5.6-sol', effort: 'xhigh' });

    const payload = await build('codex', 'codex');

    expect(payload.reasoningEffort).toBe('xhigh');
    expect(typeof payload.reasoningEffort).toBe('string');
  });
});
