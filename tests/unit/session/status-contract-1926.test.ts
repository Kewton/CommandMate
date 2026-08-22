/**
 * The additive state contract (Issue #1926, 方針書 §7 / §13 / DR3-005).
 *
 * Phase 1 publishes three things and changes no verdict: `statusEvidence` and
 * `lastKnownStatus` / `lastKnownStatusAt` on `current-output`, and the turn
 * fields on `structuredEvents`. This suite is written against the two ways a
 * contract-only landing goes wrong.
 *
 *  1. **The field exists and is always the same value.** A `statusEvidence` that
 *     read `'positive'` on every frame would satisfy a suite that only checks
 *     the key is there, and would be the exact opposite of what §4 D1 asks for.
 *     So every assertion here is paired with the frame that produces the other
 *     value.
 *  2. **The producer is copied rather than shared.** #1926 has to publish the
 *     evidence reading from a second layer (`worktree-status-helper`, which
 *     drives `commandmate ls` and the header chip). Two expressions for one fact
 *     is what §4 D1 決定 2 forbids, and the failure mode is silent: both are
 *     right today, and Phase 3 moves one of them.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

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
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-state';
import {
  clearLastKnownStatuses,
  deriveScraperEvidence,
  forgetLastKnownStatus,
  getLastKnownStatus,
  LAST_KNOWN_STATUS_TTL_MS,
  MAX_LATCHES,
  observeStatusEvidence,
} from '@/lib/session/status-evidence';
import {
  deriveProvisionalTurn,
  TURN_ACTIVITY_EVENTS,
} from '@/lib/session/provisional-turn';
import { TURN_OPENING_EVENT_TYPES } from '@/cli/commands/wait';
import { STATUS_REASON } from '@/lib/detection/status-detector';

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  clearLastKnownStatuses();
  isRunning.mockResolvedValue(true);
});

/** A frame the detector reads as an idle composer — `ready` / `input_prompt`. */
const IDLE_COMPOSER_FRAME = 'some agent output\n> ';

/**
 * A frame with nothing on it at all.
 *
 * No marker, no thinking indicator, no composer, so the detector falls through
 * to `default`: `running` on the strength of nothing. One of the two
 * "absence of a negative" rows of §6.1, and the row that must report
 * `statusEvidence: 'none'`.
 */
const UNREADABLE_FRAME = 'a line of prose that matches nothing in particular';

describe('[#1926] statusEvidence on current-output', () => {
  it('is positive for a frame the detector classified', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.statusEvidence).toBe('positive');
  });

  it("is 'none' for a frame nothing could read", async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatusReason).toBe(STATUS_REASON.DEFAULT);
    expect(payload.statusEvidence).toBe('none');
  });

  it('is exactly the negation of the flag it was extracted from', async () => {
    // The compatibility guarantee. `isUnclassifiedActive` is an older published
    // contract (`wait`'s `ready && !isUnclassifiedActive` rule) and #1926 must
    // not let the two readings come apart on the wire.
    for (const frame of [IDLE_COMPOSER_FRAME, UNREADABLE_FRAME]) {
      vi.mocked(captureSessionOutput).mockResolvedValue(frame);
      const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
      expect(payload.statusEvidence === 'none').toBe(payload.isUnclassifiedActive === true);
    }
  });

  it("answers 'positive' for a session that is not running", async () => {
    // Not a formality: tmux was asked and answered. §4 D1 separates "a pattern
    // failed to match" from "this layer observed the thing", and the absence of
    // a session is the second kind.
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.lastKnownStatus).toBeNull();
    expect(payload.lastKnownStatusAt).toBeNull();
  });
});

describe('[#1926] lastKnownStatus — the latch behind §7', () => {
  it('reports the status the current poll just confirmed', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.lastKnownStatus).toBe(payload.sessionStatus);
    expect(payload.lastKnownStatusAt).toEqual(expect.any(Number));
  });

  it('keeps the previous verdict standing while the frame carries no evidence', async () => {
    // The whole point of the field: the frame went unreadable, the wire status
    // is now a fallback, and this is what it last actually was.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);
    const confirmed = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    expect(confirmed.sessionStatus).toBe('ready');

    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
    const blind = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(blind.statusEvidence).toBe('none');
    expect(blind.sessionStatus).toBe('running');
    expect(blind.lastKnownStatus).toBe('ready');
    expect(blind.lastKnownStatusAt).toBe(confirmed.lastKnownStatusAt);
  });

  it('is dropped when the session stops, not inherited by the next one', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);
    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    isRunning.mockResolvedValue(false);
    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    isRunning.mockResolvedValue(true);
    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
    const fresh = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(fresh.lastKnownStatus).toBeNull();
    expect(fresh.lastKnownStatusAt).toBeNull();
  });

  it('expires at the staleness bound the design fixes it to, not a literal of its own', () => {
    // S2's rule applied to this field: the TTL is `turnStaleAfterMs`, and a
    // second copy of "30 minutes" here is what the pin exists to forbid.
    expect(LAST_KNOWN_STATUS_TTL_MS).toBe(STRUCTURED_STATE_MAX_AGE_MS);

    const t0 = 1_700_000_000_000;
    observeStatusEvidence('k', { status: 'ready', reason: 'input_prompt', evidence: 'positive' }, t0);

    expect(getLastKnownStatus('k', t0 + LAST_KNOWN_STATUS_TTL_MS - 1)?.status).toBe('ready');
    expect(getLastKnownStatus('k', t0 + LAST_KNOWN_STATUS_TTL_MS)).toBeNull();
  });

  it('latches nothing for a verdict with no evidence', () => {
    const t0 = 1_700_000_000_000;
    observeStatusEvidence('k', { status: 'running', reason: 'default', evidence: 'none' }, t0);

    expect(getLastKnownStatus('k', t0)).toBeNull();
  });

  it('evicts the oldest latch rather than growing without bound', () => {
    // The backstop for a server that is polled about thousands of worktrees and
    // restarted before any latch expires. Written as a test because a cap
    // nothing exercises is a cap nobody notices is broken.
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < MAX_LATCHES + 50; i++) {
      observeStatusEvidence(
        `key-${i}`,
        { status: 'ready', reason: 'input_prompt', evidence: 'positive' },
        t0 + i,
      );
    }

    expect(getLastKnownStatus('key-0', t0)).toBeNull();
    expect(getLastKnownStatus(`key-${MAX_LATCHES + 49}`, t0)?.status).toBe('ready');
  });

  it('forgets one session without touching another', () => {
    const t0 = 1_700_000_000_000;
    observeStatusEvidence('a', { status: 'ready', reason: 'input_prompt', evidence: 'positive' }, t0);
    observeStatusEvidence('b', { status: 'waiting', reason: 'prompt_detected', evidence: 'positive' }, t0);

    forgetLastKnownStatus('a');

    expect(getLastKnownStatus('a', t0)).toBeNull();
    expect(getLastKnownStatus('b', t0)?.status).toBe('waiting');
  });
});

describe('[#1926] deriveScraperEvidence is the one producer', () => {
  /**
   * The rows §6.1 calls "the absence of a negative", and one row of each of the
   * kinds that are NOT.
   *
   * Phase 3 moves `input_prompt` into the `'none'` half tool by tool; this table
   * is what makes that move a visible diff instead of a silent widening.
   */
  const ROWS: Array<[Parameters<typeof deriveScraperEvidence>[0], string, 'positive' | 'none']> = [
    ['running', STATUS_REASON.DEFAULT, 'none'],
    ['ready', STATUS_REASON.NO_RECENT_OUTPUT, 'none'],
    ['ready', STATUS_REASON.INPUT_PROMPT, 'positive'],
    ['running', STATUS_REASON.THINKING_INDICATOR, 'positive'],
    ['waiting', STATUS_REASON.PROMPT_DETECTED, 'positive'],
    ['idle', 'session_not_running', 'positive'],
    // The status matters as much as the reason: `default` on anything but
    // `running` is not the fallback row, and a derivation that keyed on the
    // reason alone would be wrong here.
    ['ready', STATUS_REASON.DEFAULT, 'positive'],
    ['running', STATUS_REASON.NO_RECENT_OUTPUT, 'positive'],
  ];

  it.each(ROWS)('%s / %s -> %s', (status, reason, expected) => {
    expect(deriveScraperEvidence(status, reason)).toBe(expected);
  });
});

describe('[#1926] structuredEvents turn fields', () => {
  const at = 1_700_000_000_500;

  it('opens a turn on each of the three turn-activity events', () => {
    for (const event of TURN_ACTIVITY_EVENTS) {
      expect(deriveProvisionalTurn({ event, at })).toEqual({
        turnId: `turn-${at}`,
        openedAt: at,
        closedAt: null,
        closedBy: null,
      });
    }
  });

  it("closes on stop, and says so rather than guessing when it opened", () => {
    expect(deriveProvisionalTurn({ event: 'stop', at })).toEqual({
      turnId: null,
      openedAt: null,
      closedAt: at,
      closedBy: 'stop',
    });
  });

  it.each(['notification', 'session_start', 'session_end'] as const)(
    'derives no turn from %s',
    (event) => {
      expect(deriveProvisionalTurn({ event, at })).toEqual({
        turnId: null,
        openedAt: null,
        closedAt: null,
        closedBy: null,
      });
    },
  );

  it('derives nothing at all when no event has arrived', () => {
    expect(deriveProvisionalTurn(null)).toEqual({
      turnId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
    });
  });

  it('re-stamps turnId inside one turn — it is not yet a turn identity', () => {
    // Pinned, not hidden. Phase 1 retains one event, so a `pre_tool_use` mid-turn
    // moves `openedAt` and the id with it. A consumer treating a changed
    // `turnId` as a new turn will false-positive, and Phase 4's TurnRecord is
    // what fixes it. If this ever starts passing as "stable", the derivation has
    // been replaced and this test should be replaced with the real invariant.
    const opened = deriveProvisionalTurn({ event: 'user_prompt_submit', at });
    const midTurn = deriveProvisionalTurn({ event: 'pre_tool_use', at: at + 1_000 });

    expect(midTurn.turnId).not.toBe(opened.turnId);
  });

  it('publishes them on the payload, derived from the last event', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'user_prompt_submit',
      at,
      detail: null,
      sessionId: 'sess-1926',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents).toMatchObject({
      lastEventType: 'user_prompt_submit',
      lastEventAt: at,
      turnId: `turn-${at}`,
      openedAt: at,
      closedAt: null,
      closedBy: null,
    });
  });

  it('keeps lastEventType / lastEventAt alongside them (#1839 gate stays put)', async () => {
    // §13: `wait`'s adoptTurnStart moves onto the turn fields in Phase 4, and
    // the #1839 gate is not to be unhooked before then. Removing the old pair
    // now would break it silently.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at,
      detail: null,
      sessionId: 'sess-1926',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents.lastEventType).toBe('stop');
    expect(payload.structuredEvents.lastEventAt).toBe(at);
    expect(payload.structuredEvents.closedBy).toBe('stop');
  });

  it('publishes them on a session that is not running too', async () => {
    isRunning.mockResolvedValue(false);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at,
      detail: null,
      sessionId: 'sess-1926',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents.closedAt).toBe(at);
    expect(payload.structuredEvents.closedBy).toBe('stop');
  });
});

describe('[#1926] the turn-opening vocabulary is one set across the two layers', () => {
  /**
   * `wait.ts` cannot import the server module — `tsconfig.cli.json` sets
   * `"paths": {}` — so its copy of the three events is held to
   * `provisional-turn.ts` by this assertion and nothing else. Phase 4 switches
   * `adoptTurnStart` onto `structuredEvents.openedAt`; a set that had drifted by
   * then would change `wait`'s completion gate at the moment of the switch,
   * silently.
   */
  it('matches TURN_OPENING_EVENT_TYPES in src/cli/commands/wait.ts', () => {
    expect([...TURN_ACTIVITY_EVENTS].sort()).toEqual([...TURN_OPENING_EVENT_TYPES].sort());
  });

  it('does not treat stop or a notification as opening a turn', () => {
    // #1839 measured Claude emitting `Notification(idle_prompt)` 62 s into a turn
    // that ran nothing. Only `Stop` ends a turn, and neither opens one.
    expect(TURN_ACTIVITY_EVENTS.has('stop')).toBe(false);
    expect(TURN_ACTIVITY_EVENTS.has('notification')).toBe(false);
  });
});
