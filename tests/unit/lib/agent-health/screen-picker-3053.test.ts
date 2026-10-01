/**
 * Issue #3053: the `screen-picker` expectation and the settings comparison
 * around it.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { describePickerSettingsChanges, readPickerSettings } from '@/lib/agent-health/picker-settings';
import {
  describeVerdict,
  evaluatePickerScreens,
  evaluateScreen,
  type PickerScreenResult,
  type ScreenVerdict,
} from '@/lib/agent-health/screen-checks';
import { AGENT_HEALTH_CHECK_IDS } from '@/lib/agent-health/types';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'agent-health-picker-3053');

const picker = (overrides: Partial<ScreenVerdict>): ScreenVerdict => ({
  status: 'waiting',
  reason: 'claude_selection_list',
  hasActivePrompt: false,
  evidence: 'positive',
  isPrompt: false,
  ...overrides,
});

const screen = (overrides: Partial<PickerScreenResult>): PickerScreenResult => ({
  screen: '/model',
  opened: true,
  verdict: picker({}),
  frame: 'Select model\nEnter to set as default · Esc to cancel',
  closed: true,
  ...overrides,
});

/** What the probe reads off a frame: the status verdict plus `detectPrompt`. */
function judge(file: string, tool: CLIToolType): ScreenVerdict {
  const frame = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const result = detectSessionStatus(frame, tool);
  return {
    status: result.status,
    reason: result.reason,
    hasActivePrompt: result.hasActivePrompt,
    evidence: result.evidence,
    isPrompt: detectPrompt(stripBoxDrawing(stripAnsi(frame)), buildDetectPromptOptions(tool)).isPrompt,
  };
}

describe('screen-picker in the check list', () => {
  it('runs right after screen-idle, before the turns', () => {
    const ids = [...AGENT_HEALTH_CHECK_IDS];
    expect(ids.indexOf('screen-picker')).toBe(ids.indexOf('screen-idle') + 1);
    expect(ids.indexOf('screen-picker')).toBeLessThan(ids.indexOf('screen-running'));
  });
});

describe('evaluateScreen(screen-picker)', () => {
  it('passes a selection list that Auto-Yes does not read as a prompt', () => {
    expect(evaluateScreen('screen-picker', picker({}), 'x').status).toBe('pass');
    expect(evaluateScreen('screen-picker', picker({ reason: 'codex_selection_list' }), 'x').status).toBe('pass');
  });

  it.each([
    ['running / default (#3052)', { status: 'running', reason: 'default', evidence: 'none' }],
    ['ready / input_prompt', { status: 'ready', reason: 'input_prompt' }],
    ['waiting on a reason outside SELECTION_LIST_REASONS', { reason: 'prompt_detected' }],
    ['an active prompt', { hasActivePrompt: true }],
    ['detectPrompt reads it as a prompt', { isPrompt: true }],
    ['detectPrompt not consulted', { isPrompt: undefined }],
  ] as const)('fails on %s', (_label, overrides) => {
    const verdict = evaluateScreen('screen-picker', picker(overrides as Partial<ScreenVerdict>), 'pane tail');
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence).toContain('pane tail');
  });

  it('names isPrompt only when it was read', () => {
    expect(describeVerdict(picker({ isPrompt: true }))).toContain('isPrompt=true');
    expect(describeVerdict(picker({ isPrompt: undefined }))).not.toContain('isPrompt');
  });
});

describe('evaluatePickerScreens', () => {
  it('passes when every screen holds, listing each one', () => {
    const verdict = evaluatePickerScreens([screen({}), screen({ screen: '/effort' })]);
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toContain('/model: 合格');
    expect(verdict.summary).toContain('/effort: 合格');
    expect(verdict.evidence).toBeUndefined();
  });

  it('fails on one miss, with only the missed screen as evidence', () => {
    const verdict = evaluatePickerScreens([
      screen({ frame: 'MODEL FRAME' }),
      screen({
        screen: '/effort',
        verdict: picker({ status: 'running', reason: 'default', evidence: 'none' }),
        frame: 'Faster    Smarter\n←/→ to adjust · Enter to confirm · Esc to cancel',
      }),
    ]);
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('/model: 合格');
    expect(verdict.summary).toContain('/effort: 不合格（status=running reason=default');
    expect(verdict.evidence).toContain('── /effort');
    expect(verdict.evidence).toContain('Faster    Smarter');
    expect(verdict.evidence).not.toContain('MODEL FRAME');
  });

  it('fails a picker that never opened, saying so', () => {
    const verdict = evaluatePickerScreens([screen({ opened: false, verdict: null, frame: '❯ /model' })]);
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('画面が開いたことを確認できなかった');
    expect(verdict.evidence).toContain('❯ /model');
  });

  it('fails a picker Esc did not close', () => {
    const verdict = evaluatePickerScreens([screen({ closed: false })]);
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('Esc の後に入力待ちに戻らなかった');
  });

  it('fails when nothing was opened at all', () => {
    expect(evaluatePickerScreens([]).status).toBe('fail');
  });
});

describe('the measured pickers (tests/fixtures/agent-health-picker-3053)', () => {
  it('claude 2.1.286 /model passes', () => {
    const verdict = judge('claude-model.txt', 'claude');
    expect(evaluateScreen('screen-picker', verdict, '').status).toBe('pass');
  });

  it('codex 0.159.3 /model reads as its selection list', () => {
    const verdict = judge('codex-model.txt', 'codex');
    expect(verdict).toMatchObject({ status: 'waiting', reason: 'codex_selection_list', hasActivePrompt: false });
  });
});

describe('readPickerSettings', () => {
  it('reads the watched keys of claude settings.json', () => {
    const text = JSON.stringify({ model: 'opus', effortLevel: 'high', hooks: {} });
    expect(readPickerSettings(text, 'json', ['model', 'effortLevel'])).toEqual({ model: 'opus', effortLevel: 'high' });
  });

  it('absent keys, a missing file and broken JSON are null', () => {
    expect(readPickerSettings('{"model":"opus"}', 'json', ['model', 'effortLevel'])).toEqual({
      model: 'opus',
      effortLevel: null,
    });
    expect(readPickerSettings(null, 'json', ['model'])).toEqual({ model: null });
    expect(readPickerSettings('{ not json', 'json', ['model'])).toEqual({ model: null });
  });

  it('reads codex config.toml top-level keys only', () => {
    const text = [
      '# user config',
      'model = "gpt-6-sol"',
      "model_reasoning_effort = 'high' # comment",
      '',
      '[profiles.fast]',
      'model = "gpt-6-luna"',
      'model_reasoning_effort = "low"',
    ].join('\n');
    expect(readPickerSettings(text, 'toml', ['model', 'model_reasoning_effort'])).toEqual({
      model: 'gpt-6-sol',
      model_reasoning_effort: 'high',
    });
    expect(readPickerSettings('[projects."/x"]\nmodel = "a"\n', 'toml', ['model'])).toEqual({ model: null });
  });
});

describe('describePickerSettingsChanges', () => {
  it('is empty when nothing changed', () => {
    expect(describePickerSettingsChanges({ model: 'opus', effortLevel: null }, { model: 'opus', effortLevel: null })).toEqual(
      []
    );
  });

  it('names every changed key, including added and removed ones', () => {
    expect(
      describePickerSettingsChanges(
        { model: 'opus', effortLevel: null, x: 'gone' },
        { model: 'haiku', effortLevel: 'max', x: null }
      )
    ).toEqual(['model: "opus" → "haiku"', 'effortLevel: （無し） → "max"', 'x: "gone" → （無し）']);
  });
});
