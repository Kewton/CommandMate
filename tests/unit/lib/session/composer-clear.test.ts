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
    expect(result).toEqual({ cleared: true, passes: 0, state: 'empty', remainingText: '' });
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
    expect(result).toEqual({ cleared: true, passes: 1, state: 'empty', remainingText: '' });
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

  it('defaults the cap to the documented value', () => {
    expect(MAX_COMPOSER_CLEAR_PASSES).toBeGreaterThanOrEqual(3);
  });

  it('refuses to claim success for a CLI whose composer it cannot read', async () => {
    // Reporting `cleared: true` here would be the server asserting it emptied a
    // box it never looked at.
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'codex', {
      capture: async () => ONE_ROW,
      sendClear,
      delay: noDelay,
    });

    expect(sendClear).not.toHaveBeenCalled();
    expect(result.cleared).toBe(false);
    expect(result.state).toBe('unsupported_tool');
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
