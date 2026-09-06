/**
 * The model edge (Issue #2357).
 *
 * `agent-event-state` latches the last non-null model from two channels — the
 * agent's own hook events and the terminal frame — and until this Issue nothing
 * compared one report against the last. This suite pins the comparison, and
 * mostly what it must NOT do, because every rule below is a measured false
 * positive:
 *
 *  - the first value an instance ever reports is its starting model, not a change;
 *  - a frame that stopped showing the banner is not a change (the latch holds);
 *  - the same model spelled two ways is not a change — within a channel
 *    (`GPT-5 mini` / `gpt-5-mini`) and, more loosely, across them
 *    (`Gemini 3.7 Flash` / `gemini-3.7-flash-high`, `Opus 5 (1M context)` /
 *    `claude-opus-5[1m]`);
 *  - a new agent process (`session_start`, a new generation, a discarded
 *    session) starts over, whatever model it names.
 *
 * The state lives on `globalThis` and CI runs with `fileParallelism: false`, so
 * `clearAgentStopEvents` runs before AND after each test, and every listener is
 * unsubscribed in `afterEach` — a listener left behind would receive edges
 * raised by an unrelated suite, in file order, only in CI.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  discardAgentEventState,
  getAgentModelBaseline,
  getResolvedAgentModelInfo,
  isSameAgentModelName,
  onAgentModelChange,
  recordAgentEvent,
  recordCapturedModelInfo,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2357';
const T0 = 1_800_000_000_000;

const unsubscribers: Array<() => void> = [];

/** Subscribe for the test's lifetime and collect what arrives. */
function listen(): AgentModelChange[] {
  const changes: AgentModelChange[] = [];
  unsubscribers.push(onAgentModelChange((change) => changes.push(change)));
  return changes;
}

/** One hook delivery carrying (or not carrying) a model. */
function hook(
  tool: CLIToolType,
  event: Parameters<typeof recordAgentEvent>[3]['event'],
  model: string | null,
  at: number,
  instanceId: string = tool
): void {
  recordAgentEvent(WT, tool, instanceId, {
    event,
    at,
    detail: null,
    sessionId: 'ses-1',
    model,
  });
}

/** One frame read, as `worktree-status-helper` hands it over. */
function frame(
  tool: CLIToolType,
  model: string | null,
  effort: string | null,
  at: number,
  instanceId: string = tool
): void {
  recordCapturedModelInfo(WT, tool, instanceId, { model, effort }, at);
}

beforeEach(() => {
  clearAgentStopEvents();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  clearAgentStopEvents();
});

// =============================================================================
// isSameAgentModelName
// =============================================================================

describe('isSameAgentModelName', () => {
  it('treats case, spaces and dashes as spelling within one channel', () => {
    expect(isSameAgentModelName('GPT-5 mini', 'gpt-5-mini')).toBe(true);
    expect(isSameAgentModelName('GPT-5.6 Sol', 'gpt-5.6-sol')).toBe(true);
  });

  it('keeps gpt-5 and gpt-5-mini apart within one channel — the downgrade itself', () => {
    expect(isSameAgentModelName('gpt-5', 'gpt-5-mini')).toBe(false);
    expect(isSameAgentModelName('GPT-5', 'GPT-5 mini')).toBe(false);
  });

  it('ignores a trailing effort token, which agy encodes in the id', () => {
    expect(isSameAgentModelName('gemini-3.7-flash-high', 'gemini-3.7-flash-low')).toBe(true);
    expect(isSameAgentModelName('gemini-3.7-flash-xhigh', 'gemini-3.7-flash')).toBe(true);
    // `mini` is not an effort word and must survive.
    expect(isSameAgentModelName('gpt-5-mini', 'gpt-5')).toBe(false);
  });

  it('widens to containment only across channels', () => {
    // The measured pairs: display label on the frame, id over the hook.
    expect(
      isSameAgentModelName('Gemini 3.7 Flash', 'gemini-3.7-flash-high', { crossSource: true })
    ).toBe(true);
    expect(
      isSameAgentModelName('Opus 5 (1M context)', 'claude-opus-5[1m]', { crossSource: true })
    ).toBe(true);
    expect(
      isSameAgentModelName('Claude Sonnet 4.6', 'anthropic/claude-sonnet-4.6', { crossSource: true })
    ).toBe(true);
    // …and the widening is NOT available within a channel: the same pair that
    // matched above by containment does not match as an exact key.
    expect(isSameAgentModelName('Opus 5 (1M context)', 'claude-opus-5[1m]')).toBe(false);
    expect(isSameAgentModelName('Claude Sonnet 4.6', 'anthropic/claude-sonnet-4.6')).toBe(false);
    // A genuinely different model is different across channels too.
    expect(isSameAgentModelName('GPT-5 mini', 'gpt-5.6-sol', { crossSource: true })).toBe(false);
  });

  it('never matches an empty key against anything', () => {
    expect(isSameAgentModelName('', 'gpt-5', { crossSource: true })).toBe(false);
    expect(isSameAgentModelName('--', 'gpt-5', { crossSource: true })).toBe(false);
  });
});

// =============================================================================
// The suppression rules
// =============================================================================

describe('what is NOT a change', () => {
  it('null → value: the first report is the starting model and is announced to nobody', () => {
    const changes = listen();
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0);
    expect(changes).toEqual([]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({
      model: 'claude-opus-5[1m]',
      source: 'hook',
    });
  });

  it('the same value again, on any event, is not a change', () => {
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    hook('codex', 'user_prompt_submit', 'gpt-5.6-sol', T0 + 1_000);
    hook('codex', 'stop', 'gpt-5.6-sol', T0 + 2_000);
    // claude-style: events with no model at all leave the latch alone.
    hook('codex', 'user_prompt_submit', null, T0 + 3_000);
    expect(changes).toEqual([]);
  });

  it('value → null: a frame that stopped showing the model leaves the baseline where it was', () => {
    const changes = listen();
    frame('copilot', 'GPT-5.6 Sol', 'medium', T0);
    expect(getAgentModelBaseline(WT, 'copilot', 'copilot')?.model).toBe('GPT-5.6 Sol');
    // The banner scrolled away: the frame carries an effort and no model, or
    // nothing at all.
    frame('copilot', null, 'medium', T0 + 5_000);
    frame('copilot', null, null, T0 + 10_000);
    expect(changes).toEqual([]);
    expect(getAgentModelBaseline(WT, 'copilot', 'copilot')?.model).toBe('GPT-5.6 Sol');
    // …and when it shows the same model again, still nothing.
    frame('copilot', 'GPT-5.6 Sol', 'medium', T0 + 15_000);
    expect(changes).toEqual([]);
  });

  it('a spelling change within one channel is not a change (copilot bar vs notice)', () => {
    const changes = listen();
    frame('copilot', 'GPT-5 mini', null, T0);
    frame('copilot', 'gpt-5-mini', 'medium', T0 + 5_000);
    frame('copilot', 'GPT-5 mini', null, T0 + 10_000);
    expect(changes).toEqual([]);
  });

  it('the hook overtaking the frame with the id of the same model is not a change', () => {
    const changes = listen();
    // agy: the status bar is read before the first event lands.
    frame('antigravity', 'Gemini 3.7 Flash', 'high', T0);
    hook('antigravity', 'session_start', 'gemini-3.7-flash-high', T0 + 500);
    expect(changes).toEqual([]);
    // The baseline followed the hook, so the comparison from here on is id vs id.
    expect(getAgentModelBaseline(WT, 'antigravity', 'antigravity')).toEqual({
      model: 'gemini-3.7-flash-high',
      source: 'hook',
    });

    // claude: the startup banner, then SessionStart.
    frame('claude', 'Opus 5 (1M context)', 'xhigh', T0);
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0 + 500);
    expect(changes).toEqual([]);
  });

  it('an effort-only change in an id that encodes the effort is not a model change', () => {
    const changes = listen();
    hook('antigravity', 'session_start', 'gemini-3.7-flash-high', T0);
    hook('antigravity', 'pre_tool_use', 'gemini-3.7-flash-low', T0 + 1_000);
    expect(changes).toEqual([]);
  });

  it('a frame that disagrees with a hook that already spoke does not move the merged value', () => {
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    // The footer is the display of the same model; even a differently spelled
    // one changes nothing while the hook value stands (hooks win the merge).
    frame('codex', 'gpt-5.6-sol', 'xhigh', T0 + 1_000);
    expect(changes).toEqual([]);
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex').model).toBe('gpt-5.6-sol');
  });

  it('a new generation starts over: the next value is a first sighting', () => {
    const changes = listen();
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0);
    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 60_000);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toBeNull();
    hook('claude', 'session_start', 'claude-sonnet-5', T0 + 61_000);
    expect(changes).toEqual([]);
  });

  it('a discarded session starts over the same way', () => {
    const changes = listen();
    frame('copilot', 'GPT-5.6 Sol', 'medium', T0);
    discardAgentEventState(WT, 'copilot', 'copilot');
    frame('copilot', 'GPT-5 mini', 'medium', T0 + 60_000);
    expect(changes).toEqual([]);
  });

  it('a session_start names the starting model of a new process, not a change', () => {
    const changes = listen();
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0);
    hook('claude', 'user_prompt_submit', null, T0 + 1_000);
    // Relaunched by hand on another model; also what `/clear` looks like
    // (session_end then session_start) when the model happens to differ.
    hook('claude', 'session_end', null, T0 + 2_000);
    hook('claude', 'session_start', 'claude-sonnet-5', T0 + 3_000);
    expect(changes).toEqual([]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')?.model).toBe('claude-sonnet-5');
  });

  it('the test seam clears the baseline with the latches', () => {
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0);
    clearAgentStopEvents();
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toBeNull();
  });
});

// =============================================================================
// What IS a change
// =============================================================================

describe('what is a change', () => {
  it('hook → hook, a different model: exactly one edge, source hook', () => {
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    hook('codex', 'user_prompt_submit', 'gpt-5-mini', T0 + 30_000);
    expect(changes).toEqual([
      {
        worktreeId: WT,
        cliToolId: 'codex',
        instanceId: 'codex',
        from: 'gpt-5.6-sol',
        to: 'gpt-5-mini',
        source: 'hook',
        at: T0 + 30_000,
      },
    ]);
    // Repeats of the new value are not a second edge.
    hook('codex', 'stop', 'gpt-5-mini', T0 + 31_000);
    expect(changes).toHaveLength(1);
  });

  it('frame → frame, a different model: the copilot rate-limit downgrade', () => {
    const changes = listen();
    frame('copilot', 'GPT-5.6 Sol', 'medium', T0);
    // The `Model changed from … to …` notice, as the extractor reads it.
    frame('copilot', 'gpt-5-mini', 'medium', T0 + 45_000);
    expect(changes).toEqual([
      expect.objectContaining({
        cliToolId: 'copilot',
        from: 'GPT-5.6 Sol',
        to: 'gpt-5-mini',
        source: 'frame',
        at: T0 + 45_000,
      }),
    ]);
    // The bar re-read as a display label of the new model: same model.
    frame('copilot', 'GPT-5 mini', null, T0 + 50_000);
    expect(changes).toHaveLength(1);
  });

  it('gpt-5 → gpt-5-mini on one channel is a change, not a spelling', () => {
    const changes = listen();
    frame('copilot', 'GPT-5', 'medium', T0);
    frame('copilot', 'GPT-5 mini', 'medium', T0 + 1_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'GPT-5', to: 'GPT-5 mini' });
  });

  it('the hook overtaking the frame with a DIFFERENT model is a change', () => {
    const changes = listen();
    frame('codex', 'gpt-5.6-sol', 'xhigh', T0);
    hook('codex', 'user_prompt_submit', 'gpt-5-mini', T0 + 1_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'gpt-5.6-sol', to: 'gpt-5-mini', source: 'hook' });
  });

  it('keys per instance: a change on claude-2 says nothing about claude', () => {
    const changes = listen();
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0, 'claude');
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0, 'claude-2');
    hook('claude', 'session_start', 'claude-sonnet-5', T0 + 1_000, 'claude-2');
    // session_start resets — so relaunch claude-2 and then let it switch.
    hook('claude', 'user_prompt_submit', 'claude-haiku-5', T0 + 2_000, 'claude-2');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ instanceId: 'claude-2', from: 'claude-sonnet-5', to: 'claude-haiku-5' });
    expect(getAgentModelBaseline(WT, 'claude', 'claude')?.model).toBe('claude-opus-5[1m]');
  });

  it('a change after a resumed generation compares against the new starting model', () => {
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    beginAgentEventGeneration(WT, 'codex', 'codex', T0 + 10_000);
    hook('codex', 'session_start', 'gpt-5-mini', T0 + 11_000);
    hook('codex', 'user_prompt_submit', 'gpt-5.6-sol', T0 + 12_000);
    expect(changes).toEqual([
      expect.objectContaining({ from: 'gpt-5-mini', to: 'gpt-5.6-sol' }),
    ]);
  });
});

// =============================================================================
// The subscription
// =============================================================================

describe('onAgentModelChange', () => {
  it('delivers each edge to every listener once, and unsubscribes cleanly', () => {
    const a = listen();
    const b: AgentModelChange[] = [];
    const unsubscribeB = onAgentModelChange((change) => b.push(change));

    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    hook('codex', 'stop', 'gpt-5-mini', T0 + 1_000);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubscribeB();
    hook('codex', 'stop', 'gpt-5.6-sol', T0 + 2_000);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it('contains a throwing listener so the write that observed the edge completes', () => {
    unsubscribers.push(
      onAgentModelChange(() => {
        throw new Error('listener failed');
      })
    );
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    expect(() => hook('codex', 'stop', 'gpt-5-mini', T0 + 1_000)).not.toThrow();
    expect(changes).toHaveLength(1);
    // The baseline advanced regardless of the throw.
    expect(getAgentModelBaseline(WT, 'codex', 'codex')?.model).toBe('gpt-5-mini');
  });

  it('defaults the frame timestamp to now when the caller passes none', () => {
    const changes = listen();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      recordCapturedModelInfo(WT, 'copilot', 'copilot', { model: 'GPT-5.6 Sol', effort: null });
      vi.setSystemTime(T0 + 7_000);
      recordCapturedModelInfo(WT, 'copilot', 'copilot', { model: 'gpt-5-mini', effort: null });
    } finally {
      vi.useRealTimers();
    }
    expect(changes).toHaveLength(1);
    expect(changes[0].at).toBe(T0 + 7_000);
  });
});
