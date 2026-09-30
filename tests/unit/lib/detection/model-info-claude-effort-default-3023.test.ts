/**
 * Issue #3023: a Claude session reported `reasoningEffort: medium` while
 * `~/.claude/settings.json` said `effortLevel: xhigh`.
 *
 * Measured on claude 2.1.285 (`tests/fixtures/claude-effort-default-3023/`, and
 * that directory's README): the session really does run at `medium`. A
 * top-level `effortLevel` in the user settings file is a legacy value claude
 * applies only to pre-5.5 models, so Opus 5.5 falls back to its own default.
 * The frame reader was right; these live frames pin that it stays right — the
 * default-effort banner reads its effort off the `/effort` row, the non-default
 * banner carries `with <effort> effort` again, and a frame without either
 * reads the effort as unknown rather than guessing one.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractModelInfo, type ModelInfo } from '@/lib/detection/model-info-extractor';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/claude-effort-default-3023');

const frame = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

const LIVE_FRAMES: ReadonlyArray<readonly [name: string, expected: ModelInfo, why: string]> = [
  [
    'plain-startup-2.1.285',
    { model: 'Opus 5.5', effort: 'medium' },
    'the model default: no effort clause on the banner, `◐ medium · /effort` on its own row',
  ],
  [
    'xhigh-startup-2.1.285',
    { model: 'Opus 5.5', effort: 'xhigh' },
    'a non-default effort: `Opus 5.5 with xhigh effort · Claude Max`',
  ],
  [
    'plain-after-turn-2.1.285',
    { model: 'Opus 5.5', effort: null },
    'after the first turn the effort row is gone, so the effort is unknown',
  ],
];

describe('extractModelInfo: claude 2.1.285 effort frames (Issue #3023)', () => {
  it.each(LIVE_FRAMES)('%s', (name, expected) => {
    expect(extractModelInfo('claude', frame(name))).toEqual(expected);
  });

  it('has a row for every frame in the fixture directory', () => {
    const files = fs
      .readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith('.txt'))
      .map((file) => file.replace(/\.txt$/, ''))
      .sort();
    expect(files).toEqual(LIVE_FRAMES.map(([name]) => name).sort());
  });
});
