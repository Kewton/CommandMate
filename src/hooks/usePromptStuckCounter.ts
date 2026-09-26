'use client';

/**
 * usePromptStuckCounter - counts how many times the same prompt window has been
 * shown back to back across Sends (Issue #2869).
 *
 * A Send that did not change the screen — refused by the server's re-check, or
 * delivered to a frame that did not react — leaves the same window up. After
 * {@link PROMPT_STUCK_THRESHOLD} displays (i.e. two Sends in a row that did not
 * take), the window points the user at direct-input mode, which sends keys as
 * they are and so works on frames the answer path cannot.
 *
 * Only whether the SCREEN changed is counted. The send's outcome (`success:
 * false`, keys delivered or not) is deliberately not an input.
 *
 * A "display" is a new `promptData` object: every poll that still sees the
 * window hands over a freshly parsed one, so the first one after
 * `markSubmitted()` is the answer to "did the Send change anything?". Counting
 * on the Send itself would show the hint while the request is still in flight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Displays of the same window (first display = 1) at which the hint appears. */
export const PROMPT_STUCK_THRESHOLD = 3;

/**
 * How long the window has to stay gone before the count starts over. A
 * successful Send clears the card and the next poll may bring the same one
 * back; that short gap is not a new start.
 */
export const PROMPT_STUCK_RESET_MS = 10_000;

function optionLabel(option: unknown): string | null {
  if (typeof option === 'string') return option.trim();
  if (option !== null && typeof option === 'object' && 'label' in option) {
    const label = (option as { label: unknown }).label;
    return typeof label === 'string' ? label.trim() : null;
  }
  return null;
}

/**
 * promptData → fingerprint: `type`, `question` and each option's label, in
 * order. Only surrounding whitespace is trimmed. `null` for no window and for a
 * form without options (nothing to Send, so nothing to count).
 */
export function promptFingerprint(promptData: unknown): string | null {
  if (promptData === null || typeof promptData !== 'object') return null;
  const data = promptData as { type?: unknown; question?: unknown; options?: unknown };
  if (!Array.isArray(data.options) || data.options.length === 0) return null;
  const labels = data.options.map(optionLabel);
  return JSON.stringify([
    typeof data.type === 'string' ? data.type.trim() : '',
    typeof data.question === 'string' ? data.question.trim() : '',
    ...labels,
  ]);
}

export interface UsePromptStuckCounterArgs {
  /** The promptData of the window on screen now (null while none is shown). */
  promptData: unknown;
  /** Restarts the count when it changes: worktreeId, cliToolId and instanceId joined. */
  targetKey: string;
}

export interface UsePromptStuckCounterResult {
  /** Displays of the current window (1 on its first display). */
  displayCount: number;
  /** `displayCount >= PROMPT_STUCK_THRESHOLD` */
  showStuckHint: boolean;
  /** Call right before a Send: remembers the fingerprint of the window sent. */
  markSubmitted: () => void;
}

export function usePromptStuckCounter({
  promptData,
  targetKey,
}: UsePromptStuckCounterArgs): UsePromptStuckCounterResult {
  const [displayCount, setDisplayCount] = useState(0);
  /** Fingerprint of the window last counted. */
  const lastFingerprintRef = useRef<string | null>(null);
  /** Fingerprint of the window a Send was made from, until the next display. */
  const submittedFingerprintRef = useRef<string | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearResetTimer();
    lastFingerprintRef.current = null;
    submittedFingerprintRef.current = null;
    setDisplayCount(0);
  }, [clearResetTimer]);

  // A different target is a different window, whatever it looks like.
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    reset();
  }, [targetKey, reset]);

  useEffect(() => {
    const fingerprint = promptFingerprint(promptData);
    if (fingerprint === null) {
      // Gone (or nothing countable): start over only if it stays gone.
      if (lastFingerprintRef.current !== null && resetTimerRef.current === null) {
        resetTimerRef.current = setTimeout(() => {
          resetTimerRef.current = null;
          lastFingerprintRef.current = null;
          submittedFingerprintRef.current = null;
          setDisplayCount(0);
        }, PROMPT_STUCK_RESET_MS);
      }
      return;
    }
    clearResetTimer();

    const submitted = submittedFingerprintRef.current;
    if (submitted !== null) {
      // The first display after a Send decides.
      submittedFingerprintRef.current = null;
      lastFingerprintRef.current = fingerprint;
      setDisplayCount((count) => (fingerprint === submitted ? count + 1 : 1));
      return;
    }
    if (fingerprint !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fingerprint;
      setDisplayCount(1);
    }
    // Same window re-polled with no Send in between: not a new display.
  }, [promptData, clearResetTimer]);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const promptDataRef = useRef(promptData);
  promptDataRef.current = promptData;
  const markSubmitted = useCallback(() => {
    submittedFingerprintRef.current =
      promptFingerprint(promptDataRef.current) ?? lastFingerprintRef.current;
  }, []);

  return {
    displayCount,
    showStuckHint: displayCount >= PROMPT_STUCK_THRESHOLD,
    markSubmitted,
  };
}
