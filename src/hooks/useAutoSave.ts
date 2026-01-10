/**
 * useAutoSave Hook
 *
 * Provides auto-save functionality with debounce and immediate save options.
 * Features:
 * - 300ms debounce for auto-save on value change
 * - saveNow function for immediate save (e.g., onBlur)
 * - isSaving state for UI indicators
 * - Error handling with retry support
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface UseAutoSaveOptions<T> {
  /** The value to save */
  value: T;
  /** Function to call to save the value */
  saveFn: (value: T) => Promise<void>;
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** Whether auto-save is disabled */
  disabled?: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Callback when save completes successfully */
  onSaveComplete?: () => void;
}

export interface UseAutoSaveResult {
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Error from the last save attempt */
  error: Error | null;
  /** Function to immediately save the current value */
  saveNow: () => Promise<void>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * useAutoSave - Auto-save hook with debounce and immediate save
 *
 * @example
 * ```tsx
 * const { isSaving, error, saveNow } = useAutoSave({
 *   value: memoContent,
 *   saveFn: async (value) => {
 *     await api.updateMemo(memoId, { content: value });
 *   },
 *   debounceMs: 300,
 * });
 *
 * // Use saveNow on blur for immediate save
 * <textarea onBlur={saveNow} />
 * ```
 */
export function useAutoSave<T>({
  value,
  saveFn,
  debounceMs = 300,
  disabled = false,
  maxRetries = 3,
  onSaveComplete,
}: UseAutoSaveOptions<T>): UseAutoSaveResult {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track the latest value and save function
  const valueRef = useRef(value);
  const saveFnRef = useRef(saveFn);
  const onSaveCompleteRef = useRef(onSaveComplete);

  // Track debounce timer
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Track if component is mounted
  const mountedRef = useRef(true);

  // Track the initial value to detect changes
  const initialValueRef = useRef(value);

  // Update refs when values change
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    saveFnRef.current = saveFn;
  }, [saveFn]);

  useEffect(() => {
    onSaveCompleteRef.current = onSaveComplete;
  }, [onSaveComplete]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  /**
   * Execute save with retry logic
   */
  const executeSave = useCallback(
    async (valueToSave: T): Promise<void> => {
      if (!mountedRef.current) return;

      setIsSaving(true);
      setError(null);

      let lastError: Error | null = null;
      let attempt = 0;

      while (attempt <= maxRetries) {
        try {
          await saveFnRef.current(valueToSave);
          if (mountedRef.current) {
            setIsSaving(false);
            setError(null);
            onSaveCompleteRef.current?.();
          }
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          attempt++;

          if (attempt <= maxRetries) {
            // Exponential backoff: 1s, 2s, 4s...
            const delay = Math.pow(2, attempt - 1) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // All retries failed
      if (mountedRef.current) {
        setIsSaving(false);
        setError(lastError);
      }
    },
    [maxRetries]
  );

  /**
   * Cancel any pending debounced save
   */
  const cancelPendingSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Immediately save the current value
   */
  const saveNow = useCallback(async (): Promise<void> => {
    if (disabled) return;

    cancelPendingSave();
    await executeSave(valueRef.current);
  }, [disabled, cancelPendingSave, executeSave]);

  /**
   * Debounced save effect - triggers when value changes
   */
  useEffect(() => {
    // Don't save on initial render
    if (value === initialValueRef.current) {
      return;
    }

    if (disabled) return;

    cancelPendingSave();

    timerRef.current = setTimeout(() => {
      void executeSave(valueRef.current);
    }, debounceMs);

    return () => {
      cancelPendingSave();
    };
  }, [value, disabled, debounceMs, cancelPendingSave, executeSave]);

  return {
    isSaving,
    error,
    saveNow,
  };
}

export default useAutoSave;
