/**
 * Tests for useAutoSave hook
 *
 * Tests auto-save functionality with debounce and immediate save
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoSave } from '@/hooks/useAutoSave';

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('should return isSaving as false initially', () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({ value: 'test', saveFn })
      );

      expect(result.current.isSaving).toBe(false);
    });

    it('should return error as null initially', () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({ value: 'test', saveFn })
      );

      expect(result.current.error).toBeNull();
    });
  });

  describe('Debounced save', () => {
    it('should not call saveFn immediately when value changes', () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });

      expect(saveFn).not.toHaveBeenCalled();
    });

    it('should call saveFn after 300ms debounce when value changes', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });

      // Fast-forward 299ms - should not be called yet
      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(saveFn).not.toHaveBeenCalled();

      // Fast-forward 1 more ms (total 300ms)
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(saveFn).toHaveBeenCalledWith('updated');
    });

    it('should reset debounce timer when value changes again', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'first' });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      rerender({ value: 'second' });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Should not have been called yet
      expect(saveFn).not.toHaveBeenCalled();

      // After another 100ms (300ms from last change)
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(saveFn).toHaveBeenCalledWith('second');
      expect(saveFn).toHaveBeenCalledTimes(1);
    });

    it('should accept custom debounce delay', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn, debounceMs: 500 }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });

      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(saveFn).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(saveFn).toHaveBeenCalled();
    });
  });

  describe('saveNow function', () => {
    it('should call saveFn immediately when saveNow is called', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({ value: 'test', saveFn })
      );

      await act(async () => {
        await result.current.saveNow();
      });

      expect(saveFn).toHaveBeenCalledWith('test');
    });

    it('should cancel pending debounced save when saveNow is called', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { result, rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Call saveNow before debounce completes
      await act(async () => {
        await result.current.saveNow();
      });

      expect(saveFn).toHaveBeenCalledTimes(1);
      expect(saveFn).toHaveBeenCalledWith('updated');

      // Fast-forward past debounce time - should not call again
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('isSaving state', () => {
    it('should set isSaving to true while saving', async () => {
      let resolvePromise: () => void;
      const saveFn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolvePromise = resolve;
        })
      );
      const { result, rerender } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(result.current.isSaving).toBe(true);

      await act(async () => {
        resolvePromise!();
      });

      expect(result.current.isSaving).toBe(false);
    });

    it('should set isSaving to true during saveNow', async () => {
      let resolvePromise: () => void;
      const saveFn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolvePromise = resolve;
        })
      );
      const { result } = renderHook(() =>
        useAutoSave({ value: 'test', saveFn })
      );

      let savePromise: Promise<void>;
      act(() => {
        savePromise = result.current.saveNow();
      });

      expect(result.current.isSaving).toBe(true);

      await act(async () => {
        resolvePromise!();
        await savePromise;
      });

      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should set error when saveFn throws', async () => {
      const error = new Error('Save failed');
      const saveFn = vi.fn().mockRejectedValue(error);
      const { result } = renderHook(() =>
        useAutoSave({ value: 'test', saveFn, maxRetries: 0 })
      );

      await act(async () => {
        await result.current.saveNow();
      });

      expect(result.current.error).toBe(error);
    });
  });

  describe('disabled option', () => {
    it('should not trigger debounced save when disabled is true', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        ({ value, disabled }) => useAutoSave({ value, saveFn, disabled }),
        { initialProps: { value: 'initial', disabled: true } }
      );

      rerender({ value: 'updated', disabled: true });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(saveFn).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should cancel pending save on unmount', async () => {
      const saveFn = vi.fn().mockResolvedValue(undefined);
      const { rerender, unmount } = renderHook(
        ({ value }) => useAutoSave({ value, saveFn }),
        { initialProps: { value: 'initial' } }
      );

      rerender({ value: 'updated' });
      unmount();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(saveFn).not.toHaveBeenCalled();
    });
  });
});
