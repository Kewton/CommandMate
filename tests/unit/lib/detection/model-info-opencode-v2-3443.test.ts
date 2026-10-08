/**
 * Issue #3443: opencode2 (opencode-v2) draws its step row without `▣`
 * (`     Build · Mistral Large 4 · 253ms`), so `extractModelInfo` read no model
 * off its pane — and had no `opencode-v2` case at all.
 *
 * The positive frames are the raw captures the daily probe recorded on
 * opencode2 2.0.18 (`tests/fixtures/opencode-agent-health-3420/`). Only the
 * negative cases are hand-written.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import { OPENCODE_V2_STEP_MODEL_PATTERN, extractModelInfo } from '@/lib/detection/model-info-extractor';

const UNKNOWN = { model: null, effort: null };
const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const frame = (dir: string, file: string): string => fs.readFileSync(path.join(FIXTURES, dir, file), 'utf-8');

describe('extractModelInfo: opencode2 step row without `▣` (Issue #3443)', () => {
  it.each([
    'unauthorized-running-turn.txt',
    'unauthorized-quoted-turn.txt',
    'unauthorized-quoted-after-running-turn.txt',
  ])('reads the model off the real 2.0.18 frame %s', (name) => {
    const capture = frame('opencode-agent-health-3420', name);
    expect(extractModelInfo('opencode-v2', capture)).toEqual({ model: 'Mistral Large 4', effort: null });
    // The tool id `opencode` may run a 2.x binary: it reads the same row.
    expect(extractModelInfo('opencode', capture)).toEqual({ model: 'Mistral Large 4', effort: null });
  });

  it('reads the lowest step row when two turns ran on different models', () => {
    const capture = [
      '  ┃  first',
      '     Build · Model A · 253ms',
      '  ┃  second',
      '     Plan · Model B · 1.2s',
      '  ┃',
      '  ┃  Plan · Model B Ollama Cloud',
    ].join('\n');
    expect(extractModelInfo('opencode-v2', capture)).toEqual({ model: 'Model B', effort: null });
  });

  it('opencode v1 frames (`▣` rows) read the same through the opencode-v2 id', () => {
    for (const name of ['running-turn-sleep.txt', 'quoted-dialog-reply-done.txt']) {
      expect(extractModelInfo('opencode-v2', frame('opencode-agent-health-3021', name))).toEqual({
        model: 'Claude Sonnet 5.5',
        effort: null,
      });
    }
  });

  it('a frame with no step row yet answers unknown; the composer bar is not read', () => {
    const capture = frame('opencode-agent-health-3420', 'unauthorized-running-turn.txt')
      .split('\n')
      .filter((line) => !/·\s+\d+ms\s*$/.test(stripAnsi(line)))
      .join('\n');
    expect(extractModelInfo('opencode-v2', capture)).toEqual(UNKNOWN);
  });

  describe('negative controls', () => {
    it('the error row and the user input are not read', () => {
      const capture = [
        '  ┃',
        '  ┃  Build · Fake Model · 3s',
        '  ┃',
        '     Error: Unauthorized',
        '  ┃',
        '  ┃  Build · Mistral Large 4 Ollama Cloud',
      ].join('\n');
      expect(extractModelInfo('opencode-v2', capture)).toEqual(UNKNOWN);
    });

    it('shell output inside the `┃` block is not read', () => {
      const capture = [
        '  ┃  $ ./bench',
        '  ┃  Build · Release Target · 512ms',
        '  ┃',
        '  ┃  Build · Mistral Large 4 Ollama Cloud',
      ].join('\n');
      expect(extractModelInfo('opencode-v2', capture)).toEqual(UNKNOWN);
    });

    it('a reply line with the shape, followed by more reply, is not read', () => {
      const capture = [
        '  ┃  summarise the build log',
        '     Stage · Compile Assets · 840ms',
        '     The compile stage took under a second.',
        '  ┃',
        '  ┃  Build · Mistral Large 4 Ollama Cloud',
      ].join('\n');
      expect(extractModelInfo('opencode-v2', capture)).toEqual(UNKNOWN);
    });

    it('rows without a duration, or with a label that is not a model, are not read', () => {
      for (const line of [
        '     Build · Mistral Large 4',
        '     Thought · 2ms',
        '     + Thought: Structuring a haiku · 870ms',
        '  ┃  Build · Mistral Large 4 Ollama Cloud',
        '     Error: Unauthorized',
      ]) {
        expect(OPENCODE_V2_STEP_MODEL_PATTERN.test(line), line).toBe(false);
      }
      const capture = ['     Build · <script>? · 3s', '  ┃'].join('\n');
      expect(extractModelInfo('opencode-v2', capture)).toEqual(UNKNOWN);
    });

    it('a step-shaped row at the bottom with nothing below it is not read', () => {
      expect(extractModelInfo('opencode-v2', '     Build · Mistral Large 4 · 253ms\n\n')).toEqual(UNKNOWN);
    });
  });
});
