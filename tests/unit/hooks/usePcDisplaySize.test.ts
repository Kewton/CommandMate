/**
 * Unit tests for usePcDisplaySize hook (Issue #915)
 *
 * @module tests/unit/hooks/usePcDisplaySize
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  usePcDisplaySize,
  isPcDisplaySize,
  getPcDisplaySizeFactor,
  getTerminalFontSize,
  PC_DISPLAY_SIZE_STORAGE_KEY,
  DEFAULT_PC_DISPLAY_SIZE,
  PC_DISPLAY_SIZE_ORDER,
  PC_DISPLAY_SIZE_META,
} from '@/hooks/usePcDisplaySize';

describe('usePcDisplaySize (Issue #915)', () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    const localStorageMock = {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
      get length() {
        return Object.keys(mockStorage).length;
      },
      key: vi.fn((index: number) => Object.keys(mockStorage)[index] ?? null),
    };
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('metadata', () => {
    it('defaults to medium', () => {
      expect(DEFAULT_PC_DISPLAY_SIZE).toBe('medium');
    });

    it('orders sizes 大 → 極小', () => {
      expect(PC_DISPLAY_SIZE_ORDER).toEqual(['large', 'medium', 'small', 'xsmall']);
    });

    it('validates known sizes and rejects others', () => {
      expect(isPcDisplaySize('large')).toBe(true);
      expect(isPcDisplaySize('medium')).toBe(true);
      expect(isPcDisplaySize('small')).toBe(true);
      expect(isPcDisplaySize('xsmall')).toBe(true);
      expect(isPcDisplaySize('huge')).toBe(false);
      expect(isPcDisplaySize(123)).toBe(false);
      expect(isPcDisplaySize(null)).toBe(false);
      expect(isPcDisplaySize(undefined)).toBe(false);
      expect(isPcDisplaySize({})).toBe(false);
    });

    it('exposes factor and terminal font size per size', () => {
      expect(getPcDisplaySizeFactor('medium')).toBe(1);
      expect(getPcDisplaySizeFactor('large')).toBe(1.125);
      expect(getPcDisplaySizeFactor('small')).toBe(0.875);
      expect(getPcDisplaySizeFactor('xsmall')).toBe(0.78);
      expect(getTerminalFontSize('large')).toBe(16);
      expect(getTerminalFontSize('medium')).toBe(14);
      expect(getTerminalFontSize('small')).toBe(12);
      expect(getTerminalFontSize('xsmall')).toBe(11);
      expect(PC_DISPLAY_SIZE_META.large.rootFontSizePx).toBe(18);
      expect(PC_DISPLAY_SIZE_META.medium.rootFontSizePx).toBe(16);
      expect(PC_DISPLAY_SIZE_META.small.rootFontSizePx).toBe(14);
      expect(PC_DISPLAY_SIZE_META.xsmall.rootFontSizePx).toBe(12.5);
    });
  });

  describe('hook', () => {
    it('returns medium by default when nothing is stored', () => {
      const { result } = renderHook(() => usePcDisplaySize());
      expect(result.current.size).toBe('medium');
    });

    it('reads a valid persisted size', () => {
      mockStorage[PC_DISPLAY_SIZE_STORAGE_KEY] = JSON.stringify('small');
      const { result } = renderHook(() => usePcDisplaySize());
      expect(result.current.size).toBe('small');
    });

    it('falls back to medium for an invalid persisted value', () => {
      mockStorage[PC_DISPLAY_SIZE_STORAGE_KEY] = JSON.stringify('huge');
      const { result } = renderHook(() => usePcDisplaySize());
      expect(result.current.size).toBe('medium');
    });

    it('persists the selected size to localStorage', () => {
      const { result } = renderHook(() => usePcDisplaySize());
      act(() => {
        result.current.setSize('xsmall');
      });
      expect(result.current.size).toBe('xsmall');
      expect(mockStorage[PC_DISPLAY_SIZE_STORAGE_KEY]).toBe(JSON.stringify('xsmall'));
    });
  });
});
