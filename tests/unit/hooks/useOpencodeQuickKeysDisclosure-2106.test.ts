/**
 * Tests for useOpencodeQuickKeysDisclosure (Issue #2106).
 *
 * The one thing worth pinning here is the DEFAULT. #2106 exists because the
 * quick-keys strip measured 378px on a phone and left `TerminalDisplay` 0px at
 * 360x640; every pixel that recovers is recovered by this hook returning `false`
 * on a fresh device. So the constant is asserted directly — a test that only
 * checked `result.current.open` on first render would stay green if the constant
 * were flipped to `true` and the hook were changed to negate it.
 *
 * @module tests/unit/hooks/useOpencodeQuickKeysDisclosure-2106
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useOpencodeQuickKeysDisclosure,
  OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
  OPENCODE_QUICK_KEYS_DEFAULT_OPEN,
} from '@/hooks/useOpencodeQuickKeysDisclosure';

describe('useOpencodeQuickKeysDisclosure (Issue #2106)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('declares the strip CLOSED by default — the whole point of #2106', () => {
    expect(OPENCODE_QUICK_KEYS_DEFAULT_OPEN).toBe(false);
  });

  it('uses one device-wide key rather than a per-worktree one', () => {
    // Per-worktree would silently reset to closed on every new worktree; the
    // seventeen keys are identical on every opencode pane, so the preference is
    // a fact about the device. Pinned so the shape is a decision, not a typo.
    expect(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY).toBe(
      'commandmate:mobile:opencodeQuickKeysOpen'
    );
    expect(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY).not.toMatch(/worktree/i);
  });

  it('starts closed when nothing is stored', () => {
    const { result } = renderHook(() => useOpencodeQuickKeysDisclosure());
    expect(result.current.open).toBe(false);
  });

  it('persists the open state so it survives a reload', () => {
    const { result, unmount } = renderHook(() => useOpencodeQuickKeysDisclosure());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBe('true');
    unmount();

    // A fresh mount is what a reload looks like to this hook.
    const remounted = renderHook(() => useOpencodeQuickKeysDisclosure());
    expect(remounted.result.current.open).toBe(true);
  });

  it('persists the closed state too', () => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, 'true');
    const { result } = renderHook(() => useOpencodeQuickKeysDisclosure());
    expect(result.current.open).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBe('false');
  });

  it.each([
    ['a stale string', '"open"'],
    ['a number', '1'],
    ['malformed JSON', '{'],
  ])('falls back to closed for %s in storage', (_label, raw) => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, raw);
    const { result } = renderHook(() => useOpencodeQuickKeysDisclosure());
    expect(result.current.open).toBe(false);
  });
});
