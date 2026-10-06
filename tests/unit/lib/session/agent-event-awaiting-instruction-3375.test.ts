/**
 * `agent-event-awaiting-instruction`, read directly rather than through
 * `agent-event-state` (Issue #3375).
 *
 * The "waiting for your input" flag (#1786) was split out of
 * `agent-event-state` without changing what it does. This suite pins its
 * transition at the new address, and pins that `agent-event-state` re-exports
 * the same functions over the same `globalThis` map.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as awaiting from '@/lib/session/agent-event-awaiting-instruction';
import * as state from '@/lib/session/agent-event-state';
import {
  applyAwaitingInstructionTransition,
  awaitingInstruction,
  getAwaitingInstruction,
  isAwaitingInstruction,
} from '@/lib/session/agent-event-awaiting-instruction';
import { generationStartedAt } from '@/lib/session/agent-event-turn';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { buildCompositeKey } from '@/lib/auto-yes-state';

const WT = 'wt-3375-awaiting';
const TOOL = 'claude' as const;
const KEY = buildCompositeKey(WT, TOOL);
const T0 = 1_800_000_000_000;

function record(event: AgentEventRecord['event'], at: number, detail: string | null = null): AgentEventRecord {
  return { event, at, detail, sessionId: 's', message: 'Claude is waiting for your input' };
}

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => state.clearAgentStopEvents());

describe('agent-event-awaiting-instruction is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same functions, not copies', () => {
    expect(state.getAwaitingInstruction).toBe(awaiting.getAwaitingInstruction);
    expect(state.isAwaitingInstruction).toBe(awaiting.isAwaitingInstruction);
  });

  it('keeps its map on globalThis, written by recordAgentEvent', () => {
    expect(awaitingInstruction).toBe(globalThis.__agentEventAwaitingInstruction);
    state.recordAgentEvent(WT, TOOL, undefined, record('notification', T0, 'idle_prompt'));
    expect(isAwaitingInstruction(WT, TOOL)).toBe(true);
  });
});

describe('the transition', () => {
  it('is set by idle_prompt and nothing else', () => {
    applyAwaitingInstructionTransition(KEY, record('stop', T0));
    applyAwaitingInstructionTransition(KEY, record('notification', T0, 'permission_prompt'));
    expect(getAwaitingInstruction(WT, TOOL)).toBeNull();

    applyAwaitingInstructionTransition(KEY, record('notification', T0 + 1, 'idle_prompt'));
    expect(getAwaitingInstruction(WT, TOOL)).toEqual({
      at: T0 + 1,
      message: 'Claude is waiting for your input',
    });
  });

  it.each(['user_prompt_submit', 'session_start', 'session_end'] as const)(
    'is released by %s',
    (event) => {
      applyAwaitingInstructionTransition(KEY, record('notification', T0, 'idle_prompt'));
      applyAwaitingInstructionTransition(KEY, record(event, T0 + 1));
      expect(isAwaitingInstruction(WT, TOOL)).toBe(false);
    }
  );

  it.each(['stop', 'pre_tool_use', 'post_tool_use'] as const)('is left alone by %s', (event) => {
    applyAwaitingInstructionTransition(KEY, record('notification', T0, 'idle_prompt'));
    applyAwaitingInstructionTransition(KEY, record(event, T0 + 1));
    expect(isAwaitingInstruction(WT, TOOL)).toBe(true);
  });

  it('is fenced by the generation', () => {
    applyAwaitingInstructionTransition(KEY, record('notification', T0, 'idle_prompt'));
    generationStartedAt.set(KEY, T0 + 1);
    expect(getAwaitingInstruction(WT, TOOL)).toBeNull();
  });
});
