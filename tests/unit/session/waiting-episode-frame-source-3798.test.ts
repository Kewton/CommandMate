/**
 * Issue #3798 (PR 1b, review P2): the frame an observer reads is dated by the
 * tmux capture that produced it, and only a capture the observer started
 * itself counts as "fetched after its start" (design I6).
 *
 * Driven through the real capture cache and the real `cli-session` capture
 * functions, with only the tmux transport stood in for — so the time a fresh
 * capture writes back, and where a frame came from (its own fetch, the cache,
 * a fetch joined in flight), are what production records.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        id,
        name: id,
        getSessionName: (worktreeId: string) => `mcbd-${id}-${worktreeId}`,
      }),
    }),
  },
}));

const transport = vi.hoisted(() => ({
  sessionExists: vi.fn(async () => true),
  captureSnapshot: vi.fn<(...a: unknown[]) => Promise<string>>(),
}));
vi.mock('@/lib/tmux/polling-tmux-transport', () => ({
  getPollingTmuxTransport: () => transport,
}));

import type { PromptData } from '@/types/models';
import type { ScreenReading } from '@/lib/detection/waiting-screen-reading';
import { promptScreenKey } from '@/lib/detection/prompt-screen-key';
import {
  captureSessionOutput,
  captureSessionOutputFresh,
  getCaptureFrameMeta,
} from '@/lib/session/cli-session';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  captureFrameTime,
  observeWaiting,
  startWaitingObservation,
  type WaitingObservationPlan,
} from '@/lib/session/waiting-episode-binding';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getWaitingEpisodeRecord,
  openEpisode,
} from '@/lib/session/waiting-episode-state';
import { invalidateCache, resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';

const WT = 'wt-3798-frame-source';
const TOOL = 'claude' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const SESSION = `mcbd-${TOOL}-${WT}`;
const T0 = 1_800_000_000_000;

function yesNo(question: string): PromptData {
  return { type: 'yes_no', question, status: 'pending', options: ['yes', 'no'] };
}
const PROMPT_A = yesNo('Run ls?');
const PROMPT_B = yesNo('Run rm?');
const FRAME_A = 'Run ls? (y/n)';
const FRAME_B = 'Run rm? (y/n)';

const prompt = (promptData: PromptData): ScreenReading => ({
  kind: 'waiting',
  waitingKind: 'prompt',
  humanHeld: false,
  promptData,
  structuredSince: null,
});

/** A pending tmux capture the test finishes by hand. */
function slowCapture(): (output: string) => void {
  let finish: (output: string) => void = () => {};
  transport.captureSnapshot.mockReturnValueOnce(new Promise<string>((resolve) => (finish = resolve)));
  return (output) => finish(output);
}

/** Confirmation A's wait, open, then closed at `closedAt` (its turn's stop). */
function waitForAClosedAt(closedAt: number): void {
  const e = openEpisode(
    PARTS,
    {
      since: closedAt,
      kind: 'prompt',
      binding: { kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null },
      openedBy: 'response-checker',
      promptScreenKey: promptScreenKey(PROMPT_A),
    },
    closedAt,
  );
  expect(closeEpisode(PARTS, e.episodeId, 'turn-stop', closedAt)).toBe(true);
}

/** A status probe: start, capture through the cache, read `promptData`, observe. */
async function probe(promptData: PromptData): Promise<WaitingObservationPlan> {
  const start = startWaitingObservation(WT, TOOL, TOOL);
  const requestedAt = Date.now();
  const output = await captureSessionOutput(WT, TOOL, 100, TOOL);
  const frameTime = captureFrameTime(() => getCaptureFrameMeta(WT, TOOL, TOOL, output), requestedAt);
  return observeWaiting({ ...PARTS, observer: 'status-probe', start, reading: prompt(promptData), ...frameTime });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  resetCacheForTesting();
  transport.captureSnapshot.mockReset();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  recordAgentEvent(WT, TOOL, TOOL, { event: 'session_start', at: T0 - 10_000, detail: null, sessionId: 's-1' });
});

afterEach(() => {
  resetCacheForTesting();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  vi.useRealTimers();
});

describe('[#3798] a slow fresh capture is dated by its start', () => {
  /** A fresh capture started at T0, the close at T0+100, the write-back at T0+200. */
  async function slowFreshAcrossTheClose(frame: string): Promise<void> {
    const finish = slowCapture();
    const pending = captureSessionOutputFresh(WT, TOOL, 100, TOOL);
    vi.setSystemTime(T0 + 100);
    waitForAClosedAt(T0 + 100);
    vi.setSystemTime(T0 + 200);
    finish(frame);
    await expect(pending).resolves.toBe(frame);
    vi.setSystemTime(T0 + 300);
  }

  it('another observer\'s cache hit on it does not reopen the confirmation the close ended', async () => {
    await slowFreshAcrossTheClose(FRAME_A);

    const plan = await probe(PROMPT_A);
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(getCaptureFrameMeta(WT, TOOL, TOOL, FRAME_A)).toEqual({ fetchStartedAt: T0, source: 'cache' });
    expect(plan).toMatchObject({ action: 'ignored', ignoredBecause: 'stale-frame' });
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toBeNull();
  });

  it('control: the same write-back showing another confirmation opens it', async () => {
    await slowFreshAcrossTheClose(FRAME_B);

    const plan = await probe(PROMPT_B);
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(plan.action).toBe('opened');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.promptScreenKey).toBe(promptScreenKey(PROMPT_B));
  });
});

describe('[#3798] the close\'s own millisecond: where the frame came from decides', () => {
  it('a cache hit on a frame fetched before the close is stale, though fetched in the same ms', async () => {
    // Someone's capture at T0 fills the cache; then the stop closes A at T0.
    transport.captureSnapshot.mockResolvedValueOnce(FRAME_A);
    await captureSessionOutput(WT, TOOL, 100, TOOL);
    waitForAClosedAt(T0);

    const plan = await probe(PROMPT_A);
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(getCaptureFrameMeta(WT, TOOL, TOOL, FRAME_A)).toEqual({ fetchStartedAt: T0, source: 'cache' });
    expect(plan).toMatchObject({ action: 'ignored', ignoredBecause: 'stale-frame' });
  });

  it('a fetch joined in flight, started before the close, is stale too', async () => {
    const finish = slowCapture();
    const first = captureSessionOutput(WT, TOOL, 100, TOOL);
    waitForAClosedAt(T0);

    const joined = probe(PROMPT_A);
    finish(FRAME_A);
    await first;
    const plan = await joined;
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(getCaptureFrameMeta(WT, TOOL, TOOL, FRAME_A)).toEqual({ fetchStartedAt: T0, source: 'joined' });
    expect(plan).toMatchObject({ action: 'ignored', ignoredBecause: 'stale-frame' });
  });

  it('control: the observer\'s own fetch after the close, in the same ms, opens the confirmation still showing', async () => {
    transport.captureSnapshot.mockResolvedValueOnce(FRAME_A);
    await captureSessionOutput(WT, TOOL, 100, TOOL);
    waitForAClosedAt(T0);
    // The cache is dropped (a key was sent); the probe fetches the pane itself.
    invalidateCache(SESSION);
    transport.captureSnapshot.mockResolvedValueOnce(FRAME_A);

    const plan = await probe(PROMPT_A);
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(2);
    expect(getCaptureFrameMeta(WT, TOOL, TOOL, FRAME_A)).toEqual({ fetchStartedAt: T0, source: 'fetched' });
    expect(plan.action).toBe('opened');
  });
});
