/**
 * `agent-event-structured-state`, read directly rather than through
 * `agent-event-state` (Issue #3375).
 *
 * The structured verdict an instance's turn implies was split out of
 * `agent-event-state` without changing what it does. This suite pins the moved
 * derivation at its new address, and pins that `agent-event-state` re-exports
 * the same function.
 *
 * The open-dialog API (`getStructuredPromptWaiting` and its siblings) stayed in
 * `agent-event-state`: `send-guard-structured-1737` pins by file content that
 * those functions are defined there.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as structured from '@/lib/session/agent-event-structured-state';
import * as state from '@/lib/session/agent-event-state';
import {
  getStructuredSessionState,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-structured-state';
import { applyTurnTransition, openDecision } from '@/lib/session/agent-event-turn';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';

const WT = 'wt-3375-structured';
const TOOL = 'claude' as const;
const KEY = buildCompositeKey(WT, TOOL);
const T0 = 1_800_000_000_000;

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => state.clearAgentStopEvents());

function openDialog(source: 'notification' | 'permission-request', at: number): void {
  openDecision(KEY, null, {
    source,
    at,
    message: null,
    toolName: 'Bash',
    decisionId: null,
    patterns: null,
    bootstrapDisplay: { event: 'notification', at, detail: 'permission_prompt' },
  });
}

describe('agent-event-structured-state is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same function and constant, not copies', () => {
    expect(state.getStructuredSessionState).toBe(structured.getStructuredSessionState);
    expect(state.STRUCTURED_STATE_MAX_AGE_MS).toBe(structured.STRUCTURED_STATE_MAX_AGE_MS);
    expect(STRUCTURED_STATE_MAX_AGE_MS).toBe(TURN_STALE_AFTER_MS);
  });

  it('reads the turn recordAgentEvent wrote', () => {
    state.recordAgentEvent(WT, TOOL, undefined, {
      event: 'user_prompt_submit',
      at: T0,
      detail: null,
      sessionId: 's',
    });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 1)).toMatchObject({ status: 'running' });
  });
});

describe('getStructuredSessionState', () => {
  it('answers null when nothing has been reported', () => {
    expect(getStructuredSessionState(WT, TOOL, undefined, T0)).toBeNull();
  });

  it('answers running for an open turn and ready once its stop lands', () => {
    applyTurnTransition(KEY, { event: 'user_prompt_submit', at: T0, detail: null, sessionId: 's' });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 1)).toMatchObject({
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
      event: 'user_prompt_submit',
      at: T0,
      detail: null,
    });

    applyTurnTransition(KEY, { event: 'stop', at: T0 + 2, detail: null, sessionId: 's' });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 3)).toMatchObject({
      status: 'ready',
      reason: HOOK_STATUS_REASON.STOP,
      event: 'stop',
    });
  });

  it('answers null once the displayed event is older than the bound', () => {
    applyTurnTransition(KEY, { event: 'stop', at: T0, detail: null, sessionId: 's' });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
  });

  it('answers null for a turn closed by anything but stop', () => {
    applyTurnTransition(KEY, { event: 'user_prompt_submit', at: T0, detail: null, sessionId: 's' });
    applyTurnTransition(KEY, { event: 'session_end', at: T0 + 1, detail: 'clear', sessionId: 's' });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 2)).toBeNull();
  });

  it('answers waiting while a decision is live, naming the kind of evidence', () => {
    applyTurnTransition(KEY, { event: 'user_prompt_submit', at: T0, detail: null, sessionId: 's' });
    openDialog('permission-request', T0 + 1);
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 2)).toMatchObject({
      status: 'waiting',
      reason: HOOK_STATUS_REASON.PERMISSION_REQUEST,
    });

    openDialog('notification', T0 + 3);
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 4)).toMatchObject({
      status: 'waiting',
      reason: HOOK_STATUS_REASON.PERMISSION_PROMPT,
    });
  });

  it('answers ready for an idle_prompt without closing the turn', () => {
    applyTurnTransition(KEY, { event: 'user_prompt_submit', at: T0, detail: null, sessionId: 's' });
    applyTurnTransition(KEY, { event: 'notification', at: T0 + 1, detail: 'idle_prompt', sessionId: 's' });
    expect(getStructuredSessionState(WT, TOOL, undefined, T0 + 2)).toMatchObject({
      status: 'ready',
      event: 'notification',
      detail: 'idle_prompt',
    });
    expect(state.getAgentTurn(WT, TOOL, undefined, T0 + 2)?.closedAt).toBeNull();
  });
});
