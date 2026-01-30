/**
 * Unit tests for useLocalStorageState hook
 *
 * @module tests/unit/hooks/useLocalStorageState
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';

describe('useLocalStorageState', () => {
  // Mock localStorage
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

  describe('initial state', () => {
    it('should return default value when localStorage is empty', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      expect(result.current.value).toBe('default');
    });

    it('should return stored value when available', () => {
      mockStorage['test-key'] = JSON.stringify('stored-value');

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      expect(result.current.value).toBe('stored-value');
    });

    it('should return default value when stored value fails validation', () => {
      mockStorage['test-key'] = JSON.stringify('invalid');

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 0.5,
          validate: (v): v is number => typeof v === 'number' && v >= 0.1 && v <= 0.9,
        })
      );

      expect(result.current.value).toBe(0.5);
    });

    it('should return valid stored value when validation passes', () => {
      mockStorage['test-key'] = JSON.stringify(0.7);

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 0.5,
          validate: (v): v is number => typeof v === 'number' && v >= 0.1 && v <= 0.9,
        })
      );

      expect(result.current.value).toBe(0.7);
    });

    it('should indicate localStorage is available', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      expect(result.current.isAvailable).toBe(true);
    });
  });

  describe('setValue', () => {
    it('should update state value', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'initial',
        })
      );

      act(() => {
        result.current.setValue('new-value');
      });

      expect(result.current.value).toBe('new-value');
    });

    it('should persist value to localStorage', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'initial',
        })
      );

      act(() => {
        result.current.setValue('persisted-value');
      });

      expect(mockStorage['test-key']).toBe(JSON.stringify('persisted-value'));
    });

    it('should support functional updates', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 1,
        })
      );

      act(() => {
        result.current.setValue((prev) => prev + 1);
      });

      expect(result.current.value).toBe(2);
    });

    it('should handle object values', () => {
      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: { count: 0 },
        })
      );

      act(() => {
        result.current.setValue({ count: 5 });
      });

      expect(result.current.value).toEqual({ count: 5 });
      expect(mockStorage['test-key']).toBe(JSON.stringify({ count: 5 }));
    });
  });

  describe('removeValue', () => {
    it('should remove value from localStorage', () => {
      mockStorage['test-key'] = JSON.stringify('stored');

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      act(() => {
        result.current.removeValue();
      });

      expect(mockStorage['test-key']).toBeUndefined();
    });

    it('should reset state to default value', () => {
      mockStorage['test-key'] = JSON.stringify('stored');

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      act(() => {
        result.current.removeValue();
      });

      expect(result.current.value).toBe('default');
    });
  });

  describe('custom serialization', () => {
    it('should use custom serializer', () => {
      const serialize = vi.fn((v: number) => String(v * 100));

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 0.5,
          serialize,
        })
      );

      act(() => {
        result.current.setValue(0.75);
      });

      expect(mockStorage['test-key']).toBe('75');
    });

    it('should use custom deserializer', () => {
      mockStorage['test-key'] = '75';

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 0.5,
          deserialize: (v: string) => Number(v) / 100,
        })
      );

      expect(result.current.value).toBe(0.75);
    });
  });

  describe('error handling', () => {
    it('should return default value when JSON parse fails', () => {
      mockStorage['test-key'] = 'invalid-json';

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      expect(result.current.value).toBe('default');
    });

    it('should not throw when localStorage.setItem fails', () => {
      const setItemMock = vi.fn(() => {
        throw new Error('Quota exceeded');
      });
      Object.defineProperty(window.localStorage, 'setItem', {
        value: setItemMock,
      });

      const { result } = renderHook(() =>
        useLocalStorageState({
          key: 'test-key',
          defaultValue: 'default',
        })
      );

      // Should not throw
      expect(() => {
        act(() => {
          result.current.setValue('new-value');
        });
      }).not.toThrow();

      // State should still update
      expect(result.current.value).toBe('new-value');
    });
  });

  describe('validation', () => {
    it('should validate split ratio bounds', () => {
      const isValidSplitRatio = (v: unknown): v is number =>
        typeof v === 'number' && v >= 0.1 && v <= 0.9;

      // Test below minimum
      mockStorage['ratio'] = JSON.stringify(0.05);
      const { result: r1 } = renderHook(() =>
        useLocalStorageState({
          key: 'ratio',
          defaultValue: 0.5,
          validate: isValidSplitRatio,
        })
      );
      expect(r1.current.value).toBe(0.5);

      // Test above maximum
      mockStorage['ratio'] = JSON.stringify(0.95);
      const { result: r2 } = renderHook(() =>
        useLocalStorageState({
          key: 'ratio',
          defaultValue: 0.5,
          validate: isValidSplitRatio,
        })
      );
      expect(r2.current.value).toBe(0.5);

      // Test valid value
      mockStorage['ratio'] = JSON.stringify(0.7);
      const { result: r3 } = renderHook(() =>
        useLocalStorageState({
          key: 'ratio',
          defaultValue: 0.5,
          validate: isValidSplitRatio,
        })
      );
      expect(r3.current.value).toBe(0.7);
    });

    it('should validate boolean values', () => {
      const isValidBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

      // Test invalid value
      mockStorage['maximized'] = JSON.stringify('true');
      const { result: r1 } = renderHook(() =>
        useLocalStorageState({
          key: 'maximized',
          defaultValue: false,
          validate: isValidBoolean,
        })
      );
      expect(r1.current.value).toBe(false);

      // Test valid value
      mockStorage['maximized'] = JSON.stringify(true);
      const { result: r2 } = renderHook(() =>
        useLocalStorageState({
          key: 'maximized',
          defaultValue: false,
          validate: isValidBoolean,
        })
      );
      expect(r2.current.value).toBe(true);
    });
  });
});
