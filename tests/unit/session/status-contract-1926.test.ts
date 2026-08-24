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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { freezeClock, FROZEN_NOW_MS, unfreezeClock } from '../../helpers/frozen-clock';

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
  forgetLastKnownStatus,
  isUnclassifiedFrame,
  getLastKnownStatus,
  LAST_KNOWN_STATUS_TTL_MS,
  MAX_LATCHES,
  observeStatusEvidence,
} from '@/lib/session/status-evidence';
import {
  derivePublishedTurn,
  NO_TURN,
  TURN_ACTIVITY_EVENTS,
} from '@/lib/session/provisional-turn';
import { getAgentTurn } from '@/lib/session/agent-event-state';
import { TURN_OPENING_EVENT_TYPES } from '@/cli/commands/wait';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  clearLastKnownStatuses();
  isRunning.mockResolvedValue(true);
});

// Only the cases that freeze it do; this is the unconditional restore.
afterEach(() => unfreezeClock());

/**
 * A frame the detector reads as a finished, idle Claude turn.
 *
 * Issue #1927 replaced the two-line `'some agent output\n> '` this used to be.
 * That frame was `ready`/`input_prompt` with `evidence: 'positive'` only
 * because a bare composer row counted as completion evidence — which is exactly
 * the "absence of a negative" §4 D1 removed. Claude's measured evidence is the
 * turn-completion marker, so the frame this suite calls idle has to carry one
 * or it stops being a positive row at all.
 */
const IDLE_COMPOSER_FRAME = buildClaudeIdleComposerFrame();

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
  });

  it('stamps the wall clock of the poll that confirmed it', async () => {
    // A range rather than an equality, so this is deterministic under any load,
    // and a range rather than `expect.any(Number)`, because "when the status was
    // last known" is the whole meaning of the field: a stamp taken from the
    // event's own time, from a counter, or from a constant would all satisfy a
    // type check and none of them would be this.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const before = Date.now();
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    const after = Date.now();

    expect(payload.lastKnownStatusAt).toBeGreaterThanOrEqual(before);
    expect(payload.lastKnownStatusAt).toBeLessThanOrEqual(after);
  });

  it('re-stamps on every poll that confirms, and holds while none does', async () => {
    // The monotonicity contract, pinned exactly rather than with `>=` — a `>=`
    // between two polls is satisfied by a field that never moves at all. The
    // clock is driven by hand so both halves are asserted as equalities:
    // re-confirmation advances the stamp, and a frame with no evidence leaves it
    // exactly where the last confirmation put it.
    freezeClock(FROZEN_NOW_MS);
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const first = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    expect(first.lastKnownStatusAt).toBe(FROZEN_NOW_MS);

    vi.setSystemTime(FROZEN_NOW_MS + 5_000);
    const second = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    expect(second.lastKnownStatusAt).toBe(FROZEN_NOW_MS + 5_000);

    vi.setSystemTime(FROZEN_NOW_MS + 9_000);
    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
    const blind = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(blind.statusEvidence).toBe('none');
    expect(blind.lastKnownStatusAt).toBe(FROZEN_NOW_MS + 5_000);
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

describe('[#2011] isUnclassifiedFrame — the flag, restated as its own expression', () => {
  /**
   * The three reasons that mean "no rule could read this frame", and one row of
   * each kind that is NOT.
   *
   * The table this replaces derived {@link StatusEvidence} from `(status,
   * reason)`. Issue #1927 moved that producer into the detector and left the
   * function behind with no production caller, and #1928 recorded the drift it
   * had already accumulated (`running`/`no_recent_output` answered `'positive'`
   * there while the detector emitted `'none'`). #2011 removed it and put THIS
   * question in its place, because this is the one a downstream expression can
   * still answer correctly: `isUnclassifiedActive` is a statement about the
   * reason vocabulary, which is shared across tools, and not about the strength
   * of the evidence, which the §4 D1 rollout makes tool-specific.
   *
   * The row that matters most is the last pair: `ready`/`input_prompt` is FALSE
   * whatever the evidence turned out to be. Deriving the flag from `evidence`
   * instead is what closed `wait` on every idle Claude pane (#2011).
   */
  const ROWS: Array<[Parameters<typeof isUnclassifiedFrame>[0], string, boolean]> = [
    ['running', STATUS_REASON.DEFAULT, true],
    ['running', STATUS_REASON.UNKNOWN_FRAME, true],
    ['running', STATUS_REASON.NO_RECENT_OUTPUT, true],
    ['ready', STATUS_REASON.INPUT_PROMPT, false],
    ['running', STATUS_REASON.THINKING_INDICATOR, false],
    ['waiting', STATUS_REASON.PROMPT_DETECTED, false],
    ['idle', 'session_not_running', false],
    // The status matters as much as the reason: `default` on anything but
    // `running` is not the floor, and a derivation that keyed on the reason
    // alone would be wrong here. Since #1927 no producer emits either shape, so
    // these two are a guard against a future one rather than live rows.
    ['ready', STATUS_REASON.DEFAULT, false],
    ['ready', STATUS_REASON.NO_RECENT_OUTPUT, false],
  ];

  it.each(ROWS)('%s / %s -> %s', (status, reason, expected) => {
    expect(isUnclassifiedFrame(status, reason)).toBe(expected);
  });

  it('covers every reason the detection chain can floor on', () => {
    // The set is defined in `status-evidence.ts` and the chain that produces it
    // is in `tools/run-detection.ts`. A new floor added there without a row here
    // would publish a frame nobody can read with the hatch shut, which is the
    // #1708 stall this flag exists to prevent — so the two are pinned equal.
    const floorReasons = [
      STATUS_REASON.NO_RECENT_OUTPUT,
      STATUS_REASON.UNKNOWN_FRAME,
      STATUS_REASON.DEFAULT,
    ];
    for (const reason of floorReasons) {
      expect(isUnclassifiedFrame('running', reason), reason).toBe(true);
    }
  });
});

describe('[#1926] structuredEvents turn fields, on the #1930 turn record', () => {
  const at = 1_700_000_000_500;

  /** Record one event for wt-1/claude/claude. */
  const record = (event: Parameters<typeof recordAgentEvent>[3]['event'], eventAt: number, detail: string | null = null) =>
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event,
      at: eventAt,
      detail,
      sessionId: 'sess-1926',
    });

  const turn = (now = at + 1) => getAgentTurn('wt-1', 'claude', 'claude', now);

  it('opens a turn on each of the three turn-activity events', () => {
    for (const event of TURN_ACTIVITY_EVENTS) {
      clearAgentStopEvents();
      record(event, at);

      const published = derivePublishedTurn(turn());
      expect(published.openedAt).toBe(at);
      expect(published.closedAt).toBeNull();
      expect(published.closedBy).toBeNull();
      expect(published.turnId).not.toBeNull();
    }
  });

  it('closes on stop, and says so rather than guessing when it opened', () => {
    // The #1926 reasoning, unchanged and now structural rather than derived:
    // a `stop` with no turn open publishes `openedAt: null`, because
    // `closedAt - openedAt` is an elapsed time a header chip would render and a
    // guess there is worse than a null.
    record('stop', at);

    expect(derivePublishedTurn(turn())).toMatchObject({
      openedAt: null,
      closedAt: at,
      closedBy: 'stop',
    });
  });

  it.each(['session_start', 'session_end'] as const)('derives no turn from %s alone', (event) => {
    record(event, at);

    expect(derivePublishedTurn(turn())).toEqual(NO_TURN);
  });

  it('derives no turn from an unrecognised notification', () => {
    record('notification', at, 'some_future_type');

    expect(derivePublishedTurn(turn())).toEqual(NO_TURN);
  });

  it('derives nothing at all when no event has arrived', () => {
    expect(derivePublishedTurn(null)).toEqual(NO_TURN);
    expect(derivePublishedTurn(turn())).toEqual(NO_TURN);
  });

  it('keeps turnId and openedAt fixed across the tool calls inside one turn', () => {
    // The invariant that replaced #1926's "re-stamps turnId inside one turn"
    // pin. That test existed to make the provisional derivation's defect
    // visible and said, in as many words, that Phase 4's TurnRecord is what
    // fixes it and that the pin should be replaced with the real invariant when
    // it lands. This is that invariant: `wait` reads a changed `turnId` as "a
    // new turn began", so a re-stamp mid-turn is a false turn boundary.
    record('user_prompt_submit', at);
    const opened = derivePublishedTurn(turn());

    record('pre_tool_use', at + 1_000, 'Bash');
    record('post_tool_use', at + 2_000, 'Bash');
    const midTurn = derivePublishedTurn(turn(at + 2_001));

    expect(midTurn.turnId).toBe(opened.turnId);
    expect(midTurn.openedAt).toBe(at);
    expect(midTurn.closedAt).toBeNull();
  });

  it('starts a new turn on the next user_prompt_submit', () => {
    record('user_prompt_submit', at);
    const first = derivePublishedTurn(turn());

    record('stop', at + 1_000);
    record('user_prompt_submit', at + 2_000);
    const second = derivePublishedTurn(turn(at + 2_001));

    expect(second.turnId).not.toBe(first.turnId);
    expect(second.openedAt).toBe(at + 2_000);
  });

  it('publishes them on the payload', async () => {
    // The turn is a real record now, so the staleness bound applies to it: a
    // fixture timestamp from 2023 read against the wall clock is a turn that
    // closed itself as `stale` thirty minutes later. Freezing is what makes
    // this assertion about the publication rather than about the clock.
    freezeClock(at + 1_000);
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
      openedAt: at,
      closedAt: null,
      closedBy: null,
    });
    expect(payload.structuredEvents.turnId).not.toBeNull();
  });

  it('keeps lastEventType / lastEventAt alongside them', async () => {
    // They answer a different question — "did anything reach this server, and
    // for the right instance?" — and #1930 lets the two disagree on purpose for
    // an event that carries no verdict.
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
