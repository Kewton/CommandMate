/**
 * Issue #2363: how the Claude source reads `PostModelSwitch`.
 *
 * Every payload here is a real one, delivered to a CommandMate-shaped
 * `type: "http"` hook by claude 2.1.263 on 2026-09-06
 * (`tests/fixtures/hooks/claude-model-switch-2363/README.md`). The rules under
 * test:
 *
 *  - `PostModelSwitch` → `notification` with the subtype
 *    `model_switch:<to_model>`, and the normalised `model` is `to_model`;
 *  - `from_model` is never the model — it is the value being left behind;
 *  - `requested_model` (null for `/model default` and `/fast`) is never read;
 *  - `PreModelSwitch` maps to nothing, and is tallied like any unknown event;
 *  - every event the source already read is read exactly as before.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import { getUnknownEventTally, resetUnknownEventTallies } from '@/lib/hooks/sources';
import {
  CLAUDE_POST_MODEL_SWITCH_EVENT_NAME,
  claudeModelSwitchMapper,
  extractClaudeSwitchedModel,
  isClaudeModelSwitchPayload,
  isModelSwitchDetail,
  MODEL_SWITCH_DETAIL,
  modelSwitchDetail,
} from '@/lib/hooks/sources/claude/model-switch';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

function fixture(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, dir, `${name}.json`), 'utf8'));
}

const switchFixture = (name: string) => fixture('claude-model-switch-2363', name);
const normalize = (payload: Record<string, unknown>) =>
  claudeAgentEventSource.normalizeEvent({ payload, receivedAt: 1_800_000_000_000 });

beforeEach(() => {
  resetUnknownEventTallies();
});

// =============================================================================
// The four measured switches
// =============================================================================

describe('PostModelSwitch normalises to notification(model_switch:<to_model>) carrying to_model', () => {
  it.each([
    ['post-model-switch-command', 'claude-sonnet-5'], // `/model sonnet`
    ['post-model-switch-picker', 'claude-haiku-4-5-20251001'], // picker + `s`
    ['post-model-switch-default', 'claude-opus-5[1m]'], // `/model default`, requested_model null
    ['post-model-switch-fast-on', 'claude-opus-5[1m]'], // `/fast` ON from Haiku
  ])('%s → %s', (name, expectedModel) => {
    const payload = switchFixture(name);
    expect(payload.hook_event_name).toBe(CLAUDE_POST_MODEL_SWITCH_EVENT_NAME);
    expect(payload.to_model).toBe(expectedModel);

    const normalized = normalize(payload);
    expect(normalized).not.toBeNull();
    expect(normalized?.event).toBe('notification');
    expect(normalized?.detail).toBe(`model_switch:${expectedModel}`);
    expect(normalized?.detail).toBe(modelSwitchDetail(expectedModel));
    expect(isModelSwitchDetail(normalized?.detail)).toBe(true);
    expect(normalized?.model).toBe(expectedModel);
    // Correlation fields come from the same keys every other event uses.
    expect(normalized?.conversationId).toBe('00000000-0000-4000-8000-000000000000');
    expect(normalized?.toolCallId).toBeNull();
    expect(normalized?.raw).toBe(payload);
    expect(getUnknownEventTally('claude').count).toBe(0);
  });

  it('`/fast` reports the one spelling, not the confirmation line\'s `Opus 5`', () => {
    // The whole reason #2361 refused to read the `/fast` line: `Opus 5` there,
    // `Opus 5 (1M context)` on the banner, and an exact same-channel match
    // between the two would announce a spurious change. The hook says
    // `claude-opus-5[1m]`, the `SessionStart` spelling, and nothing else.
    const normalized = normalize(switchFixture('post-model-switch-fast-on'));
    expect(normalized?.model).toBe('claude-opus-5[1m]');
    expect(normalized?.model).toBe(switchFixture('session-start-after-switches').model);
  });

  it('the subtype is a word of its own, not one the state machine acts on', () => {
    // `permission_prompt` opens a dialog record and `idle_prompt` publishes
    // `ready`; a switch must be neither. Pinned as a string so a rename shows
    // up as a decision rather than a silent re-filing.
    expect(MODEL_SWITCH_DETAIL).toBe('model_switch');
    expect(modelSwitchDetail('claude-sonnet-5')).toBe('model_switch:claude-sonnet-5');
    expect(modelSwitchDetail(null)).toBe('model_switch');
    for (const reserved of ['permission_prompt', 'idle_prompt', 'permission_replied']) {
      expect(isModelSwitchDetail(reserved)).toBe(false);
      expect(modelSwitchDetail('x').startsWith(reserved)).toBe(false);
    }
    expect(isModelSwitchDetail('model_switch')).toBe(true);
    expect(isModelSwitchDetail('model_switch:claude-opus-5[1m]')).toBe(true);
    expect(isModelSwitchDetail('model_switched')).toBe(false);
    expect(isModelSwitchDetail(null)).toBe(false);
    expect(isModelSwitchDetail(undefined)).toBe(false);
  });

  it('the subtype carries the target so two different switches in one window both land', () => {
    // The receiver de-duplicates on (event, detail, session_id) within 3 s.
    // `s` in the picker and then `/fast` are two switches; their subtypes differ.
    const picker = normalize(switchFixture('post-model-switch-picker'));
    const fast = normalize(switchFixture('post-model-switch-fast-on'));
    expect(picker?.conversationId).toBe(fast?.conversationId);
    expect(picker?.detail).not.toBe(fast?.detail);
    // Two deliveries of ONE switch carry the same subtype and still collapse.
    expect(normalize(switchFixture('post-model-switch-fast-on'))?.detail).toBe(fast?.detail);
  });

  it('keeps the model when the caller already resolved the event word (relay path)', () => {
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: switchFixture('post-model-switch-command'),
      event: 'notification',
      receivedAt: 1,
    });
    expect(normalized?.event).toBe('notification');
    expect(normalized?.model).toBe('claude-sonnet-5');
  });
});

// =============================================================================
// from_model / requested_model are never the model
// =============================================================================

describe('from_model is never read as the model (逆走させない)', () => {
  it('a switch with from_model but no to_model names no model', () => {
    const payload = { ...switchFixture('post-model-switch-command') };
    delete payload.to_model;
    const normalized = normalize(payload);
    expect(normalized?.event).toBe('notification');
    // The bare word: no target to append, and none borrowed from `from_model`.
    expect(normalized?.detail).toBe(MODEL_SWITCH_DETAIL);
    // Null, not `from_model`: the latch is left alone rather than moved back.
    expect(normalized?.model).toBeNull();
    expect(extractClaudeSwitchedModel(payload)).toBeNull();
  });

  it('with both present, to_model wins regardless of key order', () => {
    const forward = { hook_event_name: 'PostModelSwitch', to_model: 'b', from_model: 'a' };
    const backward = { hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'b' };
    expect(normalize(forward)?.model).toBe('b');
    expect(normalize(backward)?.model).toBe('b');
  });

  it('requested_model is not a fallback — it is null on `/model default` and `/fast`', () => {
    expect(switchFixture('post-model-switch-default').requested_model).toBeNull();
    expect(switchFixture('post-model-switch-fast-on').requested_model).toBeNull();
    const payload = {
      hook_event_name: 'PostModelSwitch',
      from_model: 'claude-haiku-4-5-20251001',
      requested_model: 'sonnet',
    };
    expect(normalize(payload)?.model).toBeNull();
  });

  it('a non-string or empty to_model is no model', () => {
    for (const to_model of ['', 42, null, { id: 'x' }, ['claude-sonnet-5']]) {
      const payload = { hook_event_name: 'PostModelSwitch', from_model: 'a', to_model };
      expect(normalize(payload)?.model, JSON.stringify(to_model)).toBeNull();
    }
  });

  it('a `model` key on the switch does not out-rank to_model', () => {
    // No measured payload carries one, but a future build might, and it could
    // as easily be the previous model as the next. `extractModel` runs first.
    const payload = {
      hook_event_name: 'PostModelSwitch',
      model: 'claude-haiku-4-5-20251001',
      from_model: 'claude-haiku-4-5-20251001',
      to_model: 'claude-sonnet-5',
    };
    expect(normalize(payload)?.model).toBe('claude-sonnet-5');
  });

  it('bounds an over-long to_model like every other model value, and the subtype with it', () => {
    const long = 'x'.repeat(MAX_EVENT_DETAIL_LENGTH + 40);
    const normalized = normalize({ hook_event_name: 'PostModelSwitch', to_model: long });
    expect(normalized?.model).toHaveLength(MAX_EVENT_DETAIL_LENGTH);
    expect(normalized?.detail).toHaveLength(MAX_EVENT_DETAIL_LENGTH);
    expect(normalized?.detail?.startsWith('model_switch:')).toBe(true);
  });
});

// =============================================================================
// PreModelSwitch stays unknown
// =============================================================================

describe('PreModelSwitch maps to nothing', () => {
  it.each(['pre-model-switch-fast-on-first', 'pre-model-switch-fast-on-second'])(
    '%s is refused and tallied',
    (name) => {
      const payload = switchFixture(name);
      expect(payload.hook_event_name).toBe('PreModelSwitch');
      expect(normalize(payload)).toBeNull();
      expect(getUnknownEventTally('claude')).toEqual({ count: 1, names: ['PreModelSwitch'] });
    }
  );

  it('the two Pre captures of one `/fast` disagree with each other, which is why', () => {
    const first = switchFixture('pre-model-switch-fast-on-first');
    const second = switchFixture('pre-model-switch-fast-on-second');
    expect(first.prompt_id).toBe(second.prompt_id);
    expect(first.from_model).toBe('claude-haiku-4-5-20251001');
    expect(second.from_model).toBe('claude-sonnet-5');
    // Neither is read as a model, whichever field it were taken from.
    expect(extractClaudeSwitchedModel(first)).toBeNull();
    expect(extractClaudeSwitchedModel(second)).toBeNull();
  });
});

// =============================================================================
// The rule and the extractor, in isolation
// =============================================================================

describe('the pieces the source is assembled from', () => {
  it('the mapper answers only for PostModelSwitch', () => {
    expect(claudeModelSwitchMapper('PostModelSwitch', {})).toEqual({
      event: 'notification',
      detail: MODEL_SWITCH_DETAIL,
    });
    expect(claudeModelSwitchMapper('PostModelSwitch', { to_model: 'claude-sonnet-5' })).toEqual({
      event: 'notification',
      detail: 'model_switch:claude-sonnet-5',
    });
    // The subtype's target is `to_model`, never `from_model`.
    expect(claudeModelSwitchMapper('PostModelSwitch', { from_model: 'a' })?.detail).toBe(
      MODEL_SWITCH_DETAIL
    );
    for (const name of ['PreModelSwitch', 'Notification', 'Stop', 'postmodelswitch', null]) {
      expect(claudeModelSwitchMapper(name, {}), String(name)).toBeNull();
    }
  });

  it('the extractor answers only for a PostModelSwitch payload', () => {
    expect(isClaudeModelSwitchPayload({ hook_event_name: 'PostModelSwitch' })).toBe(true);
    expect(isClaudeModelSwitchPayload({ hook_event_name: 'PreModelSwitch' })).toBe(false);
    expect(isClaudeModelSwitchPayload({})).toBe(false);
    // A `to_model` on any other event is not this tool's model.
    expect(extractClaudeSwitchedModel({ hook_event_name: 'Stop', to_model: 'x' })).toBeNull();
    expect(extractClaudeSwitchedModel({ to_model: 'x' })).toBeNull();
  });
});

// =============================================================================
// Nothing else moved
// =============================================================================

describe('every event the source already read is read as before', () => {
  it('SessionStart still carries `model`, in the same spelling as to_model', () => {
    const normalized = normalize(fixture('claude', 'session-start'));
    expect(normalized?.event).toBe('session_start');
    expect(normalized?.detail).toBe('startup');
    expect(normalized?.model).toBe('claude-opus-5[1m]');
    expect(normalize(switchFixture('session-start-after-switches'))?.model).toBe(
      'claude-opus-5[1m]'
    );
  });

  it.each([
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['stop', 'stop', null],
    ['notification-permission-prompt', 'notification', 'permission_prompt'],
    ['notification-idle-prompt', 'notification', 'idle_prompt'],
    ['pre-tool-use-ask-user-question', 'pre_tool_use', 'AskUserQuestion'],
    ['post-tool-use-ask-user-question', 'post_tool_use', 'AskUserQuestion'],
    ['session-end', 'session_end', 'prompt_input_exit'],
    ['session-end-clear', 'session_end', 'clear'],
    ['session-start-clear', 'session_start', 'clear'],
  ])('%s → %s / %s with no model', (name, event, detail) => {
    const normalized = normalize(fixture('claude', name));
    expect(normalized?.event).toBe(event);
    expect(normalized?.detail).toBe(detail);
    expect(normalized?.model).toBeNull();
  });

  it('PermissionRequest is still refused as a lifecycle event', () => {
    expect(normalize(fixture('claude', 'permission-request'))).toBeNull();
  });
});
