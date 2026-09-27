/**
 * usePromptStuckCounter — counting the same prompt window across Sends
 * (Issue #2869).
 *
 * Every poll that still sees a window hands over a freshly parsed object, so
 * each `rerender` below passes a NEW object — the same content where the test
 * says "same window".
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  PROMPT_STUCK_RESET_MS,
  PROMPT_STUCK_THRESHOLD,
  promptFingerprint,
  usePromptStuckCounter,
} from '@/hooks/usePromptStuckCounter';

function modelPicker(labels: string[] = ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.4']): Record<string, unknown> {
  return {
    type: 'multiple_choice',
    question: 'Select Model',
    status: 'pending',
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
  };
}

function yesNo(question = 'Proceed?'): Record<string, unknown> {
  return { type: 'yes_no', question, status: 'pending', options: ['yes', 'no'] };
}

describe('promptFingerprint', () => {
  it('is the same string for the same content', () => {
    expect(promptFingerprint(modelPicker())).toBe(promptFingerprint(modelPicker()));
    expect(promptFingerprint(yesNo())).toBe(promptFingerprint(yesNo()));
  });

  it('trims surrounding whitespace and nothing else', () => {
    const padded = { ...modelPicker(), question: '  Select Model \n' };
    expect(promptFingerprint(padded)).toBe(promptFingerprint(modelPicker()));
    const cased = { ...modelPicker(), question: 'select model' };
    expect(promptFingerprint(cased)).not.toBe(promptFingerprint(modelPicker()));
  });

  it('differs when one option label differs', () => {
    expect(promptFingerprint(modelPicker(['a', 'b', 'c']))).not.toBe(
      promptFingerprint(modelPicker(['a', 'b', 'd'])),
    );
  });

  it('differs by type and by question', () => {
    expect(promptFingerprint(yesNo('A?'))).not.toBe(promptFingerprint(yesNo('B?')));
    expect(promptFingerprint({ ...yesNo(), type: 'multiple_choice' })).not.toBe(promptFingerprint(yesNo()));
  });

  it('is null for no window and for a form without options', () => {
    expect(promptFingerprint(null)).toBeNull();
    expect(promptFingerprint(undefined)).toBeNull();
    expect(promptFingerprint({ type: 'unclassified', question: 'x', status: 'unclassified', options: [] })).toBeNull();
    expect(promptFingerprint({ type: 'unclassified', question: 'x', status: 'pending' })).toBeNull();
  });
});

describe('usePromptStuckCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial: unknown = modelPicker(), targetKey = 'wt:codex:codex') {
    return renderHook(
      ({ promptData, targetKey: key }: { promptData: unknown; targetKey: string }) =>
        usePromptStuckCounter({ promptData, targetKey: key }),
      { initialProps: { promptData: initial, targetKey } },
    );
  }

  it('counts 1 on the first display, and 0 with nothing shown', () => {
    const empty = setup(null);
    expect(empty.result.current.displayCount).toBe(0);
    expect(empty.result.current.showStuckHint).toBe(false);

    const { result } = setup();
    expect(result.current.displayCount).toBe(1);
    expect(result.current.showStuckHint).toBe(false);
  });

  it('goes 1 → 2 → 3 when the same window comes back after each Send, and hints at 3', () => {
    const { result, rerender } = setup();
    expect(PROMPT_STUCK_THRESHOLD).toBe(3);

    act(() => result.current.markSubmitted());
    // Not counted on the Send itself: the request is still in flight.
    expect(result.current.displayCount).toBe(1);
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(2);
    expect(result.current.showStuckHint).toBe(false);

    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(3);
    expect(result.current.showStuckHint).toBe(true);
  });

  it('does not count re-polls of the same window without a Send', () => {
    const { result, rerender } = setup();
    for (let i = 0; i < 5; i++) rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(1);
  });

  it('goes back to 1 when the window after a Send is a different one', () => {
    const { result, rerender } = setup();
    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(2);

    act(() => result.current.markSubmitted());
    rerender({ promptData: yesNo(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(1);
  });

  it('goes back to 1 when the window changes without a Send', () => {
    const { result, rerender } = setup();
    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(2);

    rerender({ promptData: modelPicker(['x', 'y']), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(1);
  });

  it('keeps counting when the window is gone for less than 10 seconds and the same one returns', () => {
    const { result, rerender } = setup();
    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(2);

    // A Send that "succeeded": the card clears, and the next poll brings it back.
    act(() => result.current.markSubmitted());
    rerender({ promptData: null, targetKey: 'wt:codex:codex' });
    act(() => {
      vi.advanceTimersByTime(PROMPT_STUCK_RESET_MS - 1);
    });
    expect(result.current.displayCount).toBe(2);
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(3);
    expect(result.current.showStuckHint).toBe(true);

    // The gap's timer was cancelled by the return.
    act(() => {
      vi.advanceTimersByTime(PROMPT_STUCK_RESET_MS * 2);
    });
    expect(result.current.displayCount).toBe(3);
  });

  it('resets to 0 when the window stays gone for 10 seconds', () => {
    const { result, rerender } = setup();
    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(2);

    rerender({ promptData: null, targetKey: 'wt:codex:codex' });
    act(() => {
      vi.advanceTimersByTime(PROMPT_STUCK_RESET_MS);
    });
    expect(result.current.displayCount).toBe(0);
    expect(result.current.showStuckHint).toBe(false);

    // And the same window afterwards is a first display again.
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(1);
  });

  it('resets to 0 when the target changes', () => {
    const { result, rerender } = setup();
    const same = modelPicker();
    act(() => result.current.markSubmitted());
    rerender({ promptData: same, targetKey: 'wt:codex:codex' });
    act(() => result.current.markSubmitted());
    rerender({ promptData: modelPicker(), targetKey: 'wt:codex:codex' });
    expect(result.current.displayCount).toBe(3);

    const kept = modelPicker();
    rerender({ promptData: kept, targetKey: 'wt:codex:codex' });
    rerender({ promptData: kept, targetKey: 'wt:claude:claude' });
    expect(result.current.displayCount).toBe(0);
    expect(result.current.showStuckHint).toBe(false);
  });
});
