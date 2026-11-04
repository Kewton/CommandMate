/**
 * Issue #4146: a stamp names the build whose screen set was re-captured and read.
 * The newer builds in the fixtures hold part of a set, so the stamps stay. When a
 * set is captured this fails, and the stamp and the comment in
 * `verified-against.ts` are to be moved together.
 *
 * @vitest-environment node
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_VERIFIED_AGAINST,
  CODEX_VERIFIED_AGAINST,
  DETECTOR_VERIFIED_AGAINST,
  OPENCODE_VERIFIED_AGAINST,
  UNMEASURED_VERIFIED_AGAINST,
} from '@/lib/detection/tools/verified-against';

const files = (dir: string): string[] =>
  readdirSync(resolve(__dirname, '../../../fixtures', dir)).filter((name) => name.endsWith('.txt'));

describe('stamps held back from partial captures', () => {
  it('codex stays on 0.157.1: the 0.166.0 frames have no approval, picker or running turn', () => {
    expect(CODEX_VERIFIED_AGAINST.version).toBe('0.157.1');
    expect(files('codex-dialogs-0166').sort()).toEqual([
      'hooks-detail-trusted.txt',
      'hooks-detail.txt',
      'hooks-list-trusted.txt',
      'hooks-list.txt',
      'hooks-review-cursor-2.txt',
      'hooks-review.txt',
      'ready.txt',
      'trust.txt',
      'update.txt',
    ]);
  });

  it('opencode stays on 1.18.22: the 1.18.35 frames are finished turns only', () => {
    expect(OPENCODE_VERIFIED_AGAINST.version).toBe('1.18.22');
    expect(files('opencode-live-4134').sort()).toEqual([
      'turn-done-subsecond-local-model.txt',
      'turn-done-subsecond.txt',
    ]);
  });

  it('claude stays on 2.1.240: the 2.1.318 frames are one dialog', () => {
    expect(CLAUDE_VERIFIED_AGAINST.version).toBe('2.1.240');
    expect(files('claude-auto-default-nudge-4134').sort()).toEqual(['cursor-no.txt', 'cursor-yes.txt']);
  });

  it('gemini and vibe-local stay unmeasured', () => {
    expect(DETECTOR_VERIFIED_AGAINST.gemini).toBe(UNMEASURED_VERIFIED_AGAINST);
    expect(DETECTOR_VERIFIED_AGAINST['vibe-local']).toBe(UNMEASURED_VERIFIED_AGAINST);
  });
});
