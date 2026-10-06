/**
 * `agent-event-turn`, read directly rather than through `agent-event-state`
 * (Issue #3375).
 *
 * The turn model — generation fence, turn record, transitions and the
 * decisions a turn holds — was split out of `agent-event-state` without
 * changing what it does. This suite drives the moved transitions at their new
 * address, and pins that `agent-event-state` re-exports the same functions over
 * the same `globalThis` maps.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as turnModule from '@/lib/session/agent-event-turn';
import * as state from '@/lib/session/agent-event-state';
import {
  agentTurns,
  applyTurnTransition,
  closeAgentTurn,
  currentGeneration,
  effectiveTurn,
  fenceTurnForNewGeneration,
  generationStartedAt,
  getAgentTurn,
  getPendingDecisions,
  getPublishedAgentTurn,
  joinOpenTurnFromDuplicate,
  observeScraperCompletionEvidence,
  openDecision,
  releaseAllDecisions,
} from '@/lib/session/agent-event-turn';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { SCRAPER_COMPLETION_POLLS, TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';

const WT = 'wt-3375-turn';
const TOOL = 'claude' as const;
const KEY = buildCompositeKey(WT, TOOL);
const T0 = 1_800_000_000_000;

function record(event: AgentEventRecord['event'], at: number, extra: Partial<AgentEventRecord> = {}): AgentEventRecord {
  return { event, at, detail: null, sessionId: 's-1', ...extra };
}

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => state.clearAgentStopEvents());

describe('agent-event-turn is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same functions, not copies', () => {
    expect(state.getAgentTurn).toBe(turnModule.getAgentTurn);
    expect(state.getPublishedAgentTurn).toBe(turnModule.getPublishedAgentTurn);
    expect(state.getPendingDecisions).toBe(turnModule.getPendingDecisions);
    expect(state.closeAgentTurn).toBe(turnModule.closeAgentTurn);
    expect(state.observeScraperCompletionEvidence).toBe(turnModule.observeScraperCompletionEvidence);
    expect(state.joinOpenTurnFromDuplicate).toBe(turnModule.joinOpenTurnFromDuplicate);
  });

  it('keeps its maps on globalThis, shared with recordAgentEvent', () => {
    expect(agentTurns).toBe(globalThis.__agentEventTurns);
    expect(generationStartedAt).toBe(globalThis.__agentEventGenerationStartedAt);

    state.recordAgentEvent(WT, TOOL, undefined, record('user_prompt_submit', T0));

    expect(getAgentTurn(WT, TOOL, undefined, T0 + 1)).toMatchObject({ openedAt: T0, closedAt: null });
  });
});

describe('turn transitions', () => {
  it('opens a turn on user_prompt_submit and closes it on a stop of the same session', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    const opened = getAgentTurn(WT, TOOL, undefined, T0 + 1);
    expect(opened).toMatchObject({ openedAt: T0, closedAt: null, sessionId: 's-1' });

    applyTurnTransition(KEY, record('pre_tool_use', T0 + 1, { detail: 'Bash' }));
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 2)?.turnId).toBe(opened?.turnId);

    applyTurnTransition(KEY, record('stop', T0 + 2, { sessionId: 's-other' }));
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 3)?.closedAt).toBeNull();

    applyTurnTransition(KEY, record('stop', T0 + 3));
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 4)).toMatchObject({ closedAt: T0 + 3, closedBy: 'stop' });
    expect(getPublishedAgentTurn(WT, TOOL, undefined, T0 + 4)).toBeTruthy();
  });

  it('ignores an event stamped before the current generation', () => {
    generationStartedAt.set(KEY, T0 + 100);
    expect(currentGeneration(KEY)).toBe(T0 + 100);
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 200)).toBeNull();
  });

  it('closes an open turn as stale once nothing has been heard for the bound', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    const turn = effectiveTurn(KEY, T0 + TURN_STALE_AFTER_MS);
    expect(turn).toMatchObject({ closedAt: T0 + TURN_STALE_AFTER_MS, closedBy: 'stale' });
  });

  it('closes an open turn and carries it into a new generation', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    fenceTurnForNewGeneration(KEY, T0 + 10);
    expect(agentTurns.get(KEY)).toMatchObject({
      closedAt: T0 + 10,
      closedBy: 'generation',
      generationAt: T0 + 10,
    });
  });

  it('puts a re-opened turn back when the marked copy of its prompt is dropped (#3330)', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    const original = getAgentTurn(WT, TOOL, undefined, T0 + 1)?.turnId;
    applyTurnTransition(KEY, record('user_prompt_submit', T0 + 5));
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 6)?.turnId).not.toBe(original);

    expect(
      joinOpenTurnFromDuplicate(WT, TOOL, undefined, {
        event: 'user_prompt_submit',
        sessionId: 's-1',
        joinsOpenTurn: true,
      })
    ).toBe(true);
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 7)?.turnId).toBe(original);
  });
});

describe('closing on outside evidence', () => {
  it('closes after the scraper reports completion on enough consecutive polls', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    for (let poll = 1; poll < SCRAPER_COMPLETION_POLLS; poll++) {
      expect(observeScraperCompletionEvidence(WT, TOOL, undefined, true, T0 + poll)).toBe(false);
    }
    expect(observeScraperCompletionEvidence(WT, TOOL, undefined, true, T0 + 10)).toBe(true);
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 11)?.closedBy).toBe('scraper_evidence');
  });

  it('keeps counting but does not close while mayClose is false', () => {
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    for (let poll = 1; poll <= SCRAPER_COMPLETION_POLLS; poll++) {
      expect(observeScraperCompletionEvidence(WT, TOOL, undefined, true, T0 + poll, false)).toBe(false);
    }
    expect(getAgentTurn(WT, TOOL, undefined, T0 + 10)?.closedAt).toBeNull();
  });

  it('closeAgentTurn closes an open turn once and is a no-op otherwise', () => {
    expect(closeAgentTurn(WT, TOOL, undefined, 'resync_idle', T0)).toBe(false);
    applyTurnTransition(KEY, record('user_prompt_submit', T0));
    expect(closeAgentTurn(WT, TOOL, undefined, 'resync_idle', T0 + 1)).toBe(true);
    expect(closeAgentTurn(WT, TOOL, undefined, 'resync_idle', T0 + 2)).toBe(false);
  });
});

describe('decisions', () => {
  it('opens a decision on a bootstrap record and releases it', () => {
    openDecision(KEY, null, {
      source: 'notification',
      at: T0,
      message: 'needs permission',
      toolName: 'Bash',
      decisionId: null,
      patterns: null,
      bootstrapDisplay: { event: 'notification', at: T0, detail: 'permission_prompt' },
    });
    expect(getPendingDecisions(WT, TOOL, undefined, T0 + 1)).toEqual([
      expect.objectContaining({ source: 'notification', toolName: 'Bash', confirmedAt: T0 }),
    ]);
    expect(agentTurns.get(KEY)?.openedAt).toBeNull();

    releaseAllDecisions(KEY);
    expect(getPendingDecisions(WT, TOOL, undefined, T0 + 2)).toEqual([]);
  });
});
