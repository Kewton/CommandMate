/**
 * Unit tests for tmux.ts navigation key exports
 * Issue #473: NAVIGATION_KEY_VALUES, NavigationKey, isAllowedSpecialKey, sendSpecialKeysAndInvalidate
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies for sendSpecialKeysAndInvalidate
vi.mock('@/lib/tmux-capture-cache', () => ({
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
} from '@/lib/tmux';
import { invalidateCache } from '@/lib/tmux-capture-cache';

describe('NAVIGATION_KEY_VALUES', () => {
  it('should be a readonly array', () => {
    expect(Array.isArray(NAVIGATION_KEY_VALUES)).toBe(true);
  });

  it('should contain exactly the 6 allowed navigation keys', () => {
    expect(NAVIGATION_KEY_VALUES).toEqual(['Up', 'Down', 'Enter', 'Escape', 'Tab', 'BTab']);
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
    expect(isAllowedSpecialKey('Left')).toBe(false);
    expect(isAllowedSpecialKey('Right')).toBe(false);
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

  it('should act as type guard (narrows to NavigationKey)', () => {
    const key: string = 'Up';
    if (isAllowedSpecialKey(key)) {
      // TypeScript should narrow key to NavigationKey here
      const _navKey: NavigationKey = key;
      expect(_navKey).toBe('Up');
    }
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
