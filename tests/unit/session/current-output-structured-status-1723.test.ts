/**
 * `buildCurrentOutput` with the structured layer wired in (Issue #1723).
 *
 * The suite is built around one hazard: a merge that is never reached looks
 * exactly like a merge that works. Every positive case therefore starts from a
 * captured frame the scraper reads *differently* and asserts the published
 * status flipped — that is the mutation-injection argument in test form. The
 * negative cases assert the same frames are untouched when no event exists,
 * which is the whole of the "unconfigured machines behave identically" claim.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

// vi.mock factories are hoisted above the imports, so the mock logger has to be
// created inside vi.hoisted() to exist by the time the factory runs.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const db = {} as Database.Database;

/**
 * A frame with no generation indicator anywhere in it.
 *
 * The scraper calls this `running`/`default` while the output still looks
 * fresh, and `ready`/`no_recent_output` once the Auto-Yes poller's timestamp
 * has gone stale — the two halves of `isUnclassifiedActive`.
 */
const UNREADABLE_FRAME = 'writing files\nediting src/app/page.tsx\n';

/** Epoch ms far enough in the past to be stale, near enough to be in-window. */
const RECENTLY = () => Date.now() - 1_000;

function record(event: AgentEventType, detail: string | null = null, at: number = RECENTLY()): void {
  recordAgentEvent('wt-1', 'claude', 'claude', { event, at, detail, sessionId: 'sess-1' });
}

/** The `detection-divergence` lines emitted so far. */
function divergenceLines(): unknown[] {
  return mockLogger.info.mock.calls.filter(([message]) => message === 'detection-divergence');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(getLastServerResponseTimestamp).mockReturnValue(null);
  vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
});

describe('buildCurrentOutput: no structured events (Issue #1723 non-impact)', () => {
  it('publishes exactly the scraper verdict for the unreadable frame', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('default');
    expect(payload.isUnclassifiedActive).toBe(true);
    expect(divergenceLines()).toHaveLength(0);
  });

  it('publishes exactly the scraper verdict for the degraded form of the same frame', async () => {
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(Date.now() - 60_000);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('no_recent_output');
    expect(payload.isUnclassifiedActive).toBe(true);
  });
});

describe('buildCurrentOutput: a stop event ends the turn (Issue #1723)', () => {
  it('turns the busy-looking frame into ready/hook_stop', async () => {
    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    expect(before.sessionStatus).toBe('running');

    record('stop');
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.sessionStatus).toBe('ready');
    expect(after.sessionStatusReason).toBe('hook_stop');
    expect(after.thinking).toBe(false);
    expect(after.isGenerating).toBe(false);
    // Cleared so `commandmate wait` — whose completion test is
    // `ready && isUnclassifiedActive !== true` — actually receives the benefit.
    expect(after.isUnclassifiedActive).toBe(false);
  });

  it('is refused for a different instance in the same worktree', async () => {
    recordAgentEvent('wt-1', 'claude', 'claude-2', {
      event: 'stop',
      at: RECENTLY(),
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('default');
  });
});

describe('buildCurrentOutput: a submitted prompt keeps the session running (Issue #1723)', () => {
  beforeEach(() => {
    // The frame has gone stale, so the scraper degrades it to ready — the
    // false "Completed" that #805 / #1150 / #1497 are all instances of.
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(Date.now() - 60_000);
  });

  it('overrides the scraper ready with running/hook_prompt_submit', async () => {
    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    expect(before.sessionStatus).toBe('ready');

    record('user_prompt_submit');
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.sessionStatus).toBe('running');
    expect(after.sessionStatusReason).toBe('hook_prompt_submit');
    expect(after.thinking).toBe(true);
    expect(after.isGenerating).toBe(true);
    expect(after.thinkingMessage).toBe('Claude is thinking...');
  });

  it('leaves the unclassified hatch open while it does so', async () => {
    record('user_prompt_submit');

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isUnclassifiedActive).toBe(true);
  });
});

describe('buildCurrentOutput: the scraper keeps prompts (Issue #1723 scope line)', () => {
  beforeEach(() => {
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('does not let a stale running verdict hide a detected prompt', async () => {
    // Claude emits no event at all while a selection / confirmation screen is
    // up, so the newest structured fact is the prompt submit that opened the
    // turn. The scraper is the only layer that can see this screen.
    record('user_prompt_submit');

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
  });

  it('does not let a permission notification touch the payload', async () => {
    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    record('notification', 'permission_prompt');
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    // `lastKnownStatusAt` is blanked alongside `structuredEvents` for the same
    // kind of reason, but it is worth stating rather than folding in silently:
    // it is the wall-clock of the poll, so two calls a millisecond apart differ
    // by design (Issue #1926). What this case is about is the VERDICT, and
    // `lastKnownStatus` itself stays in the comparison.
    const comparable = (p: Awaited<ReturnType<typeof buildCurrentOutput>>) => ({
      ...p,
      structuredEvents: null,
      lastKnownStatusAt: null,
    });
    expect(comparable(after)).toEqual(comparable(before));
  });
});

describe('buildCurrentOutput: divergence logging (Issue #1723 §3)', () => {
  it('says nothing while the two layers agree', async () => {
    // Both call it running: the scraper from the frame, the hook from the
    // submitted prompt.
    record('user_prompt_submit');

    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(divergenceLines()).toHaveLength(0);
  });

  it('emits exactly one line naming both verdicts when they disagree', async () => {
    record('stop');

    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    const lines = divergenceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      'detection-divergence',
      expect.objectContaining({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        scraperStatus: 'running',
        scraperReason: 'default',
        structuredStatus: 'ready',
        structuredReason: 'hook_stop',
        structuredEvent: 'stop',
        applied: true,
      }),
    ]);
  });

  it('reports a disagreement it deliberately did not act on', async () => {
    // The measurement the Epic is collecting includes the cases the merge
    // declines to act on. Issue #1725 took `notification(permission_prompt)`
    // out of that set — it is applied now, through the prompt-waiting state —
    // so the case pinned here is the one that remains and always will: the
    // scraper is looking at a dialog, the agent's newest event says the turn is
    // running, and the scraper's `waiting` wins by rule.
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
    record('user_prompt_submit');

    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    const lines = divergenceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      'detection-divergence',
      expect.objectContaining({
        scraperStatus: 'waiting',
        structuredStatus: 'running',
        applied: false,
      }),
    ]);
  });

  it('says nothing for a session with no structured events at all', async () => {
    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(divergenceLines()).toHaveLength(0);
  });
});

describe('buildCurrentOutput: a session that is not running (Issue #1723)', () => {
  it('reports session_not_running however recently the agent spoke', async () => {
    isRunning.mockResolvedValue(false);
    record('user_prompt_submit');

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.sessionStatus).toBe('idle');
    expect(payload.sessionStatusReason).toBe('session_not_running');
    expect(divergenceLines()).toHaveLength(0);
  });
});
