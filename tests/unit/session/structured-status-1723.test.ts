/**
 * The structured state machine and the two-layer merge (Issue #1723).
 *
 * Three separate things are pinned here, deliberately without a tmux session or
 * a database behind any of them:
 *
 *  1. `agentEventToSessionStatus` — the event -> status table.
 *  2. `getStructuredSessionState` — the bounds on trusting that table:
 *     generation and age.
 *  3. `mergeStructuredStatus` — the precedence between the two detection layers.
 *
 * The negative cases carry most of the weight. A merge that never fires and a
 * merge that always fires both leave `npm run test:unit` green if the only
 * assertions are "hook events produce hook statuses", so every rule that says
 * "the scraper still wins here" is asserted against a structured verdict that
 * would visibly have changed the answer had it been applied.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentEventToSessionStatus,
  HOOK_STATUS_REASON,
} from '@/lib/session/status-mapping';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  discardAgentEventState,
  getAgentEventGenerationStartedAt,
  getStructuredSessionState,
  recordAgentEvent,
  STRUCTURED_STATE_MAX_AGE_MS,
  type StructuredSessionState,
} from '@/lib/session/agent-event-state';
import {
  mergeStructuredStatus,
  type ScraperVerdict,
} from '@/lib/session/current-output-builder';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearAgentStopEvents();
});

/** Record `event` for wt-1/claude/claude at `at` (default: now). */
function record(event: AgentEventType, detail: string | null = null, at: number = NOW): void {
  recordAgentEvent('wt-1', 'claude', 'claude', { event, at, detail, sessionId: 'sess-1' });
}

function stateNow(): StructuredSessionState | null {
  return getStructuredSessionState('wt-1', 'claude', 'claude', NOW);
}

describe('agentEventToSessionStatus (Issue #1723)', () => {
  const cases: Array<[AgentEventType, string | null, string | null, string | null]> = [
    // event, detail, expected status, expected reason
    ['user_prompt_submit', null, 'running', HOOK_STATUS_REASON.PROMPT_SUBMIT],
    ['stop', null, 'ready', HOOK_STATUS_REASON.STOP],
    ['notification', 'permission_prompt', 'waiting', HOOK_STATUS_REASON.PERMISSION_PROMPT],
    ['notification', 'idle_prompt', 'ready', HOOK_STATUS_REASON.IDLE_PROMPT],
    // A Notification whose notification_type is one we have never observed is
    // not evidence of anything; guessing would be worse than the scraper.
    ['notification', 'some_future_type', null, null],
    ['notification', null, null, null],
    // The trust dialog blocks every hook, SessionStart included, for as long as
    // it is unanswered (25.3s measured). Its arrival cannot mean "up", so it
    // maps to no verdict at all — it only opens a generation.
    ['session_start', 'startup', null, null],
    ['session_start', 'clear', null, null],
    // `/clear` emits SessionEnd on a session that is alive and about to keep
    // going, so this must not be read as "the agent is idle".
    ['session_end', 'clear', null, null],
    ['session_end', 'prompt_input_exit', null, null],
  ];

  it.each(cases)('%s / %s -> %s', (event, detail, status, reason) => {
    const verdict = agentEventToSessionStatus(event, detail);
    if (status === null) {
      expect(verdict).toBeNull();
      return;
    }
    expect(verdict).toEqual({ status, reason });
  });
});

describe('getStructuredSessionState (Issue #1723)', () => {
  it('is null for an instance that has reported nothing', () => {
    expect(stateNow()).toBeNull();
  });

  it('answers with the verdict of the most recent event', () => {
    record('user_prompt_submit');
    expect(stateNow()).toEqual({
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
      event: 'user_prompt_submit',
      at: NOW,
      detail: null,
    });

    record('stop');
    expect(stateNow()?.status).toBe('ready');
  });

  it('does not leak across instances or worktrees', () => {
    record('stop');

    expect(getStructuredSessionState('wt-1', 'claude', 'claude-2', NOW)).toBeNull();
    expect(getStructuredSessionState('wt-2', 'claude', 'claude', NOW)).toBeNull();
    expect(getStructuredSessionState('wt-1', 'codex', 'claude', NOW)).toBeNull();
  });

  it('ignores an event that predates the current generation', () => {
    record('user_prompt_submit', null, NOW - 10_000);
    expect(stateNow()?.status).toBe('running');

    // The pane is reused by a session created after that event was reported.
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW - 5_000);

    expect(stateNow()).toBeNull();
    expect(getAgentEventGenerationStartedAt('wt-1', 'claude', 'claude')).toBe(NOW - 5_000);
  });

  it('honours an event reported after the generation opened', () => {
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW - 5_000);
    record('user_prompt_submit', null, NOW - 1_000);

    expect(stateNow()?.status).toBe('running');
  });

  it('treats a session_start as opening a generation of its own', () => {
    // `/clear`, or the agent being relaunched by hand inside a pane
    // CommandMate never recreated: no startClaudeSession() runs, so the event
    // itself has to fence off what came before it.
    record('user_prompt_submit', null, NOW - 10_000);
    record('session_start', 'clear', NOW - 5_000);

    expect(getAgentEventGenerationStartedAt('wt-1', 'claude', 'claude')).toBe(NOW - 5_000);
    // The session_start itself carries no verdict...
    expect(stateNow()).toBeNull();

    // ...and the stale `running` cannot come back, because the record that held
    // it has been replaced. Re-recording it at its ORIGINAL timestamp is still
    // refused: the generation, not arrival order, is what decides.
    record('user_prompt_submit', null, NOW - 10_000);
    expect(stateNow()).toBeNull();
  });

  it('discards the state for a session that was stopped', () => {
    record('user_prompt_submit');
    expect(stateNow()?.status).toBe('running');

    discardAgentEventState('wt-1', 'claude', 'claude');

    expect(stateNow()).toBeNull();
    expect(getAgentEventGenerationStartedAt('wt-1', 'claude', 'claude')).toBeNull();
  });

  it('stops trusting a verdict once it is older than the age bound', () => {
    // Hooks are fail-open, so a `Stop` that never arrived would otherwise leave
    // this asserting `running` forever and `wait` polling until --timeout.
    record('user_prompt_submit', null, NOW - STRUCTURED_STATE_MAX_AGE_MS + 1);
    expect(stateNow()?.status).toBe('running');

    record('user_prompt_submit', null, NOW - STRUCTURED_STATE_MAX_AGE_MS);
    expect(stateNow()).toBeNull();
  });
});

describe('mergeStructuredStatus (Issue #1723)', () => {
  const scraper = (over: Partial<ScraperVerdict> = {}): ScraperVerdict => ({
    status: 'ready',
    reason: 'no_recent_output',
    thinking: false,
    isUnclassifiedActive: false,
    ...over,
  });

  const structured = (over: Partial<StructuredSessionState> = {}): StructuredSessionState => ({
    status: 'ready',
    reason: HOOK_STATUS_REASON.STOP,
    event: 'stop',
    at: NOW,
    detail: null,
    ...over,
  });

  it('passes the scraper through untouched when no event has arrived', () => {
    const input = scraper({ status: 'running', reason: 'default', thinking: true, isUnclassifiedActive: true });

    expect(mergeStructuredStatus(input, null)).toEqual({ ...input, structuredApplied: false });
  });

  it('keeps a session running when the scraper has lost the generation indicator', () => {
    // Issue #805 / #1150 / #1497 in one line: the spinner scrolled out of the
    // capture window, so the frame reads as finished. The agent says otherwise.
    const merged = mergeStructuredStatus(
      scraper({ status: 'ready', reason: 'no_recent_output', isUnclassifiedActive: true }),
      structured({ status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT, event: 'user_prompt_submit' }),
    );

    expect(merged.status).toBe('running');
    expect(merged.reason).toBe('hook_prompt_submit');
    expect(merged.thinking).toBe(true);
    expect(merged.structuredApplied).toBe(true);
    // Left up on purpose: a frame nobody can classify is still a frame nobody
    // can classify, and `wait`'s exit-10 hatch is the last resort for screens
    // that emit no events at all (AskUserQuestion, #1708).
    expect(merged.isUnclassifiedActive).toBe(true);
  });

  it('completes a session whose pane still looks busy after Stop', () => {
    const merged = mergeStructuredStatus(
      scraper({ status: 'running', reason: 'default', thinking: true, isUnclassifiedActive: true }),
      structured(),
    );

    expect(merged.status).toBe('ready');
    expect(merged.reason).toBe('hook_stop');
    expect(merged.thinking).toBe(false);
    // Cleared here and only here: `wait` completes on
    // `ready && isUnclassifiedActive !== true`, so leaving it up would make the
    // structured `ready` change nothing at all.
    expect(merged.isUnclassifiedActive).toBe(false);
    expect(merged.structuredApplied).toBe(true);
  });

  it('leaves a static overlay reachable when both layers already agree on ready', () => {
    // A `/help` overlay left on screen after a turn (#1497). Both layers say
    // ready, so the structured layer adds nothing — and clearing the flag would
    // take away the navigation hatch the user needs to get out of the overlay.
    const merged = mergeStructuredStatus(
      scraper({ status: 'ready', reason: 'no_recent_output', isUnclassifiedActive: true }),
      structured(),
    );

    expect(merged.status).toBe('ready');
    expect(merged.isUnclassifiedActive).toBe(true);
  });

  it('never overrides a frame the scraper read as waiting', () => {
    // The live capture found NO event of any kind while an AskUserQuestion
    // selection or confirmation screen is up, so the newest structured fact
    // there is the user_prompt_submit that opened the turn. Applying it would
    // publish `running` for a session that is stopped dead waiting for a human
    // — the exact #1708 stall.
    const input = scraper({ status: 'waiting', reason: 'prompt_detected' });

    const merged = mergeStructuredStatus(
      input,
      structured({ status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT, event: 'user_prompt_submit' }),
    );

    expect(merged).toEqual({ ...input, structuredApplied: false });
  });

  it('records but does not apply a structured waiting', () => {
    // #1725 owns isPromptWaiting / promptData, and nothing marks a permission
    // prompt as answered, so an applied `waiting` would stick until the next
    // Stop and describe a session that went back to work minutes ago.
    const input = scraper({ status: 'running', reason: 'thinking_indicator', thinking: true });

    const merged = mergeStructuredStatus(
      input,
      structured({
        status: 'waiting',
        reason: HOOK_STATUS_REASON.PERMISSION_PROMPT,
        event: 'notification',
        detail: 'permission_prompt',
      }),
    );

    expect(merged).toEqual({ ...input, structuredApplied: false });
  });

  it('applies over an idle scraper verdict too', () => {
    const merged = mergeStructuredStatus(
      scraper({ status: 'idle', reason: 'default' }),
      structured({ status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT, event: 'user_prompt_submit' }),
    );

    expect(merged.status).toBe('running');
    expect(merged.structuredApplied).toBe(true);
  });
});
