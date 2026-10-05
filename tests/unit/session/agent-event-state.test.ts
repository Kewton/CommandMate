/**
 * `lastStopEventAt` — the hook's second opinion (Issue #1549).
 *
 * Phase 3-2 exposes the timestamp and changes no decision. The assertion that
 * matters most is therefore a negative one: recording a stop event must leave
 * `sessionStatus`, `isComplete` and every other field of the payload byte-for-
 * byte identical, so the string-analysis fallback is provably still in charge.
 * A test that only checked the new field would pass just as happily if the hook
 * had quietly started overriding the detector.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { freezeClock, unfreezeClock } from '../../helpers/frozen-clock';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: (...args: unknown[]) => isRunning(...args) }) }),
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
  AGENT_EVENT_DEDUP_WINDOW_MS,
  classifyAgentEventDelivery,
  clearAgentStopEvents,
  getLastAgentEvent,
  getLastStopEventAt,
  getRecentEventKeyCount,
  isDuplicateAgentEvent,
  recordAgentEvent,
  recordAgentStopEvent,
  STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-state';
import {
  AGENT_EVENT_TYPES,
  SELF_RESUME_PENDING_DETAIL,
  type AgentEventType,
} from '@/lib/hooks/agent-event-types';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { TURN_ACTIVITY_EVENTS } from '@/lib/session/provisional-turn';

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue('some agent output\n> ');
});

// Only the cases that freeze it do; this is the unconditional restore.
afterEach(() => unfreezeClock());

describe('agent-event-state', () => {
  it('returns null until an event is recorded', () => {
    expect(getLastStopEventAt('wt-1', 'claude')).toBeNull();

    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_000);

    expect(getLastStopEventAt('wt-1', 'claude')).toBe(1_700_000_000_000);
  });

  it('treats an omitted instance id and the tool id as the same instance', () => {
    recordAgentStopEvent('wt-1', 'claude', undefined, 111);

    expect(getLastStopEventAt('wt-1', 'claude', 'claude')).toBe(111);
    expect(getLastStopEventAt('wt-1', 'claude')).toBe(111);
  });

  it('keeps alias instances and other worktrees separate', () => {
    recordAgentStopEvent('wt-1', 'codex', 'codex-2', 222);

    expect(getLastStopEventAt('wt-1', 'codex', 'codex-2')).toBe(222);
    expect(getLastStopEventAt('wt-1', 'codex')).toBeNull();
    expect(getLastStopEventAt('wt-2', 'codex', 'codex-2')).toBeNull();
  });

  it('keeps only the most recent event', () => {
    recordAgentStopEvent('wt-1', 'claude', 'claude', 100);
    recordAgentStopEvent('wt-1', 'claude', 'claude', 200);

    expect(getLastStopEventAt('wt-1', 'claude')).toBe(200);
  });
});

describe('buildCurrentOutput exposure', () => {
  it('is null for a session whose agent has no hook wired up', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload).toHaveProperty('lastStopEventAt');
    expect(payload.lastStopEventAt).toBeNull();
  });

  it('surfaces the timestamp without disturbing anything else in the payload', async () => {
    // Frozen, because this whole-payload equality is the assertion and
    // `lastKnownStatusAt` (Issue #1926) is `Date.now()` at the poll: two builds
    // that straddle a millisecond would fail it, which is what CI hit on
    // PR #1964. Freezing keeps the field IN the comparison — dropping it would
    // make this case stop checking the one field most likely to move.
    freezeClock();

    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_000);
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.lastStopEventAt).toBe(1_700_000_000_000);
    // The detector's verdict is untouched: same frame in, same verdict out.
    expect({ ...after, lastStopEventAt: null }).toEqual({ ...before, lastStopEventAt: null });
    expect(after.sessionStatus).toBe(before.sessionStatus);
    expect(after.isComplete).toBe(before.isComplete);
  });

  it('surfaces the timestamp for a session that is no longer running', async () => {
    // The stopped-session early return is a separate construction of the
    // payload, and the field has to exist there too or a consumer reading it
    // sees `undefined` exactly when the agent has finished.
    isRunning.mockResolvedValue(false);
    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_001);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.lastStopEventAt).toBe(1_700_000_000_001);
  });
});

describe('structured events of any kind (Issue #1722)', () => {
  it('returns null until something is recorded, then the latest record', () => {
    expect(getLastAgentEvent('wt-1', 'claude')).toBeNull();

    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'user_prompt_submit',
      at: 100,
      detail: null,
      sessionId: 'sess-1',
    });
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: 200,
      detail: 'idle_prompt',
      sessionId: 'sess-1',
    });

    expect(getLastAgentEvent('wt-1', 'claude')).toEqual({
      event: 'notification',
      at: 200,
      detail: 'idle_prompt',
      sessionId: 'sess-1',
    });
  });

  it('keeps instances apart', () => {
    recordAgentEvent('wt-1', 'claude', 'claude-2', {
      event: 'stop',
      at: 300,
      detail: null,
      sessionId: null,
    });

    expect(getLastAgentEvent('wt-1', 'claude', 'claude-2')?.event).toBe('stop');
    expect(getLastAgentEvent('wt-1', 'claude')).toBeNull();
  });

  it('does not write lastStopEventAt, which belongs to the stop path', () => {
    // Two writers to one timestamp is how it starts disagreeing with the task
    // transition it is supposed to accompany.
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: 400,
      detail: null,
      sessionId: null,
    });

    expect(getLastStopEventAt('wt-1', 'claude')).toBeNull();
  });
});

describe('duplicate suppression (Issue #1722)', () => {
  const dup = (session: string | null, at: number, event: AgentEventType = 'stop') =>
    isDuplicateAgentEvent('wt-1', 'claude', 'claude', event, session, at);

  it('suppresses the second delivery of one turn inside the window', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000 + AGENT_EVENT_DEDUP_WINDOW_MS - 1)).toBe(true);
  });

  it('lets the same session through again once the window has passed', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000 + AGENT_EVENT_DEDUP_WINDOW_MS)).toBe(false);
  });

  it('never suppresses an event with no session id', () => {
    expect(dup(null, 1000)).toBe(false);
    expect(dup(null, 1000)).toBe(false);
  });

  it('separates events, instances and worktrees', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000, 'user_prompt_submit')).toBe(false);
    expect(isDuplicateAgentEvent('wt-1', 'claude', 'claude-2', 'stop', 'sess-1', 1000)).toBe(false);
    expect(isDuplicateAgentEvent('wt-2', 'claude', 'claude', 'stop', 'sess-1', 1000)).toBe(false);
  });

  it('is cleared with the rest of the state', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    clearAgentStopEvents();
    expect(dup('sess-1', 1000)).toBe(false);
  });

  it('does not grow without bound as sessions come and go', () => {
    // Each turn of each session would otherwise leave a key behind forever.
    for (let i = 0; i < 2000; i++) {
      isDuplicateAgentEvent('wt-1', 'claude', 'claude', 'stop', `sess-${i}`, 1000 + i);
    }
    expect(getRecentEventKeyCount()).toBeLessThanOrEqual(600);
  });
});

describe('a turn start between two stops (Issue #3289)', () => {
  /**
   * The window above rests on "a turn cannot end twice in three seconds", and a
   * turn the agent starts for itself can. Measured on claude 2.1.289
   * (2026-10-05): a `Stop`, the `UserPromptSubmit` of a turn opened by a
   * background task's completion notice 540 ms later, and that turn's `Stop`
   * 1473 ms after the first. The second `Stop` was dropped as a copy of the
   * first, the turn it ended stayed open, and `commandmate wait` never returned.
   */
  const T = 1_000;
  const PROMPT_AFTER_MS = 540;
  const SECOND_STOP_AFTER_MS = 1473;
  const SESSION = 'sess-1';

  interface ClaimTarget {
    worktree?: string;
    instance?: string;
    session?: string | null;
    detail?: string | null;
  }

  /** Whether the delivery is dropped. Claims the key, as the receiver does. */
  const dropped = (event: AgentEventType, at: number, target: ClaimTarget = {}): boolean =>
    isDuplicateAgentEvent(
      target.worktree ?? 'wt-1',
      'claude',
      target.instance ?? 'claude',
      event,
      target.session === undefined ? SESSION : target.session,
      at,
      target.detail ?? null
    );

  it('applies the stop of a short turn that started after the previous stop', () => {
    expect(dropped('stop', T)).toBe(false);
    expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS)).toBe(false);
    expect(dropped('stop', T + SECOND_STOP_AFTER_MS)).toBe(false);
  });

  it('still drops every copy on a host that delivers each event twice (#1722)', () => {
    const verdicts = [
      dropped('stop', T),
      dropped('stop', T + 20),
      dropped('user_prompt_submit', T + PROMPT_AFTER_MS),
      dropped('user_prompt_submit', T + PROMPT_AFTER_MS + 20),
      dropped('stop', T + SECOND_STOP_AFTER_MS),
      dropped('stop', T + SECOND_STOP_AFTER_MS + 20),
    ];

    // Applied: the 1st, 3rd and 5th. Dropped: the 2nd, 4th and 6th.
    expect(verdicts).toEqual([false, true, false, true, false, true]);
  });

  it('goes by the order of arrival, not by the clock', () => {
    // Three deliveries inside one millisecond are still three deliveries in an
    // order, and the order is the only thing that says which turn a stop ends.
    expect(dropped('stop', T)).toBe(false);
    expect(dropped('user_prompt_submit', T)).toBe(false);
    expect(dropped('stop', T)).toBe(false);

    clearAgentStopEvents();

    // Control: the same three timestamps with the turn start FIRST. The second
    // stop has no turn start before it, so it is the copy it looks like.
    expect(dropped('user_prompt_submit', T)).toBe(false);
    expect(dropped('stop', T)).toBe(false);
    expect(dropped('stop', T)).toBe(true);
  });

  describe('a copy of the previous stop that arrives after the next turn started', () => {
    // `stop(A) -> user_prompt_submit(B) -> stop(a late copy of A)`. Nothing in
    // the copy names its turn, so it cannot be told from `stop(B)`. The decision
    // is to read it as `stop(B)`: the copy can only be late when a hook was
    // configured not to be waited for, and a `wait` that returns early once is
    // the smaller harm than one that never returns.
    it('is read as the new turn\'s stop, and the real one that follows is the copy', () => {
      expect(dropped('stop', T)).toBe(false);
      expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS)).toBe(false);
      expect(dropped('stop', T + PROMPT_AFTER_MS + 60)).toBe(false);
      // Still one stop per turn start: the reset is spent by the stop above.
      expect(dropped('stop', T + SECOND_STOP_AFTER_MS)).toBe(true);
    });

    it('is dropped as before when no turn started in between', () => {
      expect(dropped('stop', T)).toBe(false);
      expect(dropped('stop', T + PROMPT_AFTER_MS + 60)).toBe(true);
      expect(dropped('stop', T + SECOND_STOP_AFTER_MS)).toBe(true);
    });
  });

  describe('what counts as a turn start', () => {
    /** A subtype each word really carries, so the keys look like delivered ones. */
    const DETAIL: Record<AgentEventType, string | null> = {
      stop: null,
      notification: 'idle_prompt',
      session_start: 'startup',
      user_prompt_submit: null,
      session_end: 'clear',
      pre_tool_use: 'Bash',
      post_tool_use: 'Bash',
    };

    it('is the three events the turn model opens a turn on', () => {
      // antigravity sends `post_tool_use` and no `user_prompt_submit`; Command
      // Code sends the two tool events and no `user_prompt_submit`. A reset
      // keyed on `user_prompt_submit` alone would leave both where claude was.
      expect([...TURN_ACTIVITY_EVENTS].sort()).toEqual(
        ['post_tool_use', 'pre_tool_use', 'user_prompt_submit']
      );

      for (const event of TURN_ACTIVITY_EVENTS) {
        clearAgentStopEvents();
        expect(dropped('stop', T), event).toBe(false);
        expect(dropped(event, T + PROMPT_AFTER_MS, { detail: DETAIL[event] }), event).toBe(false);
        expect(dropped('stop', T + SECOND_STOP_AFTER_MS), event).toBe(false);
      }
    });

    it('is none of the other events', () => {
      const others = AGENT_EVENT_TYPES.filter(
        (event) => event !== 'stop' && !TURN_ACTIVITY_EVENTS.has(event)
      );
      expect(others).toEqual(['notification', 'session_start', 'session_end']);

      for (const event of others) {
        clearAgentStopEvents();
        expect(dropped('stop', T), event).toBe(false);
        expect(dropped(event, T + PROMPT_AFTER_MS, { detail: DETAIL[event] }), event).toBe(false);
        expect(dropped('stop', T + SECOND_STOP_AFTER_MS), event).toBe(true);
      }
    });

    it('is not a turn start that was itself dropped as a copy', () => {
      // `user_prompt_submit` is on the window too, so the start of a turn that
      // begins inside three seconds of the previous turn's start is dropped by
      // the receiver and never opens a turn. Its stop then has nothing to close
      // and stays the copy it is read as: applied together or not at all.
      expect(dropped('user_prompt_submit', T)).toBe(false);
      expect(dropped('stop', T + 1000)).toBe(false);
      expect(dropped('user_prompt_submit', T + 1500)).toBe(true);
      expect(dropped('stop', T + 2000)).toBe(true);

      clearAgentStopEvents();

      // Control: the same shape with the second start outside its own window.
      expect(dropped('user_prompt_submit', T)).toBe(false);
      expect(dropped('stop', T + 2500)).toBe(false);
      expect(dropped('user_prompt_submit', T + AGENT_EVENT_DEDUP_WINDOW_MS + 100)).toBe(false);
      expect(dropped('stop', T + 4000)).toBe(false);
    });

    it('is not a turn start that names no session', () => {
      expect(dropped('stop', T)).toBe(false);
      expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS, { session: null })).toBe(false);
      expect(dropped('stop', T + SECOND_STOP_AFTER_MS)).toBe(true);
    });
  });

  it('resets only the session, instance and worktree the turn started in', () => {
    const elsewhere: ClaimTarget[] = [
      { session: 'sess-2' },
      { instance: 'claude-2' },
      { worktree: 'wt-2' },
    ];

    for (const target of elsewhere) {
      clearAgentStopEvents();
      expect(dropped('stop', T)).toBe(false);
      expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS, target)).toBe(false);
      expect(dropped('stop', T + SECOND_STOP_AFTER_MS), JSON.stringify(target)).toBe(true);
    }
  });

  it('resets a stop whatever subtype it carries', () => {
    // antigravity's `Stop` with background work outstanding is posted as
    // `stop` / `self_resume_pending` (#2614), and the turn that work wakes can
    // end the same way a moment later.
    const pending = { detail: SELF_RESUME_PENDING_DETAIL };

    expect(dropped('stop', T, pending)).toBe(false);
    expect(dropped('post_tool_use', T + PROMPT_AFTER_MS, { detail: 'run_command' })).toBe(false);
    expect(dropped('stop', T + SECOND_STOP_AFTER_MS, pending)).toBe(false);
    // Control: its own copy, with no turn start in between.
    expect(dropped('stop', T + SECOND_STOP_AFTER_MS + 20, pending)).toBe(true);
  });

  it('leaves every other event on the window it had', () => {
    const before: Array<[AgentEventType, string | null]> = [
      ['notification', 'permission_prompt'],
      ['session_start', 'startup'],
      ['session_end', 'clear'],
      ['pre_tool_use', 'Bash'],
      ['post_tool_use', 'Bash'],
    ];
    for (const [event, detail] of before) {
      expect(dropped(event, T, { detail }), event).toBe(false);
    }

    expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS)).toBe(false);

    for (const [event, detail] of before) {
      expect(dropped(event, T + SECOND_STOP_AFTER_MS, { detail }), event).toBe(true);
    }
    expect(dropped('user_prompt_submit', T + SECOND_STOP_AFTER_MS)).toBe(true);
  });

  it('takes the claim away instead of keeping a second record beside it', () => {
    expect(dropped('stop', T)).toBe(false);
    expect(getRecentEventKeyCount()).toBe(1);

    // The turn start is one key in and the stop's key out.
    expect(dropped('user_prompt_submit', T + PROMPT_AFTER_MS)).toBe(false);
    expect(getRecentEventKeyCount()).toBe(1);
  });

  it('does not grow without bound as turns come and go', () => {
    for (let i = 0; i < 2000; i++) {
      const target = { session: `sess-${i}` };
      dropped('stop', T + i, target);
      dropped('user_prompt_submit', T + i, target);
      dropped('stop', T + i, target);
    }
    expect(getRecentEventKeyCount()).toBeLessThanOrEqual(600);
  });

  it('reaches the push sources through classifyAgentEventDelivery as well', () => {
    const classify = (event: AgentEventType, at: number) =>
      classifyAgentEventDelivery({
        worktreeId: 'wt-1',
        cliToolId: 'codex',
        instanceId: 'codex',
        event,
        detail: null,
        sessionId: SESSION,
        at,
        identity: null,
        identityKind: null,
      });

    expect(classify('stop', T)).toEqual({ duplicate: false });
    expect(classify('user_prompt_submit', T + PROMPT_AFTER_MS)).toEqual({ duplicate: false });
    expect(classify('stop', T + SECOND_STOP_AFTER_MS)).toEqual({ duplicate: false });
    expect(classify('stop', T + SECOND_STOP_AFTER_MS + 20)).toEqual({
      duplicate: true,
      by: 'time-window',
    });
  });
});

describe('structuredEvents exposure (Issue #1722)', () => {
  /**
   * The source block Issue #1924 publishes alongside the event fields.
   *
   * Read from the registry rather than transcribed: `capabilities.test.ts` is
   * what pins the values, and a second transcription here would be a second
   * place for the 6x5 table to be wrong. What these two cases assert is the
   * shape — that `structuredEvents` carries the block, on a session that has
   * reported nothing as much as on one that has.
   */
  const claudeSource = {
    cliToolId: 'claude',
    capabilities: getAgentEventSource('claude').capabilities,
    // Issue #2054 adds these two additively. `hooks` and a null probe is what a
    // push source publishes on every payload — the two fields only a
    // subscription can fill in are absent, not null, which is what keeps a
    // claude block the same shape it was.
    kind: 'hooks',
    probedActivity: null,
  };

  it('is all nulls for a session whose agent has reported nothing', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents).toEqual({
      lastEventType: null,
      lastEventAt: null,
      lastEventDetail: null,
      promptWaitingSince: null,
      promptWaitingSource: null,
      // Issue #1902: claude sends `tool_input` as an object, so nothing here is
      // ever rewritten. The key is present and null rather than absent.
      toolInputNormalization: null,
      // Issue #1898: nothing on this session has been adjudicated on the
      // agent's behalf — claude answers its own hook, so this stays null for it
      // for the life of the session. Present and null, not absent.
      permissionDecision: null,
      // Issue #1926 / #1930: nothing has been reported, so there is no turn.
      turnId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      // Issue #1930: present and empty/zeroed rather than absent, for the same
      // reason `permissionDecision` is present and null — a key that appears
      // only once something has gone wrong is a key nobody knows to look for.
      pendingDecisions: [],
      dedupDropped: {
        dedupDropped: { identity: 0, timeWindow: 0 },
        decisionEvicted: 0,
        idsDiscarded: 0,
        dialogTimedOut: 0,
        decisionOverflow: 0,
      },
      dialogPendingMaxMs: {
        predicted: STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS,
        confirmed: STRUCTURED_STATE_MAX_AGE_MS,
      },
      source: claudeSource,
      // Issue #2040: what the agent says about the conversation it is in. Null
      // for claude for the life of the session — it publishes none — and
      // present-and-null rather than absent, for the reason `permissionDecision`
      // above is.
      session: null,
      // Issue #2042: how full the context is. Derived from two reads of the
      // agent's own API, so it is null wherever `session` is — there is no
      // session to ask about — and null forever for claude.
      sessionContext: null,
      // Issue #2043: the third additive key. Named here because this assertion
      // is a whole-shape one on purpose — a field that appeared without anyone
      // deciding it should is exactly what it catches.
      sessionDiff: null,
    });
  });

  it('surfaces the last event without disturbing anything else in the payload', async () => {
    // Frozen for the same reason as the `lastStopEventAt` case above: the tail
    // of this test compares the whole payload minus `structuredEvents`, and
    // `lastKnownStatusAt` is a wall-clock read.
    freezeClock();

    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    // A `Notification` whose type this server has never observed. #1722's
    // observation-only guarantee is asserted on one of those on purpose: the
    // two types that DO carry a verdict were promoted by #1723
    // (`idle_prompt` -> ready) and #1725 (`permission_prompt` -> a dialog is
    // open), so pinning the guarantee to them would be pinning behaviour two
    // later Issues deliberately changed.
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: 1_700_000_000_002,
      detail: 'some_future_type',
      sessionId: 'sess-9',
    });
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.structuredEvents).toEqual({
      lastEventType: 'notification',
      lastEventAt: 1_700_000_000_002,
      lastEventDetail: 'some_future_type',
      promptWaitingSince: null,
      promptWaitingSource: null,
      // Issue #1902: claude sends `tool_input` as an object, so nothing here is
      // ever rewritten. The key is present and null rather than absent.
      toolInputNormalization: null,
      // Issue #1898: nothing on this session has been adjudicated on the
      // agent's behalf — claude answers its own hook, so this stays null for it
      // for the life of the session. Present and null, not absent.
      permissionDecision: null,
      // Issue #1926 / #1930: nothing has been reported, so there is no turn.
      turnId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      // Issue #1930: present and empty/zeroed rather than absent, for the same
      // reason `permissionDecision` is present and null — a key that appears
      // only once something has gone wrong is a key nobody knows to look for.
      pendingDecisions: [],
      dedupDropped: {
        dedupDropped: { identity: 0, timeWindow: 0 },
        decisionEvicted: 0,
        idsDiscarded: 0,
        dialogTimedOut: 0,
        decisionOverflow: 0,
      },
      dialogPendingMaxMs: {
        predicted: STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS,
        confirmed: STRUCTURED_STATE_MAX_AGE_MS,
      },
      source: claudeSource,
      // Issue #2040: still null — a `notification` says nothing about the
      // conversation's cost, and only opencode's `session.updated` fills this.
      session: null,
      // Issue #2042: and with no session there is nothing to measure.
      sessionContext: null,
      // Issue #2043: nor anything to have changed on disk.
      sessionDiff: null,
    });
    expect({ ...after, structuredEvents: null }).toEqual({ ...before, structuredEvents: null });
  });

  it('surfaces the last event for a session that is no longer running', async () => {
    isRunning.mockResolvedValue(false);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'session_end',
      at: 1_700_000_000_003,
      detail: 'clear',
      sessionId: 'sess-9',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents.lastEventType).toBe('session_end');
    expect(payload.structuredEvents.lastEventDetail).toBe('clear');
  });
});
