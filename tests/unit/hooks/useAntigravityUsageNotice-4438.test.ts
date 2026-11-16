/**
 * Issue #4438 (stage B): when the Antigravity usage notice has been seen.
 *
 * Remembered per browser in localStorage, keyed to the date the terms were
 * checked (`ANTIGRAVITY_TERMS_CHECKED_AT`), so a re-check shows it again. Every
 * failure to read or write leans towards showing it: a notice shown twice is
 * better than one never shown.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_NOTICE_STORAGE_KEY,
  useAntigravityUsageNotice,
} from '@/hooks/useAntigravityUsageNotice';
import { ANTIGRAVITY_TERMS_CHECKED_AT } from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

describe('[#4438] useAntigravityUsageNotice', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('shows for antigravity the first time, and for no other tool (I5)', () => {
    const { result } = renderHook(() => useAntigravityUsageNotice());
    expect(result.current.shouldShow('antigravity')).toBe(true);
    for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'antigravity')) {
      expect(result.current.shouldShow(tool)).toBe(false);
    }
    expect(result.current.shouldShow('')).toBe(false);
  });

  it('does not show after it was closed, also in a later mount (I6)', () => {
    const first = renderHook(() => useAntigravityUsageNotice());
    act(() => first.result.current.dismiss());
    expect(first.result.current.shouldShow('antigravity')).toBe(false);
    expect(window.localStorage.getItem(ANTIGRAVITY_NOTICE_STORAGE_KEY)).toBe(ANTIGRAVITY_TERMS_CHECKED_AT);
    first.unmount();
    const second = renderHook(() => useAntigravityUsageNotice());
    expect(second.result.current.shouldShow('antigravity')).toBe(false);
  });

  it('closing in one place hides it in another mounted one', () => {
    const a = renderHook(() => useAntigravityUsageNotice());
    const b = renderHook(() => useAntigravityUsageNotice());
    act(() => a.result.current.dismiss());
    expect(b.result.current.shouldShow('antigravity')).toBe(false);
  });

  it('shows again when the stored date is not the current check date', () => {
    window.localStorage.setItem(ANTIGRAVITY_NOTICE_STORAGE_KEY, '2000-01-01');
    const { result } = renderHook(() => useAntigravityUsageNotice());
    expect(result.current.shouldShow('antigravity')).toBe(true);
  });

  it('shows when the storage cannot be read (I6)', () => {
    window.localStorage.setItem(ANTIGRAVITY_NOTICE_STORAGE_KEY, ANTIGRAVITY_TERMS_CHECKED_AT);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { result } = renderHook(() => useAntigravityUsageNotice());
    expect(result.current.shouldShow('antigravity')).toBe(true);
  });

  it('closing still hides it for now when the storage cannot be written, and a later mount shows it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const first = renderHook(() => useAntigravityUsageNotice());
    expect(() => act(() => first.result.current.dismiss())).not.toThrow();
    expect(first.result.current.shouldShow('antigravity')).toBe(false);
    first.unmount();
    const second = renderHook(() => useAntigravityUsageNotice());
    expect(second.result.current.shouldShow('antigravity')).toBe(true);
  });
});
