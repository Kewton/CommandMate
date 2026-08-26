/**
 * opencode's `variant` becomes the reasoning effort every surface shows (#2048).
 *
 * Issue #1784 built the effort display on a premise that was true when it was
 * written: "no hook payload of any tool carries an effort field", so the value
 * could only ever be scraped off a TUI's chrome. opencode breaks that premise
 * from the other end — its pane still prints no effort anywhere (re-measured on
 * 1.18.22, §20.4), but its **event stream** publishes one under the name
 * `variant`, on `Session.model.variant` and on `message.updated.info.variant`.
 *
 * So there is now a third source, it outranks the other two, and the three
 * things this file guards are:
 *
 *  1. the agent's own word wins over the screen and over antigravity's
 *     id-derived level;
 *  2. every other tool's answer is byte-identical to pre-#2048, which is what
 *     makes "claude / codex のスナップショットが不変" a property of the code;
 *  3. the latch never clears on a frame that simply does not mention a variant —
 *     which is most frames, including the assistant message a turn opens with.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mergeModelInfo } from '@/lib/detection/model-info-extractor';
import {
  beginAgentEventGeneration,
  discardAgentEventState,
  getLastReportedAgentEffort,
  getResolvedAgentModelInfo,
  recordAgentReportedEffort,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';

const WT = 'wt-2048-effort';

describe('mergeModelInfo with the agent-reported effort (Issue #2048)', () => {
  it('prefers the agent s own word over the scraped footer', () => {
    expect(
      mergeModelInfo('opencode', 'claude-sonnet-4.6', { model: null, effort: 'low' }, 'high')
    ).toEqual({ model: 'claude-sonnet-4.6', effort: 'high' });
  });

  it('outranks antigravity s id-derived level — a stated value is not an inferred one', () => {
    expect(
      mergeModelInfo('antigravity', 'gemini-3.7-flash-low', { model: null, effort: null }, 'max')
        .effort
    ).toBe('max');
  });

  it('falls through to the old precedence when the agent said nothing', () => {
    expect(
      mergeModelInfo('codex', 'gpt-5.6-sol', { model: null, effort: 'xhigh' }, null).effort
    ).toBe('xhigh');
    expect(
      mergeModelInfo('antigravity', 'gemini-3.7-flash-high', { model: null, effort: null }).effort
    ).toBe('high');
  });

  it('is byte-identical to the three-argument call for every tool that reports none', () => {
    for (const tool of ['claude', 'codex', 'gemini', 'copilot', 'antigravity'] as const) {
      const captured = { model: 'scraped', effort: 'medium' };
      expect(mergeModelInfo(tool, 'hooked', captured, null)).toEqual(
        mergeModelInfo(tool, 'hooked', captured)
      );
    }
  });

  it('treats an empty string as "the agent said nothing"', () => {
    expect(mergeModelInfo('opencode', 'm', { model: null, effort: 'low' }, '').effort).toBe('low');
  });
});

describe('the agent-reported effort latch (Issue #2048)', () => {
  beforeEach(() => {
    discardAgentEventState(WT, 'opencode', 'opencode');
    discardAgentEventState(WT, 'codex', 'codex');
  });

  it('is null until a frame reports one', () => {
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode')).toBeNull();
  });

  it('latches, and a frame with no variant does NOT clear it', () => {
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    recordAgentReportedEffort(WT, 'opencode', 'opencode', null);
    recordAgentReportedEffort(WT, 'opencode', 'opencode', '');
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode')).toBe('high');
  });

  it('is replaced by a later frame that names a different variant', () => {
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'max');
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode')).toBe('max');
  });

  it('reaches the resolved model info the whole UI reads', () => {
    recordCapturedModelInfo(WT, 'opencode', 'opencode', {
      model: 'Claude Sonnet 4.6',
      effort: null,
    });
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    expect(getResolvedAgentModelInfo(WT, 'opencode', 'opencode')).toEqual({
      model: 'Claude Sonnet 4.6',
      effort: 'high',
    });
  });

  it('is dropped on a new generation — the relaunched pane may carry none', () => {
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    beginAgentEventGeneration(WT, 'opencode', 'opencode');
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode')).toBeNull();
  });

  it('is dropped with the session it described', () => {
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    discardAgentEventState(WT, 'opencode', 'opencode');
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode')).toBeNull();
  });

  it('keys on the instance — two opencode panes do not share a variant', () => {
    recordAgentReportedEffort(WT, 'opencode', 'opencode', 'high');
    expect(getLastReportedAgentEffort(WT, 'opencode', 'opencode-2')).toBeNull();
  });

  it('leaves a tool that reports nothing exactly where #1784 left it', () => {
    recordCapturedModelInfo(WT, 'codex', 'codex', { model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });
});
