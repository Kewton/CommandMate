/**
 * useLocalStorageState Hook
 *
 * A generic hook for persisting state to localStorage with
 * type safety and validation support.
 *
 * @module hooks/useLocalStorageState
 */

'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * Options for useLocalStorageState hook
 */
export interface UseLocalStorageStateOptions<T> {
  /** Storage key */
  key: string;
  /** Default value if no stored value exists or validation fails */
  defaultValue: T;
  /** Optional validation function to check stored value */
  validate?: (value: unknown) => value is T;
  /** Serializer function (defaults to JSON.stringify) */
  serialize?: (value: T) => string;
  /** Deserializer function (defaults to JSON.parse) */
  deserialize?: (value: string) => unknown;
}

/**
 * Return type for useLocalStorageState hook
 */
export interface UseLocalStorageStateReturn<T> {
  /** Current state value */
  value: T;
  /** Set new value (also persists to localStorage) */
  setValue: (value: T | ((prev: T) => T)) => void;
  /** Remove value from localStorage and reset to default */
  removeValue: () => void;
  /** Whether localStorage is available */
  isAvailable: boolean;
}

/**
 * Check if localStorage is available
 */
function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const testKey = '__localStorage_test__';
    window.localStorage.setItem(testKey, 'test');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hook for persisting state to localStorage with validation
 *
 * Features:
 * - Type-safe with generics
 * - Optional validation function for stored values
 * - Handles SSR (starts with default, syncs on mount)
 * - Handles localStorage unavailability gracefully
 *
 * @param options - Configuration options
 * @returns State value and setter functions
 *
 * @example
 * ```tsx
 * // Simple usage
 * const { value, setValue } = useLocalStorageState({
 *   key: 'theme',
 *   defaultValue: 'light',
 * });
 *
 * // With validation
 * const { value, setValue } = useLocalStorageState({
 *   key: 'split-ratio',
 *   defaultValue: 0.5,
 *   validate: (v): v is number => typeof v === 'number' && v >= 0.1 && v <= 0.9,
 * });
 *
 * // With custom serialization
 * const { value, setValue } = useLocalStorageState({
 *   key: 'user-settings',
 *   defaultValue: { theme: 'dark', fontSize: 14 },
 *   serialize: (v) => JSON.stringify(v),
 *   deserialize: (v) => JSON.parse(v),
 * });
 * ```
 */
export function useLocalStorageState<T>(
  options: UseLocalStorageStateOptions<T>
): UseLocalStorageStateReturn<T> {
  const {
    key,
    defaultValue,
    validate,
    serialize = JSON.stringify,
    deserialize = JSON.parse,
  } = options;

  const [isAvailable, setIsAvailable] = useState(false);

  // Initialize with default value (for SSR compatibility)
  const [value, setValueState] = useState<T>(defaultValue);

  /**
   * Read value from localStorage with validation
   */
  const readFromStorage = useCallback((): T => {
    if (!isLocalStorageAvailable()) {
      return defaultValue;
    }

    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) {
        return defaultValue;
      }

      const parsed = deserialize(stored);

      // If validation function provided, use it
      if (validate) {
        return validate(parsed) ? parsed : defaultValue;
      }

      // Otherwise, trust the parsed value
      return parsed as T;
    } catch {
      // JSON parse error or other issue
      return defaultValue;
    }
  }, [key, defaultValue, validate, deserialize]);

  /**
   * Write value to localStorage
   */
  const writeToStorage = useCallback(
    (newValue: T): void => {
      if (!isLocalStorageAvailable()) {
        return;
      }

      try {
        const serialized = serialize(newValue);
        window.localStorage.setItem(key, serialized);
      } catch {
        // localStorage quota exceeded or other error - silently fail
      }
    },
    [key, serialize]
  );

  /**
   * Set new value and persist to localStorage
   */
  const setValue = useCallback(
    (newValue: T | ((prev: T) => T)): void => {
      setValueState((prev) => {
        const resolvedValue = typeof newValue === 'function' ? (newValue as (prev: T) => T)(prev) : newValue;
        writeToStorage(resolvedValue);
        return resolvedValue;
      });
    },
    [writeToStorage]
  );

  /**
   * Remove value from localStorage and reset to default
   */
  const removeValue = useCallback((): void => {
    if (isLocalStorageAvailable()) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore errors
      }
    }
    setValueState(defaultValue);
  }, [key, defaultValue]);

  /**
   * Initialize state from localStorage on mount
   */
  useEffect(() => {
    setIsAvailable(isLocalStorageAvailable());
    const storedValue = readFromStorage();
    setValueState(storedValue);
  }, [readFromStorage]);

  return {
    value,
    setValue,
    removeValue,
    isAvailable,
  };
}

export default useLocalStorageState;
