/**
 * Tests for usePendingInsertText hook (Issue #755, TODO:D1-001)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePendingInsertText } from '@/hooks/usePendingInsertText';

describe('usePendingInsertText', () => {
  it('initializes with an empty map, null pendingInsertText, focusedSplitIndex=0', () => {
    const { result } = renderHook(() => usePendingInsertText());
    expect(result.current.pendingInsertTextMap.size).toBe(0);
    expect(result.current.pendingInsertText).toBeNull();
    expect(result.current.focusedSplitIndex).toBe(0);
  });

  describe('handleInsertToMessage (focused split routing)', () => {
    it('inserts into the focused split (default 0)', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.handleInsertToMessage('hello');
      });
      expect(result.current.pendingInsertTextMap.get(0)).toBe('hello');
      // splitIndex=0 compat helper reflects the same value.
      expect(result.current.pendingInsertText).toBe('hello');
    });

    it('follows focusedSplitIndex after it changes', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.setFocusedSplitIndex(1);
      });
      expect(result.current.focusedSplitIndex).toBe(1);
      act(() => {
        result.current.handleInsertToMessage('to-split-1');
      });
      expect(result.current.pendingInsertTextMap.get(1)).toBe('to-split-1');
      // split 0 untouched
      expect(result.current.pendingInsertTextMap.get(0) ?? null).toBeNull();
      expect(result.current.pendingInsertText).toBeNull();
    });
  });

  describe('handleInsertToSplit (explicit split routing, S3-005)', () => {
    it('inserts into an explicit split index regardless of focus', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.handleInsertToSplit(2, 'explicit');
      });
      expect(result.current.pendingInsertTextMap.get(2)).toBe('explicit');
      // focusedSplitIndex unchanged
      expect(result.current.focusedSplitIndex).toBe(0);
    });

    it('keeps independent text per split', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.handleInsertToSplit(0, 'a');
        result.current.handleInsertToSplit(1, 'b');
      });
      expect(result.current.pendingInsertTextMap.get(0)).toBe('a');
      expect(result.current.pendingInsertTextMap.get(1)).toBe('b');
    });
  });

  describe('handleInsertConsumed', () => {
    it('removes the pending text for a given split index', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.handleInsertToSplit(1, 'x');
      });
      expect(result.current.pendingInsertTextMap.get(1)).toBe('x');
      act(() => {
        result.current.handleInsertConsumed(1);
      });
      expect(result.current.pendingInsertTextMap.has(1)).toBe(false);
    });

    it('is a no-op (same reference) when the index is not present', () => {
      const { result } = renderHook(() => usePendingInsertText());
      const before = result.current.pendingInsertTextMap;
      act(() => {
        result.current.handleInsertConsumed(5);
      });
      // No state change => same map reference (avoids needless re-render).
      expect(result.current.pendingInsertTextMap).toBe(before);
    });
  });

  describe('handleInsertConsumedSingle (splitIndex=0 compat)', () => {
    it('clears splitIndex=0 pending text', () => {
      const { result } = renderHook(() => usePendingInsertText());
      act(() => {
        result.current.handleInsertToMessage('mobile-text');
      });
      expect(result.current.pendingInsertText).toBe('mobile-text');
      act(() => {
        result.current.handleInsertConsumedSingle();
      });
      expect(result.current.pendingInsertText).toBeNull();
      expect(result.current.pendingInsertTextMap.has(0)).toBe(false);
    });
  });

  describe('handler reference stability', () => {
    it('keeps handleInsertToSplit / handleInsertConsumed / handleInsertConsumedSingle stable across rerenders', () => {
      const { result, rerender } = renderHook(() => usePendingInsertText());
      const first = {
        handleInsertToSplit: result.current.handleInsertToSplit,
        handleInsertConsumed: result.current.handleInsertConsumed,
        handleInsertConsumedSingle: result.current.handleInsertConsumedSingle,
        setFocusedSplitIndex: result.current.setFocusedSplitIndex,
      };
      rerender();
      expect(result.current.handleInsertToSplit).toBe(first.handleInsertToSplit);
      expect(result.current.handleInsertConsumed).toBe(first.handleInsertConsumed);
      expect(result.current.handleInsertConsumedSingle).toBe(first.handleInsertConsumedSingle);
      expect(result.current.setFocusedSplitIndex).toBe(first.setFocusedSplitIndex);
    });

    it('recreates handleInsertToMessage only when focusedSplitIndex changes', () => {
      const { result, rerender } = renderHook(() => usePendingInsertText());
      const firstInsertToMessage = result.current.handleInsertToMessage;
      // rerender without changing focus -> stable
      rerender();
      expect(result.current.handleInsertToMessage).toBe(firstInsertToMessage);
      // changing focus -> new reference (closes over focusedSplitIndex)
      act(() => {
        result.current.setFocusedSplitIndex(1);
      });
      expect(result.current.handleInsertToMessage).not.toBe(firstInsertToMessage);
    });
  });
});
