/** @vitest-environment node */

/**
 * Issue #3937: a codex paste placeholder left in the composer was never cleared.
 *
 * `clearComposer` sent `C-e`+`C-u` twelve times at `[Pasted Content 3575 chars]`
 * and reported `cleared: false`; one `BSpace` by hand removed it. A pass over a
 * codex composer that holds that placeholder and nothing else now sends
 * `C-e`+`BSpace`; every other frame keeps `C-e`+`C-u`, and the read-back
 * decides as before.
 *
 * Frames: the live 0.154.0 capture (`long-body-2464/`) and synthetic variants of
 * it (`codex-paste-token-3937/variants.json`, see its README). The keys' effect on a live
 * codex is not something these frames can show — only which keys go out, in
 * which order, and how each read-back is judged.
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

import { capturePane, clearComposerLine, clearComposerPasteToken } from '@/lib/tmux/tmux';
import { extractLiveComposerText } from '@/lib/detection/composer-text';
import {
  clearComposer,
  isCodexPasteTokenOnly,
  MAX_COMPOSER_CLEAR_PASSES,
} from '@/lib/session/composer-clear';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const LIVE_TOKEN = read('long-body-2464/codex-pasted-content.capture');
const IDLE = read('long-body-2464/codex-idle.capture');

/** Synthetic frames: the live capture with its composer row swapped (see the fixture README). */
const VARIANTS = JSON.parse(read('codex-paste-token-3937/variants.json')) as {
  base: string;
  replaces: string;
  rows: Record<string, string>;
};
function variant(key: string): string {
  const rows = read(VARIANTS.base).split('\n');
  const at = rows.findIndex((row) => row.includes(VARIANTS.replaces));
  rows[at] = VARIANTS.rows[key];
  return rows.join('\n');
}
const TOKEN_ONLY = variant('token-only');
const TOKEN_THEN_TYPED = variant('token-then-typed');
const TWO_TOKENS = variant('two-tokens');
const QUOTED_AMONG_TEXT = variant('quoted-among-text');
const QUOTED_EXACT = variant('quoted-exact');
const QUOTED_EXACT_BSPACED = variant('quoted-exact-bspaced');

const noDelay = (): Promise<void> => Promise.resolve();

/** Frames returned in order; the last one repeats. */
function frames(...list: string[]): () => Promise<string> {
  let i = 0;
  return async () => list[Math.min(i++, list.length - 1)];
}

/** The keys sent, in order: `U` for `C-e`+`C-u`, `B` for `C-e`+`BSpace`. */
function recorder(): {
  keys: string[];
  sendClear: (s: string) => Promise<void>;
  sendClearPasteToken: (s: string) => Promise<void>;
} {
  const keys: string[] = [];
  return {
    keys,
    sendClear: async () => { keys.push('U'); },
    sendClearPasteToken: async () => { keys.push('B'); },
  };
}

describe('codex paste placeholder in the composer (Issue #3937)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the live 0.154.0 frame reads as content holding the placeholder', () => {
    expect(extractLiveComposerText(LIVE_TOKEN, 'codex')).toEqual({
      text: '[Pasted Content 12288 chars]',
      state: 'content',
    });
    expect(extractLiveComposerText(TOKEN_ONLY, 'codex')).toEqual({
      text: '[Pasted Content 3575 chars]',
      state: 'content',
    });
  });

  it.each([
    ['live 0.154.0', LIVE_TOKEN],
    ['synthetic 3575', TOKEN_ONLY],
  ])('placeholder only (%s): one C-e+BSpace pass, then cleared', async (_name, frame) => {
    const r = recorder();
    const result = await clearComposer('sess', 'codex', {
      capture: frames(frame, IDLE),
      sendClear: r.sendClear,
      sendClearPasteToken: r.sendClearPasteToken,
      delay: noDelay,
    });

    expect(r.keys).toEqual(['B']);
    expect(result).toMatchObject({ cleared: true, passes: 1, state: 'ghost' });
    expect(result.discardedText).toMatch(/^\[Pasted Content \d+ chars\]$/);
  });

  it('defaults the placeholder pass to tmux clearComposerPasteToken', async () => {
    const result = await clearComposer('sess', 'codex', {
      capture: frames(TOKEN_ONLY, IDLE),
      delay: noDelay,
    });

    expect(clearComposerPasteToken).toHaveBeenCalledWith('sess');
    expect(clearComposerLine).not.toHaveBeenCalled();
    expect(result.cleared).toBe(true);
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('a placeholder that never goes away still stops at the cap with cleared: false', async () => {
    const r = recorder();
    const result = await clearComposer('sess', 'codex', {
      capture: frames(TOKEN_ONLY),
      sendClear: r.sendClear,
      sendClearPasteToken: r.sendClearPasteToken,
      delay: noDelay,
    });

    expect(r.keys).toEqual(Array(MAX_COMPOSER_CLEAR_PASSES).fill('B'));
    expect(result).toMatchObject({ cleared: false, state: 'content', remainingText: '[Pasted Content 3575 chars]' });
  });

  describe('controls: not the placeholder-only frame', () => {
    it('placeholder + typed text: C-e+C-u only, failing at the cap if it never changes', async () => {
      // `C-e`+`BSpace` here would take the last typed character, not the placeholder.
      const r = recorder();
      const result = await clearComposer('sess', 'codex', {
        capture: frames(TOKEN_THEN_TYPED),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(Array(MAX_COMPOSER_CLEAR_PASSES).fill('U'));
      expect(result.cleared).toBe(false);
      expect(result.remainingText).toBe('[Pasted Content 3575 chars] and one more line');
    });

    it('placeholder + typed text: BSpace only once a read-back shows the placeholder alone', async () => {
      const r = recorder();
      const result = await clearComposer('sess', 'codex', {
        capture: frames(TOKEN_THEN_TYPED, TOKEN_ONLY, IDLE),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(['U', 'B']);
      expect(result.cleared).toBe(true);
      expect(result.discardedText).toBe('[Pasted Content 3575 chars] and one more line');
    });

    it('two placeholders: C-e+C-u only, cleared: false at the cap', async () => {
      const r = recorder();
      const result = await clearComposer('sess', 'codex', {
        capture: frames(TWO_TOKENS),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(Array(MAX_COMPOSER_CLEAR_PASSES).fill('U'));
      expect(result.cleared).toBe(false);
    });

    it('a body quoting the placeholder among other text is ordinary text: C-e+C-u', async () => {
      const r = recorder();
      const result = await clearComposer('sess', 'codex', {
        capture: frames(QUOTED_AMONG_TEXT, IDLE),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(['U']);
      expect(result).toMatchObject({ cleared: true, remainingText: '' });
    });

    it('a body that is only the wording typed out: one BSpace, then C-e+C-u — nothing left behind', async () => {
      const r = recorder();
      const result = await clearComposer('sess', 'codex', {
        capture: frames(QUOTED_EXACT, QUOTED_EXACT_BSPACED, IDLE),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(['B', 'U']);
      expect(result).toMatchObject({ cleared: true, remainingText: '' });
      expect(result.discardedText).toBe('[Pasted Content 600 chars]');
    });

    it('claude never gets the placeholder pass, even for the same wording', async () => {
      const SEP = '─'.repeat(40);
      const claudeFrame = (row: string): string => ['⏺ a reply', SEP, row, SEP, '  ⏵⏵ auto mode on'].join('\n');
      const r = recorder();
      const result = await clearComposer('sess', 'claude', {
        capture: frames(claudeFrame('\u001b[39m❯ [Pasted Content 10 chars]'), claudeFrame('\u001b[39m❯ ')),
        sendClear: r.sendClear,
        sendClearPasteToken: r.sendClearPasteToken,
        delay: noDelay,
      });

      expect(r.keys).toEqual(['U']);
      expect(result.cleared).toBe(true);
    });
  });

  describe('isCodexPasteTokenOnly', () => {
    it.each([
      ['codex', { text: '[Pasted Content 3575 chars]', state: 'content' }, true],
      ['codex', { text: '  [Pasted Content 1 char]  ', state: 'content' }, true],
      ['codex', { text: '[Pasted Content 3575 chars] x', state: 'content' }, false],
      ['codex', { text: '[Pasted Content 3575 chars][Pasted Content 1 chars]', state: 'content' }, false],
      ['codex', { text: '[Pasted Content 3575 chars]\nmore', state: 'content' }, false],
      ['codex', { text: '[Pasted text #3 +20 lines]', state: 'content' }, false],
      ['codex', { text: '', state: 'ghost' }, false],
      ['claude', { text: '[Pasted Content 3575 chars]', state: 'content' }, false],
    ] as const)('%s %j -> %s', (cliToolId, reading, expected) => {
      expect(isCodexPasteTokenOnly(reading, cliToolId)).toBe(expected);
    });
  });
});
