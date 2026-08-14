/**
 * Model extraction in the normalisation layer (Issue #1783, Phase 1/3).
 *
 * The model was already in four of the six tools' payloads and was being
 * dropped: `NormalizedAgentEvent` had no field for it, so everything above the
 * source layer was blind to a fact the agent had already stated. What this suite
 * is written against is not "the extraction is wrong" but the two ways it can be
 * *inert*:
 *
 *  1. **The wrong key, silently.** Every tool spells it differently — `model`,
 *     `modelName`, `model.modelID`, `model.id` — and a lookup that misses simply
 *     answers null, which is indistinguishable from a tool that never sends one.
 *     So every assertion below reads a real captured fixture and demands the
 *     literal string that is in the file.
 *  2. **The wrong event.** claude publishes the model on `SessionStart` alone
 *     and codex on everything except `SessionEnd`; a suite that only checked
 *     `session-start.json` would pass against an implementation that read the
 *     key from one event and forgot the rest.
 *
 * Inputs are the files in `tests/fixtures/hooks/`, never hand-written
 * approximations: four of the six tools auto-updated themselves mid-capture
 * (#1757 P12), so a payload invented from documentation is a payload nothing
 * ever sent.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import { resetUnknownEventTallies } from '@/lib/hooks/sources';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { codexAgentEventSource } from '@/lib/hooks/sources/codex/source';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { geminiAgentEventSource } from '@/lib/hooks/sources/gemini/source';
import { copilotAgentEventSource } from '@/lib/hooks/sources/copilot/source';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

/** One captured payload, as it was actually received. */
function fixture(tool: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
}

beforeEach(() => {
  resetUnknownEventTallies();
});

// =============================================================================
// The four tools that publish a model
// =============================================================================

describe('claude — `model`, on SessionStart and nowhere else', () => {
  it('reads the model out of the real session-start payload', () => {
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: fixture('claude', 'session-start'),
    });

    expect(normalized?.event).toBe('session_start');
    // The `[1m]` suffix is part of the value the tool sent. It is displayed
    // verbatim: a display string the agent chose is the agent's to spell.
    expect(normalized?.model).toBe('claude-opus-5[1m]');
  });

  it('answers null — not undefined, not a throw — on every other captured event', () => {
    // This is the measurement the whole `getLastKnownAgentModel` design rests
    // on. If claude ever starts sending the model on `Stop`, this test is what
    // says so, and the latch becomes belt-and-braces rather than load-bearing.
    const withoutModel = [
      'user-prompt-submit',
      'stop',
      'pre-tool-use-bash',
      'notification-permission-prompt',
      'notification-idle-prompt',
      'session-end',
      'session-end-clear',
    ];
    for (const name of withoutModel) {
      const normalized = claudeAgentEventSource.normalizeEvent({
        payload: fixture('claude', name),
      });
      expect(normalized, `${name} should normalise`).not.toBeNull();
      expect(normalized?.model, `${name} should carry no model`).toBeNull();
    }
  });

  it('keeps the model when the caller already resolved the event word', () => {
    // The relay script's `--event` path, which bypasses the mapper list
    // entirely. Two `buildNormalizedEvent` call sites, and an implementation
    // that threaded the model into one of them would look correct in the other.
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: fixture('claude', 'session-start'),
      event: 'session_start',
    });
    expect(normalized?.model).toBe('claude-opus-5[1m]');
  });
});

describe('codex — `model`, on everything except SessionEnd', () => {
  const carriesModel: Array<[string, AgentEventType]> = [
    ['session-start', 'session_start'],
    ['user-prompt-submit', 'user_prompt_submit'],
    ['pre-tool-use', 'pre_tool_use'],
    ['post-tool-use', 'post_tool_use'],
    ['stop', 'stop'],
  ];

  it.each(carriesModel)('reads it from %s', (name, event) => {
    const normalized = codexAgentEventSource.normalizeEvent({ payload: fixture('codex', name) });
    expect(normalized?.event).toBe(event);
    expect(normalized?.model).toBe('gpt-5.6-sol');
  });

  it('answers null for session-end, which is the one payload without the key', () => {
    const normalized = codexAgentEventSource.normalizeEvent({
      payload: fixture('codex', 'session-end'),
    });
    expect(normalized?.event).toBe('session_end');
    expect(normalized?.model).toBeNull();
  });
});

describe('antigravity — `modelName`, protojson camelCase', () => {
  // agy publishes no event name at all (#1757 R2), so the word comes from the
  // relay's `--event` and every case here goes through the caller-resolved path.
  const carriesModel: Array<[string, AgentEventType]> = [
    ['session-start', 'session_start'],
    ['pre-tool-use', 'pre_tool_use'],
    ['post-tool-use', 'post_tool_use'],
    ['pre-invocation', 'user_prompt_submit'],
    ['post-invocation', 'stop'],
    ['stop', 'stop'],
  ];

  it.each(carriesModel)('reads it from %s', (name, event) => {
    const normalized = antigravityAgentEventSource.normalizeEvent({
      payload: fixture('antigravity', name),
      event,
    });
    expect(normalized?.model).toBe('gemini-3.5-flash-low');
  });

  it('does not accidentally read a plain `model` key, which agy never sends', () => {
    // The failure this guards is a copy-paste of claude's spec: `['model']`
    // instead of `['modelName']` answers null for every agy event, forever,
    // with nothing in any log.
    const payload = fixture('antigravity', 'session-start');
    expect(payload.model).toBeUndefined();
    expect(payload.modelName).toBe('gemini-3.5-flash-low');
  });
});

describe('opencode — nested, and under two different keys', () => {
  function frame(name: string): Record<string, unknown> {
    return fixture('opencode', name);
  }

  it('reads `properties.info.model.modelID` from a user message.updated frame', () => {
    const normalized = opencodeAgentEventSource.normalizeEvent({
      payload: frame('message-updated-user'),
    });
    expect(normalized?.event).toBe('user_prompt_submit');
    expect(normalized?.model).toBe('claude-sonnet-4.6');
  });

  it('reads `properties.info.model.id` from session.created', () => {
    // NOT what the Issue text said. #1783 named `model.modelID` as opencode's
    // location; the captured `session.created` / `session.deleted` frames spell
    // the same field `id`. Reading only `modelID` would leave `session_start` —
    // the one frame a fresh subscription is guaranteed to see — with no model.
    const normalized = opencodeAgentEventSource.normalizeEvent({
      payload: frame('session-created'),
    });
    expect(normalized?.event).toBe('session_start');
    expect(normalized?.model).toBe('claude-sonnet-4.6');
  });

  it('reads a non-anthropic model from session.deleted, so the value is not hardcoded', () => {
    const normalized = opencodeAgentEventSource.normalizeEvent({
      payload: frame('session-deleted'),
    });
    expect(normalized?.event).toBe('session_end');
    expect(normalized?.model).toBe('qwen/qwen3-coder-30b');
  });

  it('answers null on the frames that carry no model at all', () => {
    // `session.idle` is `{ sessionID }` and nothing else (#1758 §5.3.3); the
    // tool-part frames describe a tool call, not a message.
    for (const name of [
      'session-idle',
      'message-part-updated-tool-running',
      'message-part-updated-tool-completed',
    ]) {
      const normalized = opencodeAgentEventSource.normalizeEvent({ payload: frame(name) });
      expect(normalized, `${name} should normalise`).not.toBeNull();
      expect(normalized?.model, `${name} should carry no model`).toBeNull();
    }
  });

  it('does not read the /api/event (v2) envelope, which nests under `data`', () => {
    // The v2 envelope is in the fixtures for comparison only — it goes silent
    // after three frames (#1758 §5.2.2) and is never subscribed to. Its model
    // sits at `data.info.model.modelID`, which this reader must NOT find, or
    // the reader is matching on shape rather than on the documented path.
    const envelope = fixture('opencode', 'api-event-envelope-message-updated');
    const normalized = opencodeAgentEventSource.normalizeEvent({ payload: envelope });
    expect(normalized?.model ?? null).toBeNull();
  });
});

// =============================================================================
// The two tools that do not, and the shapes that must not throw
// =============================================================================

describe('gemini / copilot — out of scope for Phase 1, and null rather than absent', () => {
  it('gemini answers null for every event it can map', () => {
    // `BeforeModel` — the one gemini payload with a model in it — is not in
    // `GEMINI_HOOK_EVENT_NAMES` and is dropped as an unknown event, so Phase 1
    // has no route to it. That is a scope decision, not an oversight; this test
    // pins the current behaviour so a later Issue that adds the vocabulary sees
    // this fail rather than quietly changing what the UI shows.
    for (const name of ['session-start', 'session-end', 'before-agent']) {
      const normalized = geminiAgentEventSource.normalizeEvent({ payload: fixture('gemini', name) });
      if (normalized) expect(normalized.model, name).toBeNull();
    }
    expect(geminiAgentEventSource.normalizeEvent({ payload: fixture('gemini', 'before-model') })).toBeNull();
  });

  it('copilot answers null for every captured event', () => {
    for (const name of ['session-start', 'user-prompt-submit', 'pre-tool-use', 'stop', 'session-end']) {
      const normalized = copilotAgentEventSource.normalizeEvent({
        payload: fixture('copilot', name),
      });
      expect(normalized, name).not.toBeNull();
      expect(normalized?.model, name).toBeNull();
    }
  });
});

describe('malformed payloads answer null instead of throwing (C8)', () => {
  it('survives a model key of the wrong type', () => {
    for (const value of [42, null, {}, [], true, '']) {
      const normalized = claudeAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'SessionStart', model: value },
      });
      expect(normalized?.model, `model=${JSON.stringify(value)}`).toBeNull();
    }
  });

  it('survives opencode nesting that stops short', () => {
    const partial = [
      { type: 'session.created', properties: {} },
      { type: 'session.created', properties: { info: null } },
      { type: 'session.created', properties: { info: { model: 'not-an-object' } } },
      { type: 'session.created', properties: { info: { model: { providerID: 'p' } } } },
    ];
    for (const payload of partial) {
      expect(() => opencodeAgentEventSource.normalizeEvent({ payload })).not.toThrow();
      expect(opencodeAgentEventSource.normalizeEvent({ payload })?.model).toBeNull();
    }
  });

  it('bounds the stored string, because the payload is whatever the agent sent', () => {
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: { hook_event_name: 'SessionStart', model: 'm'.repeat(4096) },
    });
    expect(normalized?.model).toHaveLength(MAX_EVENT_DETAIL_LENGTH);
  });
});
