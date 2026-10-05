/**
 * `agent-event-model`, read directly rather than through `agent-event-state`
 * (Issue #3375).
 *
 * The model latches, their precedence and the model-change edge were split out
 * of `agent-event-state` without changing what they do. This suite pins the
 * moved behaviour at its new address, and pins that `agent-event-state`
 * re-exports the same functions over the same `globalThis` maps.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as model from '@/lib/session/agent-event-model';
import * as state from '@/lib/session/agent-event-state';
import {
  getAgentModelBaseline,
  getLastCapturedModelInfo,
  getLastKnownAgentEffort,
  getLastKnownAgentModel,
  getLastReportedAgentEffort,
  getResolvedAgentModelInfo,
  isSameAgentModelName,
  lastAgentModel,
  latchAgentModel,
  onAgentModelChange,
  recordAgentReportedEffort,
  recordAgentReportedModel,
  recordCapturedModelInfo,
  type AgentModelChange,
} from '@/lib/session/agent-event-model';
import { buildCompositeKey } from '@/lib/auto-yes-state';

const WT = 'wt-3375-model';
const T0 = 1_800_000_000_000;

let unsubscribe: (() => void) | null = null;

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  state.clearAgentStopEvents();
});

describe('agent-event-model is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same functions, not copies', () => {
    expect(state.getLastKnownAgentModel).toBe(model.getLastKnownAgentModel);
    expect(state.recordAgentReportedModel).toBe(model.recordAgentReportedModel);
    expect(state.recordCapturedModelInfo).toBe(model.recordCapturedModelInfo);
    expect(state.getResolvedAgentModelInfo).toBe(model.getResolvedAgentModelInfo);
    expect(state.onAgentModelChange).toBe(model.onAgentModelChange);
    expect(state.isSameAgentModelName).toBe(model.isSameAgentModelName);
    expect(state.AGENT_MODEL_EFFORT_SUFFIX_PATTERN).toBe(model.AGENT_MODEL_EFFORT_SUFFIX_PATTERN);
  });

  it('keeps its latch on globalThis, where the generation reset reaches it', () => {
    expect(lastAgentModel).toBe(globalThis.__agentEventLastModel);
    recordAgentReportedModel(WT, 'opencode', undefined, 'gpt-5', T0);
    expect(state.getLastKnownAgentModel(WT, 'opencode')).toBe('gpt-5');

    state.beginAgentEventGeneration(WT, 'opencode', undefined, T0 + 1);

    expect(getLastKnownAgentModel(WT, 'opencode')).toBeNull();
    expect(getAgentModelBaseline(WT, 'opencode')).toBeNull();
  });
});

describe('the latches', () => {
  it('latchAgentModel keeps the last non-empty model and ignores events without one', () => {
    const key = buildCompositeKey(WT, 'codex');
    latchAgentModel(key, { event: 'stop', at: T0, detail: null, sessionId: null, model: 'gpt-5' });
    latchAgentModel(key, { event: 'stop', at: T0 + 1, detail: null, sessionId: null, model: null });
    latchAgentModel(key, { event: 'stop', at: T0 + 2, detail: null, sessionId: null, model: '' });
    expect(getLastKnownAgentModel(WT, 'codex')).toBe('gpt-5');
  });

  it('latches each half of a captured frame independently', () => {
    recordCapturedModelInfo(WT, 'codex', undefined, { model: 'gpt-5', effort: 'high' }, T0);
    recordCapturedModelInfo(WT, 'codex', undefined, { model: null, effort: null }, T0 + 1);
    recordCapturedModelInfo(WT, 'codex', undefined, { model: 'gpt-5', effort: null }, T0 + 2);
    expect(getLastCapturedModelInfo(WT, 'codex')).toEqual({ model: 'gpt-5', effort: 'high' });
  });

  it('latches the reported effort and leaves it alone for an empty one', () => {
    recordAgentReportedEffort(WT, 'opencode', undefined, 'high');
    recordAgentReportedEffort(WT, 'opencode', undefined, '');
    recordAgentReportedEffort(WT, 'opencode', undefined, null);
    expect(getLastReportedAgentEffort(WT, 'opencode')).toBe('high');
  });

  it('prefers the hook model over the frame for a tool the frame never overtakes', () => {
    recordAgentReportedModel(WT, 'codex', undefined, 'gpt-5-codex', T0);
    recordCapturedModelInfo(WT, 'codex', undefined, { model: 'gpt-5', effort: 'high' }, T0 + 1);
    const resolved = getResolvedAgentModelInfo(WT, 'codex');
    expect(resolved.model).toBe('gpt-5-codex');
    expect(getLastKnownAgentEffort(WT, 'codex')).toBe(resolved.effort);
  });
});

describe('the model edge', () => {
  it('records the first sighting silently and announces a real change once', () => {
    const changes: AgentModelChange[] = [];
    unsubscribe = onAgentModelChange((change) => changes.push(change));

    recordAgentReportedModel(WT, 'codex', undefined, 'gpt-5', T0);
    expect(changes).toEqual([]);
    expect(getAgentModelBaseline(WT, 'codex')).toEqual({ model: 'gpt-5', source: 'hook' });

    recordAgentReportedModel(WT, 'codex', undefined, 'gpt-5', T0 + 1);
    expect(changes).toEqual([]);

    recordAgentReportedModel(WT, 'codex', undefined, 'gpt-5-mini', T0 + 2);
    expect(changes).toEqual([
      {
        worktreeId: WT,
        cliToolId: 'codex',
        instanceId: 'codex',
        from: 'gpt-5',
        to: 'gpt-5-mini',
        source: 'hook',
        at: T0 + 2,
      },
    ]);
  });

  it('compares names exactly within a channel and by containment across channels', () => {
    expect(isSameAgentModelName('GPT-5 mini', 'gpt-5-mini')).toBe(true);
    expect(isSameAgentModelName('gpt-5', 'gpt-5-mini')).toBe(false);
    expect(isSameAgentModelName('gemini-3.7-flash-high', 'gemini-3.7-flash-low')).toBe(true);
    expect(
      isSameAgentModelName('Gemini 3.7 Flash', 'gemini-3.7-flash-high', { crossSource: true })
    ).toBe(true);
    expect(isSameAgentModelName('Opus 5 (1M context)', 'claude-opus-5[1m]')).toBe(false);
    expect(
      isSameAgentModelName('Opus 5 (1M context)', 'claude-opus-5[1m]', { crossSource: true })
    ).toBe(true);
  });
});
