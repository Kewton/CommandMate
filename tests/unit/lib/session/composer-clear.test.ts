/** @vitest-environment node */

/**
 * Issue #1879: [Clear] must actually empty the composer.
 *
 * #1878 §5-1 measured two ways a single `C-u` silently fails — cursor at column
 * 0 (it kills text *before* the cursor, so it kills nothing) and a multi-row
 * composer (it clears one row). The UI button promises "the box is now empty",
 * so `clearComposer` loops and reads the frame back instead of firing once.
 *
 * The frames here are built from the same shape as the live fixtures, with the
 * ANSI attributes that matter kept: the ghost case is the one that proves the
 * loop terminates on a claude session that has a dim suggestion on screen — a
 * text-only emptiness test would spin to the cap on every idle session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  clearComposerLine: vi.fn(),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { clearComposer, MAX_COMPOSER_CLEAR_PASSES } from '@/lib/session/composer-clear';

const SEP = '─'.repeat(40);
const ESC = '\u001b';

/** A claude footer with the given composer rows (raw, attributes intact). */
function frame(...composerRows: string[]): string {
  return ['⏺ a reply', SEP, ...composerRows, SEP, '  ⏵⏵ auto mode on'].join('\n');
}

const EMPTY = frame(`${ESC}[39m❯ `);
const GHOST = frame(`${ESC}[39m❯ ${ESC}[2mTry "how do I log an error?"${ESC}[0m`);
const ONE_ROW = frame(`${ESC}[39m❯ echo PREFILLED`);
const TWO_ROWS = frame(`${ESC}[39m❯ RESIDLINE1`, '  RESIDLINE2');

const noDelay = (): Promise<void> => Promise.resolve();

describe('clearComposer (Issue #1879)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends nothing when the composer is already empty', async () => {
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'claude', {
      capture: async () => EMPTY,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: true, passes: 0, state: 'empty', remainingText: '', discardedText: '' });
    // Nothing was sent, so nothing invalidated the poller's cached frame.
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it('sends nothing when all that is on screen is a dim ghost', async () => {
    // The termination case that a stripAnsi-based emptiness test gets wrong:
    // `C-u` cannot remove a suggestion that was never in the buffer, so a loop
    // that believed the rendered text would run to its cap here, every time.
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'claude', {
      capture: async () => GHOST,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).not.toHaveBeenCalled();
    expect(result.cleared).toBe(true);
    expect(result.state).toBe('ghost');
  });

  it('clears a one-row composer in a single pass and verifies the result', async () => {
    const sendClear = vi.fn();
    const frames = [ONE_ROW, EMPTY];
    const result = await clearComposer('sess', 'claude', {
      capture: async () => frames.shift() ?? EMPTY,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).toHaveBeenCalledTimes(1);
    expect(sendClear).toHaveBeenCalledWith('sess');
    expect(result).toEqual({ cleared: true, passes: 1, state: 'empty', remainingText: '', discardedText: 'echo PREFILLED' });
  });

  it('keeps going while the composer still holds text (multi-row residual)', async () => {
    // #1878 measured 2N-1 passes for N rows: two rows needed three.
    const sendClear = vi.fn();
    const frames = [TWO_ROWS, ONE_ROW, ONE_ROW, EMPTY];
    const result = await clearComposer('sess', 'claude', {
      capture: async () => frames.shift() ?? EMPTY,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).toHaveBeenCalledTimes(3);
    expect(result.cleared).toBe(true);
    expect(result.passes).toBe(3);
  });

  it('invalidates the capture cache once it has sent anything', async () => {
    // The poller and the WebSocket push both read through the 5s TTL cache; a
    // stale frame would leave the bar on screen after the text is gone.
    const frames = [ONE_ROW, EMPTY];
    await clearComposer('sess', 'claude', {
      capture: async () => frames.shift() ?? EMPTY,
      sendClear: vi.fn(),
      delay: noDelay,
    });

    expect(invalidateCache).toHaveBeenCalledWith('sess');
  });

  it('gives up at the pass cap and reports what is still there', async () => {
    // A CLI that ignores the keys must fail fast, not hold the request open.
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'claude', {
      capture: async () => ONE_ROW,
      sendClear,
      delay: noDelay,
      maxPasses: 4,
    });

    expect(sendClear).toHaveBeenCalledTimes(4);
    expect(result.cleared).toBe(false);
    expect(result.state).toBe('content');
    expect(result.remainingText).toBe('echo PREFILLED');
  });

  it('reports what it destroyed, which a successful clear cannot read back (Issue #1880)', async () => {
    // `remainingText` is the FINAL read, so on a successful clear it is '' and
    // the text is gone. The pre-send clear in submit-verified-sender has to log
    // what it threw away on the user's behalf, so the FIRST read is kept too —
    // and it is the first read that holds every row of a multi-row residual.
    const frames = [TWO_ROWS, ONE_ROW, ONE_ROW, EMPTY];
    const result = await clearComposer('sess', 'claude', {
      capture: async () => frames.shift() ?? EMPTY,
      sendClear: vi.fn(),
      delay: noDelay,
    });

    expect(result.cleared).toBe(true);
    expect(result.remainingText).toBe('');
    expect(result.discardedText).toBe('RESIDLINE1\nRESIDLINE2');
  });

  it('reports no discarded text when the composer started out empty', async () => {
    const result = await clearComposer('sess', 'claude', {
      capture: async () => EMPTY,
      sendClear: vi.fn(),
      delay: noDelay,
    });

    expect(result.discardedText).toBe('');
  });

  it('defaults the cap to the documented value', () => {
    expect(MAX_COMPOSER_CLEAR_PASSES).toBeGreaterThanOrEqual(3);
  });

  it('refuses to claim success for a CLI whose composer it cannot read', async () => {
    // Reporting `cleared: true` here would be the server asserting it emptied a
    // box it never looked at. codex used to be this case and stopped being it in
    // Issue #1890, which is why the tool named here is one still unmeasured.
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'gemini', {
      capture: async () => ONE_ROW,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).not.toHaveBeenCalled();
    expect(result.cleared).toBe(false);
    expect(result.state).toBe('unsupported_tool');
  });

  // Issue #1890: the loop's two exit conditions, driven through codex's own
  // layout rather than claude's. Nothing about `clearComposer` is tool-specific,
  // but the reason it terminates is — it stops when `extractComposerText` stops
  // saying `content`, and on codex that verdict is reached through a different
  // locator and a different placeholder.
  describe('codex (Issue #1890)', () => {
    /** A codex tail with the given composer rows (raw, attributes intact). */
    function codexFrame(...composerRows: string[]): string {
      return ['\u2022 a reply', '', ...composerRows, '', '  gpt-5.6-sol xhigh \u00b7 /repo'].join('\n');
    }

    const CODEX_PLACEHOLDER = codexFrame(`${ESC}[1m\u203A${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`);
    const CODEX_ONE_ROW = codexFrame(`${ESC}[1m\u203A${ESC}[0m echo PREFILLED`);

    it('sends nothing when the composer holds only codex’s placeholder', async () => {
      // The regression #1890 is most exposed to: a pass here fires on EVERY idle
      // codex send, spins to the cap, and then refuses to send at all.
      const sendClear = vi.fn();
      const result = await clearComposer('sess', 'codex', {
        capture: async () => CODEX_PLACEHOLDER,
        sendClear,
        delay: noDelay,
      });

      expect(sendClear).not.toHaveBeenCalled();
      expect(result).toEqual({
        cleared: true,
        passes: 0,
        state: 'ghost',
        remainingText: '',
        discardedText: '',
      });
    });

    it('clears real residual text and records what it threw away', async () => {
      const frames = [CODEX_ONE_ROW, CODEX_PLACEHOLDER];
      const sendClear = vi.fn();
      const result = await clearComposer('sess', 'codex', {
        capture: async () => frames.shift() ?? CODEX_PLACEHOLDER,
        sendClear,
        delay: noDelay,
      });

      expect(sendClear).toHaveBeenCalledTimes(1);
      expect(result.cleared).toBe(true);
      expect(result.passes).toBe(1);
      expect(result.discardedText).toBe('echo PREFILLED');
      expect(invalidateCache).toHaveBeenCalledWith('sess');
    });

    it('refuses to claim success on a codex dialog, and sends no keys at it', async () => {
      // An approval screen has the composer off screen entirely. `no_composer`
      // is the honest verdict, and the important half is that no `C-e`+`C-u`
      // reaches a dialog whose keys have consequences.
      const sendClear = vi.fn();
      const result = await clearComposer('sess', 'codex', {
        capture: async () =>
          ['  Would you like to make the following edits?', '',
           `${ESC}[1m${ESC}[38;5;6m\u203A 1. Yes, proceed (y)${ESC}[0m`,
           "  2. Yes, and don't ask again for these files",
           '', '  Press enter to confirm or esc to cancel'].join('\n'),
        sendClear,
        delay: noDelay,
      });

      expect(sendClear).not.toHaveBeenCalled();
      expect(result.cleared).toBe(false);
      expect(result.state).toBe('no_composer');
    });
  });

  it('refuses to claim success when no input box is on screen', async () => {
    const result = await clearComposer('sess', 'claude', {
      capture: async () => '⏺ a full-screen overlay with no composer',
      sendClear: vi.fn(),
      delay: noDelay,
    });

    expect(result.cleared).toBe(false);
    expect(result.state).toBe('no_composer');
  });
});
