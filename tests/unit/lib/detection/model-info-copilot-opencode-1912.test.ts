/**
 * Issue #1912 item 4: model / effort for copilot and opencode.
 *
 * Every capture here is one of the raw live frames #1885 / #1893 / #1895 / #1896
 * recorded (copilot 1.0.80, opencode 1.18.20 / 1.18.21, both at the production
 * 200x1000 geometry). Nothing was re-captured for this Issue and nothing is
 * hand-written except the negative cases, which is the point: the spellings
 * under test are the ones a real pane produces.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COPILOT_MODEL_CHANGE_PATTERN,
  OPENCODE_STEP_MODEL_PATTERN,
  extractModelInfo,
} from '@/lib/detection/model-info-extractor';

const UNKNOWN = { model: null, effort: null };

const frame = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

// =============================================================================
// copilot
// =============================================================================

describe('extractModelInfo: copilot status bar (Issue #1912)', () => {
  it.each([
    ['copilot-live-1885/boot-idle.txt', 'GPT-5.6 Terra'],
    ['copilot-live-1885/turn-complete.txt', 'GPT-5.6 Terra'],
    // The bar's other rendering: ` ● Working esc interrupt … GPT-5.6 Terra`.
    ['copilot-live-1885/turn-running-early.txt', 'GPT-5.6 Terra'],
    ['copilot-live-1885/turn-running-thinking.txt', 'GPT-5.6 Terra'],
  ])('reads the model off %s', (name, model) => {
    expect(extractModelInfo('copilot', frame(name))).toEqual({ model, effort: null });
  });

  it('reads `<model> · <Effort>` when the bar carries an effort', () => {
    // The Issue text says the bar reads `<model> (effort)`. It does not: the
    // parenthesised form is the transcript notice. Measured bar, 1s after
    // `/model gpt-5-mini`: `… tab next tab            GPT-5 mini · Medium`.
    expect(extractModelInfo('copilot', frame('copilot-picker-1895/model-arg-immediate.txt')))
      .toEqual({ model: 'GPT-5 mini', effort: 'medium' });
  });

  it('does not read copilot repeating its own status vocabulary as body text', () => {
    // The transcript of this frame contains ` ● Working esc interrupt` as a
    // REPLY (#1885's false-positive fixture). The bar is still the bottom row.
    expect(extractModelInfo('copilot', frame('copilot-live-1885/status-vocabulary-in-response.txt')))
      .toEqual({ model: 'GPT-5.6 Terra', effort: null });
  });

  it('does not read a user prompt that quotes the bar vocabulary', () => {
    // `model-picker.txt` echoes a prompt 930 rows above the bar that ends
    // `… the text  open     03:00`. A frame-wide scan published `03:00` as the
    // model; reading the bottom row only is what stops it — and the /model
    // picker hides the bar, so unknown is the right answer for this frame.
    expect(extractModelInfo('copilot', frame('copilot-live-1885/model-picker.txt'))).toEqual(UNKNOWN);
  });

  it.each([
    'copilot-live-1885/permission-dialog.txt',
    'copilot-picker-1895/picker-skills.txt',
    'copilot-picker-1895/picker-theme.txt',
    'copilot-picker-1895/picker-statusline.txt',
  ])('stays quiet while %s covers the bar', (name) => {
    // A picker or a permission dialog is drawn INSTEAD of copilot's bottom five
    // rows (#1895), so the bar is genuinely not on screen. `picker-statusline`
    // is the trap: its boxed preview contains `Agent · GPT-5.4`.
    expect(extractModelInfo('copilot', frame(name))).toEqual(UNKNOWN);
  });

  it('takes the effort from the switch notice when the bar names the same model', () => {
    // Bar `GPT-5 mini`, notice `gpt-5-mini (medium)` — one model, two renderings.
    expect(
      extractModelInfo('copilot', frame('copilot-picker-1895/picker-vocabulary-in-response.txt')),
    ).toEqual({ model: 'GPT-5 mini', effort: 'medium' });
  });

  it('ignores a switch notice that names a different model than the bar', () => {
    const capture = [
      ' ● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this session.',
      ' ← open sidebar · / commands · ? help · tab next tab                    Claude Sonnet 5',
    ].join('\n');
    expect(extractModelInfo('copilot', capture)).toEqual({
      model: 'Claude Sonnet 5',
      effort: null,
    });
  });

  it('falls back to the switch notice when no bar is on screen', () => {
    const capture = ' ● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this session. Use /config to set default';
    expect(extractModelInfo('copilot', capture)).toEqual({
      model: 'gpt-5-mini',
      effort: 'medium',
    });
  });

  it('rejects a bar whose right-hand cell is not a plausible model', () => {
    for (const cell of ['—', '?? ??', '·']) {
      const capture = ` ← open sidebar · / commands · ? help · tab next tab          ${cell}`;
      expect(extractModelInfo('copilot', capture), cell).toEqual(UNKNOWN);
    }
  });

  it('rejects a bar whose trailing token is not a known effort', () => {
    // `50% left` would be published as an effort by a positional read.
    const capture = ' ← open sidebar · / commands · ? help · tab next tab          GPT-5 mini · 50% left';
    expect(extractModelInfo('copilot', capture)).toEqual(UNKNOWN);
  });

  it('requires the whole switch sentence, bullet included', () => {
    for (const line of [
      'Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this session.',
      ' ❯ Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this session.',
      ' ● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) permanently.',
    ]) {
      expect(COPILOT_MODEL_CHANGE_PATTERN.test(line), line).toBe(false);
    }
  });
});

// =============================================================================
// opencode
// =============================================================================

describe('extractModelInfo: opencode step marker (Issue #1912)', () => {
  it.each([
    'opencode-live-1883/turn-complete.txt',
    'opencode-live-1883/turn-running.txt',
    'opencode-live-1883/phrase-in-response.txt',
    'opencode-live-1893/permission-bash.txt',
    'opencode-live-1893/turn-aborted-no-duration.txt',
    'opencode-live-1896/numbered-answer.txt',
    'opencode-live-1896/model-picker.txt',
  ])('reads the model off %s', (name) => {
    // opencode prints no reasoning effort anywhere on the pane, in any live
    // frame — the null is a measurement, not a hole in the reader.
    expect(extractModelInfo('opencode', frame(name))).toEqual({
      model: 'GPT-5.6 Luna',
      effort: null,
    });
  });

  it.each([
    'opencode-live-1883/boot-idle.txt',
    'opencode-live-1883/composer-residual.txt',
    'opencode-live-1896/composer-typed-numbered.txt',
  ])('answers unknown for %s, which has finished no step yet', (name) => {
    // The footer model bar IS on these frames (`┃  Build · GPT-5.6 Luna GitHub
    // Copilot`), and it is deliberately not read: after stripAnsi the model and
    // the provider are one blob separated by a single space, and opencode's
    // provider vocabulary is whatever the user configured.
    expect(extractModelInfo('opencode', frame(name))).toEqual(UNKNOWN);
  });

  it('does not glue the provider onto the model from the footer bar', () => {
    const capture = '  ┃  Build · GPT-5.6 Luna GitHub Copilot                    ';
    expect(extractModelInfo('opencode', capture)).toEqual(UNKNOWN);
  });

  it('accepts the step marker with and without a duration', () => {
    expect(OPENCODE_STEP_MODEL_PATTERN.exec('     ▣  Build · GPT-5.6 Luna · 3.1s')?.[1]).toBe(
      'GPT-5.6 Luna',
    );
    expect(OPENCODE_STEP_MODEL_PATTERN.exec('     ▣  Plan · Claude Sonnet 5')?.[1]).toBe(
      'Claude Sonnet 5',
    );
  });

  it('does not read the transcript rows that share the shape', () => {
    for (const line of [
      '     + Thought: Structuring a haiku · 870ms',
      '     Thought · 2ms',
      '  ┃  Build · GPT-5.6 Luna GitHub Copilot',
      '            ● GPT-5.6 Luna GitHub Copilot',
    ]) {
      expect(OPENCODE_STEP_MODEL_PATTERN.test(line), line).toBe(false);
    }
  });
});
