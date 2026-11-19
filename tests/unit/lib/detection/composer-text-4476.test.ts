/** @vitest-environment node */

/**
 * Issue #4476: the readers agree with what the Issue's frames hold (pinned, not a fix).
 *
 * Stage 1 of the Issue reproduced both frames on the production build (47a03b7c0)
 * and on develop: the dim `Try "…"` hint is an EMPTY composer for the clear, and
 * `[Pasted text #1 +26 lines]` is a composer HOLDING the body for the send. The
 * 12-pass `composer-not-empty` of the Issue held the starting message itself. So
 * these tests fix today's readings in place (they are green before and after the
 * #4476 change), with a real residual as the negative control the #1880 refusal
 * still stands on (I3).
 *
 * Frames: `tests/fixtures/claude-first-send-4476/` (see its README).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  clearComposerPasteToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { capturePane, clearComposerLine } from '@/lib/tmux/tmux';
import { extractComposerText, extractLiveComposerText } from '@/lib/detection/composer-text';
import { PASTED_TEXT_PATTERN } from '@/lib/detection/shared/pasted-text';
import { clearComposer, readClearComposer, MAX_COMPOSER_CLEAR_PASSES } from '@/lib/session/composer-clear';
import { classifyPasteLanded, classifySubmitWithRule } from '@/lib/cli-tools/submit-composer-read';
import { resolveComposerSpec } from '@/lib/cli-tools/composer-spec';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/claude-first-send-4476');
const GHOST = readFileSync(path.join(FIXTURES, 'ghost-try-logging.ansi'), 'utf8');
const PASTED = readFileSync(path.join(FIXTURES, 'pasted-26-lines.capture'), 'utf8');

/** The Issue's composer row, byte for byte. */
const ISSUE_ROW = '\x1b[39m❯ \x1b[2mTry "create a util logging.py that…"\x1b[0m';
/** The same row with the hint as plain (not dim) text: what a real residual looks like. */
const RESIDUAL = GHOST.replace(ISSUE_ROW, '\x1b[39m❯ セッションの起動とモデルの確認です。');
/** A 27-line body (26 newlines), the shape of the Issue comment's 4567-byte brief. */
const BODY_27_LINES = Array.from({ length: 27 }, (_, i) => `L${String(i).padStart(2, '0')} ${'x'.repeat(160)}`).join('\n');

const noDelay = async (): Promise<void> => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#4476] the fixtures are what the Issue reports', () => {
  it('the ghost frame carries the Issue row with its dim attribute intact', () => {
    expect(GHOST.split('\n')).toContain(ISSUE_ROW);
    expect(RESIDUAL).not.toBe(GHOST);
  });

  it('the paste frame carries the placeholder of the comment', () => {
    expect(PASTED).toContain('[Pasted text #1 +26 lines]');
    expect(PASTED_TEXT_PATTERN.test(PASTED)).toBe(true);
    expect(BODY_27_LINES.split('\n')).toHaveLength(27);
  });
});

describe('[#4476] the dim Try hint is an empty composer (I4)', () => {
  it('extractComposerText / extractLiveComposerText / readClearComposer read ghost', () => {
    expect(extractComposerText(GHOST, 'claude')).toEqual({ text: '', state: 'ghost' });
    expect(extractLiveComposerText(GHOST, 'claude')).toEqual({ text: '', state: 'ghost' });
    expect(readClearComposer(GHOST, 'claude')).toEqual({ text: '', state: 'ghost' });
  });

  it('clearComposer reports it cleared with no pass sent', async () => {
    const result = await clearComposer('s-4476', 'claude', {
      capture: async () => GHOST,
      sendClear: async () => {
        throw new Error('no pass may be sent at a ghost');
      },
      delay: noDelay,
    });
    expect(result).toMatchObject({ cleared: true, passes: 0, state: 'ghost', discardedText: '' });
  });
});

describe('[#4476] a real residual is still refused after the cap (I3, negative control)', () => {
  it('reads the same row in plain text as content', () => {
    expect(extractComposerText(RESIDUAL, 'claude')).toEqual({
      text: 'セッションの起動とモデルの確認です。',
      state: 'content',
    });
  });

  it('a residual the passes never remove ends not cleared after the cap', async () => {
    vi.mocked(capturePane).mockResolvedValue(RESIDUAL);
    const result = await clearComposer('s-4476', 'claude', { delay: noDelay });
    expect(clearComposerLine).toHaveBeenCalledTimes(MAX_COMPOSER_CLEAR_PASSES);
    expect(result).toMatchObject({ cleared: false, state: 'content', remainingText: 'セッションの起動とモデルの確認です。' });
  });
});

describe('[#4476] the paste placeholder is a composer holding the body (I4)', () => {
  const spec = resolveComposerSpec('claude');

  it('the clear reads content, so it is never taken for an empty composer', () => {
    expect(extractComposerText(PASTED, 'claude')).toEqual({ text: '[Pasted text #1 +26 lines]', state: 'content' });
    expect(readClearComposer(PASTED, 'claude').state).toBe('content');
  });

  it('before Enter it is the whole 27-line body (landed); after Enter it is still pending (rule C)', () => {
    expect(classifyPasteLanded(PASTED, 'claude', BODY_27_LINES, spec)).toBe('landed');
    expect(classifySubmitWithRule(PASTED, 'claude', BODY_27_LINES, spec)).toEqual({ state: 'pending', rule: 'C' });
  });

  it('a frame with no body in it (the ghost) is unseen before Enter, as the send reported', () => {
    expect(classifyPasteLanded(GHOST, 'claude', BODY_27_LINES, spec)).toBe('unseen');
  });
});
