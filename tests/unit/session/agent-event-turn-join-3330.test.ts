/**
 * A queued notice delivered into a running turn joins it (Issue #3330).
 *
 * Claude Code fires `UserPromptSubmit` once for each background-task notice it
 * takes off its queue and attaches to the turn that is already running. Every
 * applied `user_prompt_submit` used to open a new turn, so the turn was
 * re-stamped (`turnId`, `openedAt`) partway through. The server logs of
 * 2026-10-02 to 2026-10-05 had 178 such deliveries, every one of them matched
 * by a `queue-operation: remove` of a `<task-notification>` in the session's
 * transcript.
 *
 * The record carries `joinsOpenTurn` when the source says so; the state only
 * decides what to do with it. A prompt that does not carry it — a prompt typed
 * after an interrupt, or one that arrives after a `Stop` this server never
 * received — still opens a new turn, which is the control below.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentStopEvents,
  getAgentTurn,
  getStructuredSessionState,
  joinOpenTurnFromDuplicate,
  recordAgentEvent,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';

const WT = 'wt-3330';
const T = 1_800_000_000_000;
const SESSION = 'sess-3330';

function deliver(
  event: AgentEventType,
  afterMs: number,
  extra: Partial<AgentEventRecord> = {}
): void {
  recordAgentEvent(WT, 'claude', undefined, {
    event,
    at: T + afterMs,
    detail: null,
    sessionId: SESSION,
    ...extra,
  });
}

const turnAt = (afterMs: number) => getAgentTurn(WT, 'claude', undefined, T + afterMs);

beforeEach(() => clearAgentStopEvents());
afterEach(() => clearAgentStopEvents());

describe('a queued notice delivered into a running turn (Issue #3330)', () => {
  it('keeps the turn: same turnId, same openedAt, still running', () => {
    deliver('user_prompt_submit', 0);
    const opened = turnAt(0);
    expect(opened?.openedAt).toBe(T);

    // Well outside the three-second window: what keeps the turn is the record,
    // not the de-duplication in front of it.
    deliver('user_prompt_submit', 63_000, { joinsOpenTurn: true });

    const turn = turnAt(63_000);
    expect(turn?.turnId).toBe(opened?.turnId);
    expect(turn?.openedAt).toBe(T);
    expect(turn?.closedAt).toBeNull();
    expect(getStructuredSessionState(WT, 'claude', undefined, T + 63_000)?.status).toBe('running');
  });

  it('is closed by that turn’s stop, under the id it opened with', () => {
    deliver('user_prompt_submit', 0);
    const opened = turnAt(0);
    deliver('pre_tool_use', 1_000, { detail: 'Bash' });
    deliver('user_prompt_submit', 63_000, { joinsOpenTurn: true });
    deliver('user_prompt_submit', 63_004, { joinsOpenTurn: true });
    deliver('stop', 90_000);

    const turn = turnAt(90_000);
    expect(turn?.turnId).toBe(opened?.turnId);
    expect(turn?.openedAt).toBe(T);
    expect(turn?.closedAt).toBe(T + 90_000);
    expect(turn?.closedBy).toBe('stop');
    expect(getStructuredSessionState(WT, 'claude', undefined, T + 90_000)?.status).toBe('ready');
  });

  it('opens a new turn when the previous one has already ended (#3289 / #3301)', () => {
    // A notice that arrives while the agent is idle is what opens the turn the
    // agent resumes itself into. The flag says "join it if one is running",
    // not "never a turn of its own".
    deliver('user_prompt_submit', 0);
    const first = turnAt(0);
    deliver('stop', 2_624);
    deliver('user_prompt_submit', 2_646, { joinsOpenTurn: true });

    const second = turnAt(2_646);
    expect(second?.turnId).not.toBe(first?.turnId);
    expect(second?.openedAt).toBe(T + 2_646);
    expect(second?.closedAt).toBeNull();
  });

  it('opens a turn when there is none at all', () => {
    deliver('user_prompt_submit', 0, { joinsOpenTurn: true });

    const turn = turnAt(0);
    expect(turn?.openedAt).toBe(T);
    expect(turn?.closedAt).toBeNull();
  });

  it('does not join a turn of another session', () => {
    deliver('user_prompt_submit', 0);
    const first = turnAt(0);
    deliver('user_prompt_submit', 5_000, { joinsOpenTurn: true, sessionId: 'sess-other' });

    const turn = turnAt(5_000);
    expect(turn?.turnId).not.toBe(first?.turnId);
    expect(turn?.openedAt).toBe(T + 5_000);
  });
});

describe('a prompt that is not a queued notice still opens a new turn (control)', () => {
  it('re-opens a running turn, as before: an interrupt, or a Stop that never arrived', () => {
    // Neither leaves anything on the hook channel that tells it apart from a
    // prompt joining the turn, so the turn the operator sent is a new one.
    deliver('user_prompt_submit', 0);
    const first = turnAt(0);
    deliver('user_prompt_submit', 63_000);

    const turn = turnAt(63_000);
    expect(turn?.turnId).not.toBe(first?.turnId);
    expect(turn?.openedAt).toBe(T + 63_000);
  });

  it('treats an explicit false the same as absent', () => {
    deliver('user_prompt_submit', 0);
    const first = turnAt(0);
    deliver('user_prompt_submit', 63_000, { joinsOpenTurn: false });

    expect(turnAt(63_000)?.turnId).not.toBe(first?.turnId);
  });
});

describe('joinOpenTurnFromDuplicate: a marked copy dropped behind an unmarked one', () => {
  const marked = { event: 'user_prompt_submit' as const, sessionId: SESSION, joinsOpenTurn: true };

  it('puts back the running turn the unmarked copy replaced', () => {
    deliver('user_prompt_submit', 0);
    const opened = turnAt(0);
    deliver('pre_tool_use', 1_000, { detail: 'Bash' });
    deliver('user_prompt_submit', 63_000);
    expect(turnAt(63_000)?.turnId).not.toBe(opened?.turnId);

    expect(joinOpenTurnFromDuplicate(WT, 'claude', undefined, marked)).toBe(true);

    const turn = turnAt(63_006);
    expect(turn?.turnId).toBe(opened?.turnId);
    expect(turn?.openedAt).toBe(T);
    expect(turn?.closedAt).toBeNull();
    expect(turn?.displayEvent.event).toBe('user_prompt_submit');
    // Once: the record is spent.
    expect(joinOpenTurnFromDuplicate(WT, 'claude', undefined, marked)).toBe(false);
  });

  it('does nothing without the mark', () => {
    deliver('user_prompt_submit', 0);
    deliver('user_prompt_submit', 63_000);
    const reopened = turnAt(63_000);

    expect(
      joinOpenTurnFromDuplicate(WT, 'claude', undefined, { ...marked, joinsOpenTurn: false })
    ).toBe(false);
    expect(turnAt(63_006)?.turnId).toBe(reopened?.turnId);
  });

  it('does nothing when the unmarked prompt opened a turn after a stop', () => {
    deliver('user_prompt_submit', 0);
    deliver('stop', 2_000);
    deliver('user_prompt_submit', 2_540);
    const second = turnAt(2_540);

    expect(joinOpenTurnFromDuplicate(WT, 'claude', undefined, marked)).toBe(false);
    expect(turnAt(2_546)?.turnId).toBe(second?.turnId);
  });

  it('does nothing once the re-opened turn has moved on, or for another session', () => {
    deliver('user_prompt_submit', 0);
    deliver('user_prompt_submit', 63_000);
    const reopened = turnAt(63_000);

    expect(
      joinOpenTurnFromDuplicate(WT, 'claude', undefined, { ...marked, sessionId: 'sess-other' })
    ).toBe(false);
    expect(turnAt(63_006)?.turnId).toBe(reopened?.turnId);

    deliver('stop', 64_000);
    expect(joinOpenTurnFromDuplicate(WT, 'claude', undefined, marked)).toBe(false);
    expect(turnAt(64_000)?.closedBy).toBe('stop');
  });
});
