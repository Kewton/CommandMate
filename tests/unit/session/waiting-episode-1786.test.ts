/**
 * The three pieces #1786 adds below the API surface, pinned without a tmux
 * session, a database or a clock the test does not own:
 *
 *  - `deriveWaitingKind` — the taxonomy #1787/#1788/#1790 will branch on;
 *  - `waiting-episode-state` — the single observer of the waiting edge, and the
 *    seam those Issues subscribe to;
 *  - `awaiting_instruction` — `Notification(idle_prompt)` as a third state
 *    beside the four `SessionStatus` values, which this Issue does not touch.
 *
 * The negative cases carry the weight, as in #1725's suite: a store that always
 * answered "waiting since now" would pass every positive assertion here, so each
 * stability claim is asserted against a clock that has visibly moved.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import {
  clearAgentStopEvents,
  beginAgentEventGeneration,
  discardAgentEventState,
  isAwaitingInstruction,
  getAwaitingInstruction,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisode,
  observeWaitingEdge,
  onWaitingTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  // CI runs `fileParallelism: false`, so one process holds these maps for the
  // whole suite. An episode left open here is a session the next file finds
  // already waiting.
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

describe('deriveWaitingKind (Issue #1786)', () => {
  it('answers null when the session is not waiting', () => {
    expect(
      deriveWaitingKind({
        waiting: false,
        hasActivePrompt: false,
        scraperStatus: 'ready',
        scraperReason: STATUS_REASON.INPUT_PROMPT,
      })
    ).toBeNull();
  });

  it('answers null even when the frame carried a prompt, if nothing is waiting', () => {
    // The `waiting` input is the composed verdict and it governs: a caller that
    // has already decided the session is not waiting must not get a kind back.
    expect(
      deriveWaitingKind({
        waiting: false,
        hasActivePrompt: true,
        scraperStatus: 'waiting',
        scraperReason: STATUS_REASON.PROMPT_DETECTED,
      })
    ).toBeNull();
  });

  it('classifies an answerable prompt as `prompt`', () => {
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: true,
        scraperStatus: 'waiting',
        scraperReason: STATUS_REASON.PROMPT_DETECTED,
      })
    ).toBe('prompt');
  });

  it.each([
    STATUS_REASON.CLAUDE_SELECTION_LIST,
    STATUS_REASON.CODEX_SELECTION_LIST,
    STATUS_REASON.COPILOT_SELECTION_LIST,
    STATUS_REASON.OPENCODE_SELECTION_LIST,
    STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
  ])('classifies the %s selection list as `menu`', (reason) => {
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: false,
        scraperStatus: 'waiting',
        scraperReason: reason,
      })
    ).toBe('menu');
  });

  it('classifies the Codex pager as `menu`', () => {
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: false,
        scraperStatus: 'waiting',
        scraperReason: STATUS_REASON.CODEX_PAGER,
      })
    ).toBe('menu');
  });

  it('classifies a wait only the structured layer can see as `unclassified`', () => {
    // The scraper read an ordinary composer; the dialog is one it is blind to.
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: false,
        scraperStatus: 'ready',
        scraperReason: STATUS_REASON.INPUT_PROMPT,
      })
    ).toBe('unclassified');
  });

  it('prefers `prompt` over `menu` when a frame would satisfy both', () => {
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: true,
        scraperStatus: 'waiting',
        scraperReason: STATUS_REASON.CODEX_SELECTION_LIST,
      })
    ).toBe('prompt');
  });
});

describe('waiting-episode-state: the edge (Issue #1786)', () => {
  const args = { worktreeId: 'wt-1', cliToolId: 'claude' as const, instanceId: 'claude' };

  it('opens an episode at the observation time and answers it', () => {
    expect(observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW })).toBe(NOW);
    expect(getWaitingEpisode('wt-1', 'claude', 'claude')).toEqual({ since: NOW, kind: 'prompt' });
  });

  it('keeps `since` fixed while the wait continues, however far the clock moves', () => {
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW });

    for (const elapsed of [5_000, 60_000, 3_600_000]) {
      expect(
        observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW + elapsed })
      ).toBe(NOW);
    }
  });

  it('prefers the structured episode start over the observation time', () => {
    // The agent posts the event the moment the dialog is drawn; the scraper is
    // behind a 5 s capture cache, so the poll that notices is always later.
    const structuredSince = NOW - 6_000;
    expect(
      observeWaitingEdge({ ...args, waiting: true, structuredSince, now: NOW })
    ).toBe(structuredSince);
  });

  it('refreshes the kind mid-episode without restarting it', () => {
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW });
    observeWaitingEdge({ ...args, waiting: true, kind: 'menu', now: NOW + 1_000 });

    expect(getWaitingEpisode('wt-1', 'claude', 'claude')).toEqual({ since: NOW, kind: 'menu' });
  });

  it('closes the episode when the wait ends, and starts a new one after that', () => {
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW });

    expect(observeWaitingEdge({ ...args, waiting: false, now: NOW + 1_000 })).toBeNull();
    expect(getWaitingEpisode('wt-1', 'claude', 'claude')).toBeNull();

    expect(
      observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW + 2_000 })
    ).toBe(NOW + 2_000);
  });

  it('keeps instances of the same tool independent', () => {
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW });
    observeWaitingEdge({
      worktreeId: 'wt-1',
      cliToolId: 'claude',
      instanceId: 'claude-2',
      waiting: true,
      kind: 'menu',
      now: NOW + 10_000,
    });

    expect(getWaitingEpisode('wt-1', 'claude', 'claude')?.since).toBe(NOW);
    expect(getWaitingEpisode('wt-1', 'claude', 'claude-2')?.since).toBe(NOW + 10_000);
  });
});

describe('waiting-episode-state: the subscription seam #1788 / #1790 use', () => {
  const args = { worktreeId: 'wt-1', cliToolId: 'claude' as const, instanceId: 'claude' };

  it('emits once per crossing, not once per poll', () => {
    const seen: WaitingTransition[] = [];
    onWaitingTransition((t) => seen.push(t));

    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW });
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW + 5_000 });
    observeWaitingEdge({ ...args, waiting: true, kind: 'prompt', now: NOW + 10_000 });
    observeWaitingEdge({ ...args, waiting: false, now: NOW + 15_000 });
    observeWaitingEdge({ ...args, waiting: false, now: NOW + 20_000 });

    expect(seen).toEqual([
      {
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        waiting: true,
        since: NOW,
        kind: 'prompt',
        at: NOW,
      },
      {
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        waiting: false,
        since: null,
        kind: null,
        at: NOW + 15_000,
      },
    ]);
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onWaitingTransition(listener);
    unsubscribe();

    observeWaitingEdge({ ...args, waiting: true, now: NOW });

    expect(listener).not.toHaveBeenCalled();
  });

  it('contains a listener that throws — the status read must still answer', () => {
    const healthy = vi.fn();
    onWaitingTransition(() => {
      throw new Error('the push sink is down');
    });
    onWaitingTransition(healthy);

    expect(() => observeWaitingEdge({ ...args, waiting: true, now: NOW })).not.toThrow();
    // …and the failure does not swallow the subscribers that follow it.
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

describe('awaiting_instruction (Issue #1786)', () => {
  function record(
    event: AgentEventType,
    detail: string | null = null,
    at: number = NOW,
    message: string | null = null,
  ): void {
    recordAgentEvent('wt-1', 'claude', 'claude', { event, at, detail, sessionId: 'sess-1', message });
  }

  it('is false before the agent has said anything', () => {
    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('is set by Notification(idle_prompt), with the agent’s own line', () => {
    record('notification', 'idle_prompt', NOW, 'Claude is waiting for your input');

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(true);
    expect(getAwaitingInstruction('wt-1', 'claude', 'claude')).toEqual({
      at: NOW,
      message: 'Claude is waiting for your input',
    });
  });

  it('is released by user_prompt_submit', () => {
    record('notification', 'idle_prompt');
    record('user_prompt_submit', null, NOW + 1_000);

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it.each(['session_start', 'session_end'] as const)('is released by %s', (event) => {
    record('notification', 'idle_prompt');
    record(event, null, NOW + 1_000);

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('survives the events that mean the agent is mid-turn on its own', () => {
    // A tool call or a permission dialog can only happen inside a turn, and that
    // turn's `user_prompt_submit` is what releases this. Releasing on them too
    // would only paper over a lost event — see the transition table.
    record('notification', 'idle_prompt');
    record('stop', null, NOW + 1_000);
    record('notification', 'permission_prompt', NOW + 2_000);
    record('pre_tool_use', 'Bash', NOW + 3_000);
    record('post_tool_use', 'Bash', NOW + 4_000);

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(true);
  });

  it('is NOT set by a plain stop — an intermediate turn boundary is not a request', () => {
    record('stop');

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('does not survive a new generation', () => {
    record('notification', 'idle_prompt');
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW + 1_000);

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('is fenced by generation even when the record is written out of order', () => {
    beginAgentEventGeneration('wt-1', 'claude', 'claude', NOW);
    record('notification', 'idle_prompt', NOW - 1_000);

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('is discarded with the rest of the instance state', () => {
    record('notification', 'idle_prompt');
    discardAgentEventState('wt-1', 'claude', 'claude');

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude')).toBe(false);
  });

  it('is per instance', () => {
    record('notification', 'idle_prompt');

    expect(isAwaitingInstruction('wt-1', 'claude', 'claude-2')).toBe(false);
    expect(isAwaitingInstruction('wt-2', 'claude', 'claude')).toBe(false);
  });
});
