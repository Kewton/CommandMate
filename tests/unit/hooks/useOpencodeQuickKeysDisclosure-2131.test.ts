/**
 * Tests for the per-screen split of useOpencodeQuickKeysDisclosure (Issue #2131).
 *
 * #2131 gave PC the disclosure #2106 had only given the phone. The two things
 * that can silently regress are not the folding itself (that is #2106's, already
 * covered) but the two DECISIONS layered on top of it:
 *
 *   1. **Separate keys.** If PC and the phone share one localStorage key, folding
 *      the strip on a phone folds it on a 1920px desktop as well — a bug that
 *      never fails a render assertion, because both screens still "work".
 *   2. **Opposite defaults.** The phone starts CLOSED (its terminal is 0px at
 *      360x640 with the strip open); PC starts OPEN (a 1-split pane keeps 456px
 *      and #2046's chords have no other route in). A test that only read
 *      `result.current.open` would stay green if a constant flipped and the hook
 *      negated it, so the constants are asserted directly — the same discipline
 *      `useOpencodeQuickKeysDisclosure-2106.test.ts` applies to the phone's.
 *
 * @module tests/unit/hooks/useOpencodeQuickKeysDisclosure-2131
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useOpencodeQuickKeysDisclosure,
  OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
  OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY,
  OPENCODE_QUICK_KEYS_DEFAULT_OPEN,
  OPENCODE_QUICK_KEYS_DESKTOP_DEFAULT_OPEN,
  OPENCODE_QUICK_KEYS_DISCLOSURE_BY_LAYOUT,
} from '@/hooks/useOpencodeQuickKeysDisclosure';

describe('useOpencodeQuickKeysDisclosure: the two screens are separate (Issue #2131)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gives PC its own key, distinct from the phone\'s', () => {
    expect(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY).toBe(
      'commandmate:desktop:opencodeQuickKeysOpen'
    );
    expect(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY).not.toBe(
      OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY
    );
    // Still device-wide, not per-worktree (the #2106 shape, kept).
    expect(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY).not.toMatch(/worktree/i);
  });

  it('declares PC OPEN and the phone CLOSED by default', () => {
    expect(OPENCODE_QUICK_KEYS_DESKTOP_DEFAULT_OPEN).toBe(true);
    // #2131's acceptance condition: the phone's default must NOT move.
    expect(OPENCODE_QUICK_KEYS_DEFAULT_OPEN).toBe(false);
  });

  it('routes each layout to its own (key, default) pair', () => {
    expect(OPENCODE_QUICK_KEYS_DISCLOSURE_BY_LAYOUT).toEqual({
      mobile: {
        storageKey: OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
        defaultOpen: false,
      },
      desktop: {
        storageKey: OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY,
        defaultOpen: true,
      },
    });
  });

  it('starts open on desktop and closed on mobile with nothing stored', () => {
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('desktop')).result.current.open).toBe(
      true
    );
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('mobile')).result.current.open).toBe(
      false
    );
  });

  it('keeps the pre-#2131 call shape on the mobile default', () => {
    // MobileTerminalTab names its layout explicitly, but the parameterless call
    // is what every pre-#2131 caller and the #2106 tests use; it must still be
    // the phone's key and the phone's default.
    const { result } = renderHook(() => useOpencodeQuickKeysDisclosure());
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBe('true');
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY)).toBeNull();
  });

  it('writes the desktop toggle to the desktop key and leaves the phone alone', () => {
    const { result } = renderHook(() => useOpencodeQuickKeysDisclosure('desktop'));

    act(() => result.current.toggle());

    expect(result.current.open).toBe(false);
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY)).toBe('false');
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBeNull();
  });

  it('does not let one screen\'s stored preference reach the other', () => {
    // The exact bug a shared key would produce: folded on the phone, and the
    // desktop silently folds too.
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, 'false');
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('desktop')).result.current.open).toBe(
      true
    );

    window.localStorage.setItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY, 'true');
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('mobile')).result.current.open).toBe(
      false
    );
  });

  it('persists the desktop closed state across a remount (what a reload looks like)', () => {
    const first = renderHook(() => useOpencodeQuickKeysDisclosure('desktop'));
    act(() => first.result.current.toggle());
    first.unmount();

    const remounted = renderHook(() => useOpencodeQuickKeysDisclosure('desktop'));
    expect(remounted.result.current.open).toBe(false);

    act(() => remounted.result.current.toggle());
    remounted.unmount();
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('desktop')).result.current.open).toBe(
      true
    );
  });

  it.each([
    ['a stale string', '"open"'],
    ['a number', '0'],
    ['malformed JSON', '{'],
  ])('falls back to the desktop default for %s in storage', (_label, raw) => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY, raw);
    expect(renderHook(() => useOpencodeQuickKeysDisclosure('desktop')).result.current.open).toBe(
      true
    );
  });
});
