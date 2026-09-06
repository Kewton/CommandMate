/**
 * Issue #2363: a Claude `/model` or `/fast` switch arriving over the hook
 * channel as `notification(model_switch:<to_model>)` with the new model on it.
 *
 * #2361 let the frame overtake a hook that could not re-report; this Issue
 * makes the hook re-report, and the rule in `agent-event-state` was written to
 * defer to exactly that. What has to hold, in order:
 *
 *  1. the hook write moves the latch and the merged model, and the #2357 edge
 *     fires once, from the hook, with the `SessionStart` spelling;
 *  2. the frame re-reading the rewritten banner or the confirmation line names
 *     the SAME model in its label spelling and does not overtake, so the
 *     exact id stays published and no second edge fires — including `/fast`,
 *     whose two on-screen spellings (`Opus 5` / `Opus 5 (1M context)`) #2361
 *     refused to reconcile;
 *  3. a switch is not a status: no turn opens or closes, no dialog is released,
 *     `awaiting_instruction` is untouched;
 *  4. the frame path is still there for the sessions the hook never reaches.
 *
 * Every hook value below is one a real 2.1.263 sent
 * (`tests/fixtures/hooks/claude-model-switch-2363/`); every frame value is one
 * the #2361 pane captures show.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getAgentModelBaseline,
  getAgentTurn,
  getLastAgentEvent,
  getLastCapturedModelInfo,
  getLastKnownAgentModel,
  getPendingDecisions,
  getResolvedAgentModelInfo,
  getStructuredSessionState,
  isAwaitingInstruction,
  isDuplicateAgentEvent,
  onAgentModelChange,
  recordAgentEvent,
  recordCapturedModelInfo,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';
import { agentEventToSessionStatus } from '@/lib/session/status-mapping';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { MODEL_SWITCH_DETAIL, modelSwitchDetail } from '@/lib/hooks/sources/claude/model-switch';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2363';
const T0 = 1_800_000_000_000;
const SESSION = '00000000-0000-4000-8000-000000000000';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';
const OPUS_1M = 'claude-opus-5[1m]';

const HOOK_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude-model-switch-2363');
const PANE_FIXTURES = join(process.cwd(), 'tests/fixtures/claude-model-switch-2361');

const unsubscribers: Array<() => void> = [];

function listen(): AgentModelChange[] {
  const changes: AgentModelChange[] = [];
  unsubscribers.push(onAgentModelChange((change) => changes.push(change)));
  return changes;
}

/** A structured event, the way the receiver records one. */
function hook(
  event: Parameters<typeof recordAgentEvent>[3]['event'],
  at: number,
  extra: Partial<Parameters<typeof recordAgentEvent>[3]> = {}
): void {
  recordAgentEvent(WT, 'claude', 'claude', {
    event,
    at,
    detail: null,
    sessionId: SESSION,
    model: null,
    ...extra,
  });
}

/**
 * A real `PostModelSwitch` payload, run through the real source and recorded
 * the way `POST /api/hooks/agent-event` records it.
 */
function postModelSwitch(fixture: string, at: number): string {
  const payload = JSON.parse(readFileSync(join(HOOK_FIXTURES, `${fixture}.json`), 'utf8'));
  const normalized = claudeAgentEventSource.normalizeEvent({ payload, receivedAt: at });
  if (!normalized) throw new Error(`${fixture} did not normalise`);
  recordAgentEvent(WT, 'claude', 'claude', {
    event: normalized.event,
    at,
    detail: normalized.detail,
    sessionId: normalized.conversationId,
    model: normalized.model,
  });
  return normalized.model ?? '';
}

function frame(model: string | null, effort: string | null, at: number): void {
  recordCapturedModelInfo(WT, 'claude', 'claude', { model, effort }, at);
}

/** Feed a #2361 pane capture through the real extractor, as the status poll does. */
function poll(name: string, at: number): void {
  const text = readFileSync(join(PANE_FIXTURES, `${name}.txt`), 'utf8');
  recordCapturedModelInfo(WT, 'claude', 'claude', extractModelInfo('claude', text), at);
}

const resolved = (tool: CLIToolType = 'claude') => getResolvedAgentModelInfo(WT, tool, tool);
const latched = () => getLastKnownAgentModel(WT, 'claude', 'claude');
const edges = (changes: AgentModelChange[]) =>
  changes.map((change) => [change.from, change.to, change.source]);

beforeEach(() => {
  clearAgentStopEvents();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  clearAgentStopEvents();
});

// =============================================================================
// 1. The hook moves the model
// =============================================================================

describe('PostModelSwitch moves the latch and the merged model (Issue #2363)', () => {
  it('`/model sonnet`: to_model becomes the model, and the edge fires once from the hook', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    expect(resolved().model).toBe(HAIKU);
    expect(changes).toEqual([]);

    expect(postModelSwitch('post-model-switch-command', T0 + 5_000)).toBe(SONNET);
    expect(latched()).toBe(SONNET);
    expect(resolved().model).toBe(SONNET);
    expect(changes).toEqual([
      expect.objectContaining({
        worktreeId: WT,
        cliToolId: 'claude',
        instanceId: 'claude',
        from: HAIKU,
        to: SONNET,
        source: 'hook',
        at: T0 + 5_000,
      }),
    ]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({ model: SONNET, source: 'hook' });
  });

  it('`/fast` from Haiku: the hook says claude-opus-5[1m], one spelling, one edge', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    expect(postModelSwitch('post-model-switch-fast-on', T0 + 5_000)).toBe(OPUS_1M);
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toEqual([[HAIKU, OPUS_1M, 'hook']]);
  });

  it('a chain of switches is a chain of edges, each from the hook', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000); // → sonnet
    postModelSwitch('post-model-switch-picker', T0 + 10_000); // → haiku
    postModelSwitch('post-model-switch-fast-on', T0 + 15_000); // → opus[1m]
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toEqual([
      [HAIKU, SONNET, 'hook'],
      [SONNET, HAIKU, 'hook'],
      [HAIKU, OPUS_1M, 'hook'],
    ]);
  });

  it('`/model opus` then `/model default` is a change (1M context is part of the model)', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: 'claude-opus-5' });
    postModelSwitch('post-model-switch-default', T0 + 5_000);
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toEqual([['claude-opus-5', OPUS_1M, 'hook']]);
  });

  it('a switch that names no model leaves the latch where it was (never from_model)', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: SONNET });
    // What the source produces for a `PostModelSwitch` without `to_model`.
    hook('notification', T0 + 5_000, { detail: MODEL_SWITCH_DETAIL, model: null });
    expect(latched()).toBe(SONNET);
    expect(resolved().model).toBe(SONNET);
    expect(changes).toEqual([]);
  });

  it('the same model reported again is not an edge', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: SONNET });
    hook('notification', T0 + 5_000, { detail: modelSwitchDetail(SONNET), model: SONNET });
    expect(changes).toEqual([]);
  });
});

// =============================================================================
// 2. The frame agrees and does not overtake
// =============================================================================

describe('the frame re-reading the switch names the same model and does not overtake', () => {
  it('`/model sonnet`: the rewritten banner and the line follow the hook', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000);
    // The next two polls read the rewritten banner (`Sonnet 5 with xhigh
    // effort`) and the `Set model to Sonnet 5 for this session only` line.
    poll('fullscreen-switch-sonnet-session-only', T0 + 6_000);
    poll('fullscreen-switch-sonnet-session-only', T0 + 8_000);
    expect(getLastCapturedModelInfo(WT, 'claude', 'claude').model).toBe('Sonnet 5');
    // The hook's exact id is what is published; the frame's effort rides along.
    expect(resolved()).toEqual({ model: SONNET, effort: 'xhigh' });
    expect(edges(changes)).toEqual([[HAIKU, SONNET, 'hook']]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({ model: SONNET, source: 'hook' });
  });

  it('`/fast`: `Opus 5 (1M context)` on the banner is the hook\'s claude-opus-5[1m]', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    // Before the switch the pane shows Haiku (banner has no effort clause, so
    // the confirmation line is what the extractor reads).
    poll('fullscreen-switch-haiku-arg', T0 + 2_000);
    expect(resolved().model).toBe(HAIKU);
    expect(changes).toEqual([]);

    postModelSwitch('post-model-switch-fast-on', T0 + 5_000);
    // `fullscreen-fast-on`: banner rewritten to `Opus 5 (1M context) with high
    // effort`, the lowest confirmation still the stale `Kept model as Haiku 4.5`.
    poll('fullscreen-fast-on', T0 + 6_000);
    expect(getLastCapturedModelInfo(WT, 'claude', 'claude').model).toBe('Opus 5 (1M context)');
    expect(resolved().model).toBe(OPUS_1M);
    poll('fullscreen-fast-on', T0 + 8_000);
    expect(edges(changes)).toEqual([[HAIKU, OPUS_1M, 'hook']]);
  });

  it('the `/fast` line\'s own `Opus 5` spelling, were it read, is still the same model', () => {
    // #2361 refuses that line; the same-model rule would absorb it regardless.
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-fast-on', T0 + 5_000);
    frame('Opus 5', null, T0 + 6_000);
    frame('Opus 5 (1M context)', 'high', T0 + 8_000);
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toEqual([[HAIKU, OPUS_1M, 'hook']]);
  });

  it('a frame value captured BEFORE the hook does not overtake it', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: SONNET });
    // The pane still shows the previous session's Haiku line …
    frame('Haiku 4.5', null, T0 + 2_000);
    expect(resolved().model).toBe('Haiku 4.5');
    // … then the hook reports the switch to Opus 1M.
    postModelSwitch('post-model-switch-fast-on', T0 + 5_000);
    expect(resolved().model).toBe(OPUS_1M);
    // Re-reading the same stale row is not a newer statement.
    frame('Haiku 4.5', null, T0 + 7_000);
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toEqual([
      [SONNET, 'Haiku 4.5', 'frame'],
      ['Haiku 4.5', OPUS_1M, 'hook'],
    ]);
  });

  it('the poll landing first is one edge, not two (frame then hook)', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    // The status poll happened to run between the keypress and the POST.
    poll('fullscreen-switch-sonnet-session-only', T0 + 5_000);
    expect(resolved().model).toBe('Sonnet 5');
    postModelSwitch('post-model-switch-command', T0 + 5_100);
    // The hook is the newer statement of the same model: exact id, no edge.
    expect(resolved().model).toBe(SONNET);
    expect(edges(changes)).toEqual([[HAIKU, 'Sonnet 5', 'frame']]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({ model: SONNET, source: 'hook' });
  });

  it('`/clear` after a switch keeps the switched model', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000);
    // Measured: SessionEnd(clear) + SessionStart(clear) with no model key.
    hook('session_end', T0 + 10_000, { detail: 'clear' });
    hook('session_start', T0 + 10_001, { detail: 'clear' });
    expect(resolved().model).toBe(SONNET);
    expect(edges(changes)).toEqual([[HAIKU, SONNET, 'hook']]);
  });

  it('a relaunch (new generation) starts over from that process\'s SessionStart', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000);
    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 20_000);
    expect(latched()).toBeNull();
    hook('session_start', T0 + 21_000, { detail: 'startup', model: OPUS_1M });
    expect(resolved().model).toBe(OPUS_1M);
    // The new process's first model is announced to nobody.
    expect(edges(changes)).toEqual([[HAIKU, SONNET, 'hook']]);
  });
});

// =============================================================================
// 3. A switch is not a status
// =============================================================================

describe('notification(model_switch) decides nothing about the session', () => {
  it('has no status verdict of its own', () => {
    expect(agentEventToSessionStatus('notification', MODEL_SWITCH_DETAIL)).toBeNull();
    expect(agentEventToSessionStatus('notification', modelSwitchDetail(SONNET))).toBeNull();
  });

  it('opens no turn on an idle instance', () => {
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000);
    expect(getStructuredSessionState(WT, 'claude', 'claude', T0 + 5_001)).toBeNull();
    expect(getAgentTurn(WT, 'claude', 'claude')).toBeNull();
    expect(isAwaitingInstruction(WT, 'claude', 'claude')).toBe(false);
    // It is still the newest event, for `structuredEvents.lastEventDetail`.
    expect(getLastAgentEvent(WT, 'claude', 'claude')).toMatchObject({
      event: 'notification',
      detail: modelSwitchDetail(SONNET),
      model: SONNET,
    });
  });

  it('leaves an open turn open and a pending approval pending', () => {
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    hook('user_prompt_submit', T0 + 1_000);
    hook('notification', T0 + 2_000, { detail: 'permission_prompt', message: 'Bash' });
    expect(getStructuredSessionState(WT, 'claude', 'claude', T0 + 2_500)?.status).toBe('waiting');
    expect(getPendingDecisions(WT, 'claude', 'claude', T0 + 2_500)).toHaveLength(1);

    // The human answers the dialog by switching model first (or an `auto`
    // fallback fires mid-turn): the dialog is still there.
    postModelSwitch('post-model-switch-command', T0 + 3_000);
    expect(getStructuredSessionState(WT, 'claude', 'claude', T0 + 3_500)?.status).toBe('waiting');
    expect(getPendingDecisions(WT, 'claude', 'claude', T0 + 3_500)).toHaveLength(1);
    expect(getAgentTurn(WT, 'claude', 'claude')?.closedAt).toBeNull();
    expect(resolved().model).toBe(SONNET);
  });

  it('leaves awaiting_instruction as it found it', () => {
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    hook('user_prompt_submit', T0 + 1_000);
    hook('stop', T0 + 2_000);
    hook('notification', T0 + 3_000, { detail: 'idle_prompt' });
    expect(isAwaitingInstruction(WT, 'claude', 'claude')).toBe(true);
    postModelSwitch('post-model-switch-command', T0 + 4_000);
    expect(isAwaitingInstruction(WT, 'claude', 'claude')).toBe(true);
    expect(getStructuredSessionState(WT, 'claude', 'claude', T0 + 4_500)?.status).toBe('ready');
  });
});

// =============================================================================
// 4. The frame path stays for sessions the hook never reaches
// =============================================================================

describe('the #2361 frame path is the fallback, not a casualty', () => {
  it('a switch the hook did not deliver is still read off the pane', () => {
    // A claude older than the hook, injection off, or a lost POST: the latch
    // is stale and the frame is the only channel that heard the switch.
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    poll('fullscreen-switch-sonnet-session-only', T0 + 6_000);
    expect(resolved().model).toBe('Sonnet 5');
    expect(edges(changes)).toEqual([[HAIKU, 'Sonnet 5', 'frame']]);
  });

  it('after a delivered switch, a LATER switch the hook missed is still read off the pane', () => {
    const changes = listen();
    hook('session_start', T0, { detail: 'startup', model: HAIKU });
    postModelSwitch('post-model-switch-command', T0 + 5_000); // → sonnet, delivered
    poll('fullscreen-switch-sonnet-session-only', T0 + 6_000);
    expect(resolved().model).toBe(SONNET);
    // `/model haiku` whose PostModelSwitch never arrived: the pane changes.
    poll('fullscreen-switch-haiku-arg', T0 + 20_000);
    expect(resolved().model).toBe('Haiku 4.5');
    expect(edges(changes)).toEqual([
      [HAIKU, SONNET, 'hook'],
      [SONNET, 'Haiku 4.5', 'frame'],
    ]);
    // And the next delivered switch takes the channel back.
    postModelSwitch('post-model-switch-fast-on', T0 + 30_000);
    expect(resolved().model).toBe(OPUS_1M);
    expect(edges(changes)).toHaveLength(3);
    expect(edges(changes)[2]).toEqual(['Haiku 4.5', OPUS_1M, 'hook']);
  });

  it('is scoped to claude: codex hooks keep winning over a disagreeing footer', () => {
    const changes = listen();
    recordAgentEvent(WT, 'codex', 'codex', {
      event: 'session_start',
      at: T0,
      detail: null,
      sessionId: 's',
      model: 'gpt-5.6-sol',
    });
    recordCapturedModelInfo(WT, 'codex', 'codex', { model: 'gpt-5-mini', effort: null }, T0 + 2_000);
    expect(resolved('codex').model).toBe('gpt-5.6-sol');
    expect(changes).toEqual([]);
  });
});

// =============================================================================
// De-duplication
// =============================================================================

describe('the receiver\'s dedup key carries the subtype, and the subtype carries the target', () => {
  const dup = (at: number, detail: string) =>
    isDuplicateAgentEvent(WT, 'claude', 'claude', 'notification', SESSION, at, detail);

  it('two deliveries of one switch (a user\'s own hook beside the injected one) are one', () => {
    expect(dup(T0, modelSwitchDetail(SONNET))).toBe(false);
    expect(dup(T0 + 200, modelSwitchDetail(SONNET))).toBe(true);
  });

  it('two switches to different models inside the window both land', () => {
    // Picker `s` to Haiku, then `/fast` a second later: two targets, two keys.
    expect(dup(T0, modelSwitchDetail(HAIKU))).toBe(false);
    expect(dup(T0 + 1_000, modelSwitchDetail(OPUS_1M))).toBe(false);
  });

  it('a switch does not swallow a permission_prompt in the same window, or vice versa', () => {
    expect(dup(T0, 'permission_prompt')).toBe(false);
    expect(dup(T0 + 100, modelSwitchDetail(SONNET))).toBe(false);
    expect(dup(T0 + 200, 'idle_prompt')).toBe(false);
  });
});
