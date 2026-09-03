/**
 * Unit tests for tmux.ts navigation key exports
 * Issue #473: NAVIGATION_KEY_VALUES, NavigationKey, isAllowedSpecialKey, sendSpecialKeysAndInvalidate
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies for sendSpecialKeysAndInvalidate
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

// We need to partially mock tmux to test the real exports while mocking execFile
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => vi.fn().mockResolvedValue({ stdout: '' })),
}));

import {
  NAVIGATION_KEY_VALUES,
  type NavigationKey,
  isAllowedSpecialKey,
  sendSpecialKeysAndInvalidate,
  SPECIAL_KEY_VALUES,
  sendSpecialKeys,
} from '@/lib/tmux/tmux';
import {
  ANSWER_KEY_VALUES,
  OPENCODE_NAVIGATION_KEY_VALUES,
  type TerminalKey,
} from '@/types/terminal-keys';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';

describe('NAVIGATION_KEY_VALUES', () => {
  it('should be a readonly array', () => {
    expect(Array.isArray(NAVIGATION_KEY_VALUES)).toBe(true);
  });

  it('should contain the base navigation keys plus the Issue #1017 pager keys and the Issue #2254 answer keys', () => {
    expect(NAVIGATION_KEY_VALUES).toEqual([
      'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab',
      // Issue #1017: Codex pager / edit-previous mode keys.
      'PageUp', 'PageDown', 'Home', 'End', 'q',
      // Issue #2254: the characters a dialog is answered WITH. The chat
      // surface's dialog card sends these; before them the only thing chat
      // could send at an unreadable wait was a direction, and Enter on a
      // numbered dialog takes whatever the CLI highlighted (#1681).
      '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n',
    ]);
  });

  it('publishes the Issue #2254 answer keys as their own list, in the same order', () => {
    // The base list is composed from this one, so a widening that forgets to
    // update the pin above is caught here rather than only there.
    expect(ANSWER_KEY_VALUES).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n',
    ]);
    for (const key of ANSWER_KEY_VALUES) {
      expect(NAVIGATION_KEY_VALUES as readonly string[]).toContain(key);
    }
  });

  it('accepts every Issue #2254 answer key at the route and still refuses its neighbours', () => {
    for (const key of ANSWER_KEY_VALUES) {
      expect(isAllowedSpecialKey(key), `answer key ${key}`).toBe(true);
    }
    // `0` is deliberately absent (no dialog measured for #2254 offers option 0),
    // and the letters around y/n stay outside the vocabulary for every tool but
    // opencode — a widened answer list would type them into a composer.
    for (const key of ['0', '10', 'z', 'x', 'Y', 'N']) {
      expect(isAllowedSpecialKey(key), `must stay refused: ${key}`).toBe(false);
    }
  });

  it('should include the Codex pager keys (Issue #1017)', () => {
    for (const key of ['PageUp', 'PageDown', 'Home', 'End', 'q']) {
      expect(NAVIGATION_KEY_VALUES).toContain(key);
    }
  });

  it('should be distinct from SPECIAL_KEY_VALUES (no name collision)', () => {
    // SPECIAL_KEY_VALUES is for sendSpecialKey() - different key set
    expect(SPECIAL_KEY_VALUES).toBeDefined();
    // They are different arrays with different purposes
    expect(NAVIGATION_KEY_VALUES).not.toEqual(SPECIAL_KEY_VALUES);
  });
});

describe('isAllowedSpecialKey', () => {
  it('should return true for each key in NAVIGATION_KEY_VALUES', () => {
    for (const key of NAVIGATION_KEY_VALUES) {
      expect(isAllowedSpecialKey(key)).toBe(true);
    }
  });

  it('should return false for keys not in the allowed set', () => {
    expect(isAllowedSpecialKey('C-c')).toBe(false);
    expect(isAllowedSpecialKey('C-d')).toBe(false);
    expect(isAllowedSpecialKey('C-m')).toBe(false);
    expect(isAllowedSpecialKey('Left')).toBe(true);
    expect(isAllowedSpecialKey('Right')).toBe(true);
    expect(isAllowedSpecialKey('Space')).toBe(false);
    expect(isAllowedSpecialKey('')).toBe(false);
    expect(isAllowedSpecialKey('arbitrary-key')).toBe(false);
    expect(isAllowedSpecialKey('rm -rf /')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(isAllowedSpecialKey('up')).toBe(false);
    expect(isAllowedSpecialKey('UP')).toBe(false);
    expect(isAllowedSpecialKey('down')).toBe(false);
    expect(isAllowedSpecialKey('enter')).toBe(false);
  });

  it('should accept the Codex pager keys (Issue #1017)', () => {
    expect(isAllowedSpecialKey('PageUp')).toBe(true);
    expect(isAllowedSpecialKey('PageDown')).toBe(true);
    expect(isAllowedSpecialKey('Home')).toBe(true);
    expect(isAllowedSpecialKey('End')).toBe(true);
    expect(isAllowedSpecialKey('q')).toBe(true);
    // Only the single literal 'q' is allowed — not arbitrary letters.
    expect(isAllowedSpecialKey('Q')).toBe(false);
    expect(isAllowedSpecialKey('quit')).toBe(false);
  });

  it('should reject Space, BSpace, and DC keys (security regression)', () => {
    expect(isAllowedSpecialKey('Space')).toBe(false);
    expect(isAllowedSpecialKey('BSpace')).toBe(false);
    expect(isAllowedSpecialKey('DC')).toBe(false);
  });

  it('should act as type guard (narrows to TerminalKey)', () => {
    const key: string = 'Up';
    if (isAllowedSpecialKey(key)) {
      // Issue #2046: the guard narrows to TerminalKey (the union of every tool's
      // vocabulary) rather than to NavigationKey, because the vocabulary it
      // checks against is now the caller's — a tool's own declaration. Assigning
      // through NavigationKey still works for a base-vocabulary key, which is
      // what this asserts.
      const _terminalKey: TerminalKey = key;
      const _navKey: NavigationKey = _terminalKey as NavigationKey;
      expect(_navKey).toBe('Up');
    }
  });

  // Issue #2046: the second parameter is the declaring tool's key list.
  it('accepts an opencode chord key only when the opencode vocabulary is passed', () => {
    expect(isAllowedSpecialKey('C-x')).toBe(false);
    expect(isAllowedSpecialKey('C-x', OPENCODE_NAVIGATION_KEY_VALUES)).toBe(true);
    expect(isAllowedSpecialKey('a', OPENCODE_NAVIGATION_KEY_VALUES)).toBe(true);
  });

  it('still refuses a key the transport cannot deliver, whatever vocabulary is passed', () => {
    // `F2` is a real opencode binding (model_cycle_recent) that this Issue did
    // NOT publish; a vocabulary that names it must still not get it through.
    expect(isAllowedSpecialKey('F2', ['F2'])).toBe(false);
    expect(isAllowedSpecialKey('b', OPENCODE_NAVIGATION_KEY_VALUES)).toBe(false);
  });
});

describe('sendSpecialKeysAndInvalidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call sendSpecialKeys and then invalidateCache', async () => {
    // sendSpecialKeys is also mocked via child_process mock
    await sendSpecialKeysAndInvalidate('test-session', ['Up']);
    expect(invalidateCache).toHaveBeenCalledWith('test-session');
  });

  it('should call invalidateCache even after sending multiple keys', async () => {
    await sendSpecialKeysAndInvalidate('test-session', ['Down', 'Down', 'Enter']);
    expect(invalidateCache).toHaveBeenCalledWith('test-session');
    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });
});
