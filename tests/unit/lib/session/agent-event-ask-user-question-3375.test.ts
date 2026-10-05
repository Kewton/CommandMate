/**
 * `agent-event-ask-user-question`, read directly rather than through
 * `agent-event-state` (Issue #3375).
 *
 * The in-flight `AskUserQuestion` episode (#1726) was split out of
 * `agent-event-state` without changing what it does. This suite pins its
 * release rules at the new address, and pins that `agent-event-state`
 * re-exports the same functions over the same `globalThis` map.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as ask from '@/lib/session/agent-event-ask-user-question';
import * as state from '@/lib/session/agent-event-state';
import {
  applyAskUserQuestionTransition,
  askUserQuestion,
  clearAskUserQuestion,
  getAskUserQuestion,
  recordAskUserQuestion,
} from '@/lib/session/agent-event-ask-user-question';
import { STRUCTURED_STATE_MAX_AGE_MS } from '@/lib/session/agent-event-structured-state';
import { generationStartedAt } from '@/lib/session/agent-event-turn';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { buildCompositeKey } from '@/lib/auto-yes-state';

const WT = 'wt-3375-ask';
const TOOL = 'claude' as const;
const KEY = buildCompositeKey(WT, TOOL);
const T0 = 1_800_000_000_000;

const SPEC: AskUserQuestionSpec = {
  promptId: 'prompt-3375',
  questions: [
    {
      question: 'Which approach?',
      header: 'Approach',
      multiSelect: false,
      choices: [{ label: 'A', description: null }],
    },
  ],
};

function record(event: AgentEventRecord['event'], detail: string | null = null): AgentEventRecord {
  return { event, at: T0 + 1, detail, sessionId: 's' };
}

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => state.clearAgentStopEvents());

describe('agent-event-ask-user-question is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same functions, not copies', () => {
    expect(state.recordAskUserQuestion).toBe(ask.recordAskUserQuestion);
    expect(state.getAskUserQuestion).toBe(ask.getAskUserQuestion);
    expect(state.clearAskUserQuestion).toBe(ask.clearAskUserQuestion);
  });

  it('keeps its map on globalThis, where the generation reset reaches it', () => {
    expect(askUserQuestion).toBe(globalThis.__agentEventAskUserQuestion);
    recordAskUserQuestion(WT, TOOL, undefined, SPEC, T0);
    state.beginAgentEventGeneration(WT, TOOL, undefined, T0 + 1);
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 2)).toBeNull();
  });
});

describe('the episode', () => {
  it('is read back until it is cleared', () => {
    recordAskUserQuestion(WT, TOOL, undefined, SPEC, T0);
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 1)).toEqual({ at: T0, spec: SPEC });
    clearAskUserQuestion(WT, TOOL);
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 1)).toBeNull();
  });

  it('expires after the structured age bound and is fenced by the generation', () => {
    recordAskUserQuestion(WT, TOOL, undefined, SPEC, T0);
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
    generationStartedAt.set(KEY, T0 + 1);
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 2)).toBeNull();
  });

  it.each([
    ['pre_tool_use', 'Bash'],
    ['post_tool_use', 'AskUserQuestion'],
    ['notification', 'idle_prompt'],
    ['stop', null],
    ['user_prompt_submit', null],
    ['session_start', null],
    ['session_end', null],
  ] as const)('is released by %s(%s)', (event, detail) => {
    recordAskUserQuestion(WT, TOOL, undefined, SPEC, T0);
    applyAskUserQuestionTransition(KEY, record(event, detail));
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 2)).toBeNull();
  });

  it.each([
    ['pre_tool_use', 'AskUserQuestion'],
    ['pre_tool_use', 'question'],
    ['notification', 'permission_prompt'],
    ['notification', 'something_else'],
  ] as const)('is kept by %s(%s)', (event, detail) => {
    recordAskUserQuestion(WT, TOOL, undefined, SPEC, T0);
    applyAskUserQuestionTransition(KEY, record(event, detail));
    expect(getAskUserQuestion(WT, TOOL, undefined, T0 + 2)).toEqual({ at: T0, spec: SPEC });
  });
});
