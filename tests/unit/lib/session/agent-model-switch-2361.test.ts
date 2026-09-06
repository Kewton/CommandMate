/**
 * Issue #2361: the frame overtaking the hook after a Claude `/model` switch.
 *
 * #1784's merge rule is "hooks win the model", and #2357 judges the model
 * edge on that merged value. For Claude both are a trap: the hook names the
 * model on `SessionStart` alone (re-measured on 2.1.263 — `/model` fires no
 * registered event and `/clear`'s `SessionStart` carries no `model`), so after
 * a switch the hook latch is stale and the merged value never moved. The frame
 * reader #2361 added could see `Sonnet 5` on the pane and the UI would keep
 * saying `claude-fable-5-1[1m]`, with no edge for the three receivers.
 *
 * `agent-event-state` therefore lets the frame overtake the hook for claude —
 * and only when the frame's model half CHANGED after the hook last spoke and
 * names a different model. Every rule below is one of the false positives that
 * guard was shaped against.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getAgentModelBaseline,
  getLastCapturedModelInfo,
  getLastKnownAgentModel,
  getResolvedAgentModelInfo,
  onAgentModelChange,
  recordAgentEvent,
  recordCapturedModelInfo,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
import type { CLIToolType } from '@/lib/cli-tools/types';
import fs from 'fs';
import path from 'path';

const WT = 'wt-2361';
const T0 = 1_800_000_000_000;
/** What the 2.1.263 `SessionStart` reported at the start of the probe session. */
const HOOK_FABLE = 'claude-fable-5-1[1m]';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/claude-model-switch-2361');
const frameText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

const unsubscribers: Array<() => void> = [];

function listen(): AgentModelChange[] {
  const changes: AgentModelChange[] = [];
  unsubscribers.push(onAgentModelChange((change) => changes.push(change)));
  return changes;
}

function hook(
  tool: CLIToolType,
  event: Parameters<typeof recordAgentEvent>[3]['event'],
  model: string | null,
  at: number
): void {
  recordAgentEvent(WT, tool, tool, { event, at, detail: null, sessionId: 'ses-2361', model });
}

function frame(tool: CLIToolType, model: string | null, effort: string | null, at: number): void {
  recordCapturedModelInfo(WT, tool, tool, { model, effort }, at);
}

/** Feed a live fixture through the real extractor, as the status poll does. */
function poll(name: string, at: number): void {
  recordCapturedModelInfo(WT, 'claude', 'claude', extractModelInfo('claude', frameText(name)), at);
}

const resolved = (tool: CLIToolType = 'claude') => getResolvedAgentModelInfo(WT, tool, tool);

beforeEach(() => {
  clearAgentStopEvents();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  clearAgentStopEvents();
});

// =============================================================================
// The switch, end to end through the real extractor
// =============================================================================

describe('a claude /model switch reaches the merged model (Issue #2361)', () => {
  it('the frame overtakes a stale hook and the edge fires exactly once', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    // The startup banner, polled every two seconds: same model, hook spelling.
    poll('fullscreen-boot-fable', T0 + 2_000);
    poll('fullscreen-boot-fable', T0 + 4_000);
    expect(resolved()).toEqual({ model: HOOK_FABLE, effort: 'xhigh' });
    expect(changes).toEqual([]);

    // `/model` → Sonnet, `s`. The next poll sees the rewritten banner and the line.
    poll('fullscreen-switch-sonnet-session-only', T0 + 6_000);
    expect(resolved()).toEqual({ model: 'Sonnet 5', effort: 'xhigh' });
    expect(changes).toEqual([
      expect.objectContaining({
        worktreeId: WT,
        cliToolId: 'claude',
        instanceId: 'claude',
        from: HOOK_FABLE,
        to: 'Sonnet 5',
        source: 'frame',
        at: T0 + 6_000,
      }),
    ]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({ model: 'Sonnet 5', source: 'frame' });

    // Later polls of the same pane are not a second edge.
    poll('fullscreen-switch-sonnet-session-only', T0 + 8_000);
    poll('fullscreen-switch-sonnet-session-only', T0 + 10_000);
    expect(changes).toHaveLength(1);
    // The hook latch itself is untouched: the exact id is still there to recover.
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe(HOOK_FABLE);
  });

  it('the acceptance frame — banner gone, line only — is enough on its own', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    poll('fullscreen-switch-sonnet-banner-scrolled', T0 + 60_000);
    expect(resolved().model).toBe('Sonnet 5');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: HOOK_FABLE, to: 'Sonnet 5', source: 'frame' });
  });

  it('the same model picked again is not a change (`/model haiku` twice)', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    poll('fullscreen-switch-haiku-arg', T0 + 2_000);
    expect(resolved().model).toBe('Haiku 4.5');
    expect(changes).toHaveLength(1);
    poll('fullscreen-same-model-haiku-arg', T0 + 4_000);
    poll('fullscreen-picker-escaped-kept', T0 + 6_000);
    expect(resolved().model).toBe('Haiku 4.5');
    expect(changes).toHaveLength(1);
  });

  it('switching back to the model the hook named restores the hook spelling', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    frame('claude', 'Sonnet 5', null, T0 + 2_000);
    expect(resolved().model).toBe('Sonnet 5');
    // `/model fable`: the line reads `Fable 5.1`, the hook's id names the same
    // model, so the merge falls back to the exact id.
    frame('claude', 'Fable 5.1', null, T0 + 4_000);
    expect(resolved().model).toBe(HOOK_FABLE);
    expect(changes.map((change) => [change.from, change.to])).toEqual([
      [HOOK_FABLE, 'Sonnet 5'],
      ['Sonnet 5', HOOK_FABLE],
    ]);
    expect(getAgentModelBaseline(WT, 'claude', 'claude')).toEqual({ model: HOOK_FABLE, source: 'hook' });
  });

  it('a frame that stops showing the model leaves the overtaken value in place', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    poll('fullscreen-switch-sonnet-banner-scrolled', T0 + 2_000);
    // The line scrolls away too: the extractor answers unknown, nothing is written.
    poll('fullscreen-switch-line-scrolled', T0 + 4_000);
    expect(getLastCapturedModelInfo(WT, 'claude', 'claude').model).toBe('Sonnet 5');
    expect(resolved().model).toBe('Sonnet 5');
    expect(changes).toHaveLength(1);
  });

  it('`/clear` (session_end + session_start without a model) keeps the switched model', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    frame('claude', 'Sonnet 5', null, T0 + 2_000);
    expect(changes).toHaveLength(1);
    // Measured on 2.1.263: the SessionStart a /clear emits has no `model` key.
    hook('claude', 'session_end', null, T0 + 4_000);
    hook('claude', 'session_start', null, T0 + 4_001);
    expect(resolved().model).toBe('Sonnet 5');
    // And the pane after /clear shows only a banner, re-read as the same value.
    frame('claude', 'Sonnet 5', 'xhigh', T0 + 6_000);
    expect(changes).toHaveLength(1);
  });
});

// =============================================================================
// What must NOT overtake
// =============================================================================

describe('when the frame does not overtake the hook (Issue #2361)', () => {
  it('a frame value that predates the hook: a relaunched process reports its starting model', () => {
    const changes = listen();
    // A switch line still on the pane from the previous process …
    frame('claude', 'Sonnet 5', null, T0);
    // … then the new process names itself.
    hook('claude', 'session_start', 'claude-haiku-4-5-20251001', T0 + 5_000);
    expect(resolved().model).toBe('claude-haiku-4-5-20251001');
    // Re-reading the same stale row does not make it newer.
    frame('claude', 'Sonnet 5', null, T0 + 7_000);
    frame('claude', 'Sonnet 5', null, T0 + 9_000);
    expect(resolved().model).toBe('claude-haiku-4-5-20251001');
    expect(changes).toEqual([]);
  });

  it('the same model, however spelled, on either channel', () => {
    const changes = listen();
    hook('claude', 'session_start', 'claude-opus-5[1m]', T0);
    frame('claude', 'Opus 5 (1M context)', 'xhigh', T0 + 2_000);
    // `/fast` prints the short label for the same id.
    frame('claude', 'Opus 5', null, T0 + 4_000);
    expect(resolved().model).toBe('claude-opus-5[1m]');
    expect(changes).toEqual([]);
  });

  it('a hook re-affirming its model after the frame moved wins again', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    frame('claude', 'Sonnet 5', null, T0 + 2_000);
    expect(resolved().model).toBe('Sonnet 5');
    // Not something 2.1.263 does on /model — but a hook that names a model is
    // the agent speaking, and the rule defers to the newer statement.
    hook('claude', 'user_prompt_submit', HOOK_FABLE, T0 + 4_000);
    expect(resolved().model).toBe(HOOK_FABLE);
    expect(changes.map((change) => [change.from, change.to, change.source])).toEqual([
      [HOOK_FABLE, 'Sonnet 5', 'frame'],
      ['Sonnet 5', HOOK_FABLE, 'hook'],
    ]);
  });

  it('an effort-only frame moves nothing', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    frame('claude', null, 'low', T0 + 2_000);
    expect(resolved()).toEqual({ model: HOOK_FABLE, effort: 'low' });
    expect(changes).toEqual([]);
  });

  it('a new generation drops the frame stamp with the latch', () => {
    const changes = listen();
    hook('claude', 'session_start', HOOK_FABLE, T0);
    frame('claude', 'Sonnet 5', null, T0 + 2_000);
    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 10_000);
    hook('claude', 'session_start', HOOK_FABLE, T0 + 11_000);
    expect(resolved().model).toBe(HOOK_FABLE);
    // The first sighting of the new generation is announced to nobody.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: HOOK_FABLE, to: 'Sonnet 5' });
  });

  it('is scoped to claude: codex hooks keep winning over a disagreeing footer', () => {
    const changes = listen();
    hook('codex', 'session_start', 'gpt-5.6-sol', T0);
    frame('codex', 'gpt-5-mini', 'medium', T0 + 2_000);
    // codex re-reports its model on every event, so a footer that disagrees
    // with a hook still re-affirming its value is a misread, not news.
    expect(resolved('codex').model).toBe('gpt-5.6-sol');
    expect(changes).toEqual([]);
    hook('codex', 'user_prompt_submit', 'gpt-5-mini', T0 + 4_000);
    expect(resolved('codex').model).toBe('gpt-5-mini');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'gpt-5.6-sol', to: 'gpt-5-mini', source: 'hook' });
  });

  it('without any hook the frame is the only source, as before', () => {
    const changes = listen();
    poll('fullscreen-boot-fable', T0);
    poll('fullscreen-switch-sonnet-session-only', T0 + 2_000);
    expect(resolved()).toEqual({ model: 'Sonnet 5', effort: 'xhigh' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'Fable 5.1', to: 'Sonnet 5', source: 'frame' });
  });
});
