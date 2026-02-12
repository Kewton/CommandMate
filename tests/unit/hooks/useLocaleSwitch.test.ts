/**
 * Tests for useLocaleSwitch hook
 *
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock next-intl useLocale
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
}));

// Mock locale-cookie
const mockSetLocaleCookie = vi.fn();
vi.mock('@/lib/locale-cookie', () => ({
  setLocaleCookie: (...args: unknown[]) => mockSetLocaleCookie(...args),
}));

describe('useLocaleSwitch', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    // Replace window.location with a mock that has a spyable reload
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        reload: vi.fn(),
      },
    });
    // Mock localStorage
    vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it('should return currentLocale from useLocale()', async () => {
    const { useLocaleSwitch } = await import('@/hooks/useLocaleSwitch');
    const { result } = renderHook(() => useLocaleSwitch());
    expect(result.current.currentLocale).toBe('en');
  });

  it('should call setLocaleCookie, localStorage.setItem, and reload on valid locale switch', async () => {
    const { useLocaleSwitch } = await import('@/hooks/useLocaleSwitch');
    const { result } = renderHook(() => useLocaleSwitch());

    act(() => {
      result.current.switchLocale('ja');
    });

    expect(mockSetLocaleCookie).toHaveBeenCalledWith('ja');
    expect(localStorage.setItem).toHaveBeenCalledWith('locale', 'ja');
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('should not call anything for invalid locale', async () => {
    const { useLocaleSwitch } = await import('@/hooks/useLocaleSwitch');
    const { result } = renderHook(() => useLocaleSwitch());

    act(() => {
      result.current.switchLocale('fr');
    });

    expect(mockSetLocaleCookie).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('should not call anything for empty string locale', async () => {
    const { useLocaleSwitch } = await import('@/hooks/useLocaleSwitch');
    const { result } = renderHook(() => useLocaleSwitch());

    act(() => {
      result.current.switchLocale('');
    });

    expect(mockSetLocaleCookie).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
