/**
 * useHistorySearch Hook Tests
 * [Issue #716] History text search functionality
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistorySearch } from '@/hooks/useHistorySearch';
import type { ChatMessage } from '@/types/models';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2)}`,
    worktreeId: 'wt-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? new Date(0),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

describe('useHistorySearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // [DR2-007] Match terminal-highlight.test.ts mock pattern.
    Object.defineProperty(globalThis, 'CSS', {
      value: { highlights: { set: vi.fn(), delete: vi.fn(), has: vi.fn() } },
      writable: true,
      configurable: true,
    });
    function MockHighlight(..._args: unknown[]) { return {}; }
    Object.defineProperty(globalThis, 'Highlight', {
      value: MockHighlight,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial state
  // ============================================================================

  describe('initial state', () => {
    it('starts closed with no matches', () => {
      const { result } = renderHook(() => useHistorySearch({ messages: [] }));
      expect(result.current.isOpen).toBe(false);
      expect(result.current.query).toBe('');
      expect(result.current.matchCount).toBe(0);
      expect(result.current.currentIndex).toBe(0);
      expect(result.current.isAtMaxMatches).toBe(false);
      expect(result.current.matchPositions).toEqual([]);
      expect(result.current.currentMatch).toBeNull();
    });
  });

  // ============================================================================
  // open/close
  // ============================================================================

  describe('openSearch / closeSearch', () => {
    it('opens the search', () => {
      const { result } = renderHook(() => useHistorySearch({ messages: [] }));
      act(() => { result.current.openSearch(); });
      expect(result.current.isOpen).toBe(true);
    });

    it('closing clears query, matches, and currentIndex', () => {
      const messages = [makeMessage({ content: 'hello world' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.openSearch(); });
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBeGreaterThan(0);

      act(() => { result.current.closeSearch(); });
      expect(result.current.isOpen).toBe(false);
      expect(result.current.query).toBe('');
      expect(result.current.matchCount).toBe(0);
      expect(result.current.matchPositions).toEqual([]);
      expect(result.current.currentIndex).toBe(0);
      expect(result.current.currentMatch).toBeNull();
    });
  });

  // ============================================================================
  // matching
  // ============================================================================

  describe('findMatches (via setQuery + debounce)', () => {
    it('returns no matches for queries shorter than 2 chars', () => {
      const messages = [makeMessage({ content: 'aaaa' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('a'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(0);
    });

    it('finds case-insensitive matches across messages', () => {
      const messages = [
        makeMessage({ id: 'm1', content: 'Hello world' }),
        makeMessage({ id: 'm2', content: 'hELLO again' }),
      ];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(2);
      // matchPositions grouped per messageId
      const ids = result.current.matchPositions.map((m) => m.messageId);
      expect(ids).toContain('m1');
      expect(ids).toContain('m2');
    });

    it('finds multiple matches within a single message', () => {
      const messages = [makeMessage({ id: 'm1', content: 'foo foo foo' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('foo'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(3);
      expect(result.current.matchPositions).toHaveLength(1);
      expect(result.current.matchPositions[0].ranges).toHaveLength(3);
    });

    it('returns no matches when messages do not contain the query', () => {
      const messages = [makeMessage({ content: 'abc def' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('zzz'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(0);
      expect(result.current.currentMatch).toBeNull();
    });
  });

  // ============================================================================
  // currentMatch resolution
  // ============================================================================

  describe('currentMatch', () => {
    it('resolves global index to {messageId, localIndex}', () => {
      const messages = [
        makeMessage({ id: 'm1', content: 'foo bar foo' }),  // 2 hits
        makeMessage({ id: 'm2', content: 'foo' }),            // 1 hit
      ];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('foo'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(3);
      expect(result.current.currentMatch).toEqual({ messageId: 'm1', localIndex: 0 });

      act(() => { result.current.nextMatch(); });
      expect(result.current.currentMatch).toEqual({ messageId: 'm1', localIndex: 1 });

      act(() => { result.current.nextMatch(); });
      expect(result.current.currentMatch).toEqual({ messageId: 'm2', localIndex: 0 });
    });
  });

  // ============================================================================
  // navigation wraparound
  // ============================================================================

  describe('nextMatch / prevMatch wraparound', () => {
    it('wraps from last to first via nextMatch', () => {
      const messages = [makeMessage({ id: 'm1', content: 'aa aa' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('aa'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(2);
      act(() => { result.current.nextMatch(); });
      act(() => { result.current.nextMatch(); });
      expect(result.current.currentIndex).toBe(0);
    });

    it('wraps from first to last via prevMatch', () => {
      const messages = [makeMessage({ id: 'm1', content: 'aa aa' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('aa'); });
      act(() => { vi.advanceTimersByTime(300); });
      act(() => { result.current.prevMatch(); });
      expect(result.current.currentIndex).toBe(1);
    });

    it('no-ops when matchCount is 0', () => {
      const { result } = renderHook(() => useHistorySearch({ messages: [] }));
      act(() => { result.current.nextMatch(); });
      act(() => { result.current.prevMatch(); });
      expect(result.current.currentIndex).toBe(0);
    });
  });

  // ============================================================================
  // debounce
  // ============================================================================

  describe('debounce', () => {
    it('does not search before 300ms elapsed', () => {
      const messages = [makeMessage({ content: 'hello' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(200); });
      expect(result.current.matchCount).toBe(0);
    });

    it('runs search after 300ms', () => {
      const messages = [makeMessage({ content: 'hello' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(1);
    });

    it('resets timer on consecutive setQuery calls', () => {
      const messages = [makeMessage({ content: 'abc' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('ab'); });
      act(() => { vi.advanceTimersByTime(200); });
      act(() => { result.current.setQuery('abc'); });
      act(() => { vi.advanceTimersByTime(200); });
      // 400ms passed total but each call reset the timer
      expect(result.current.matchCount).toBe(0);
      act(() => { vi.advanceTimersByTime(100); });
      expect(result.current.matchCount).toBe(1);
    });
  });

  // ============================================================================
  // IME composition
  // ============================================================================

  describe('IME composition', () => {
    it('does NOT trigger search while composition is active', () => {
      const messages = [makeMessage({ content: 'こんにちは' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.onCompositionStart(); });
      act(() => { result.current.setQuery('こん'); });
      // Even after the debounce window, no search should have run.
      act(() => { vi.advanceTimersByTime(500); });
      expect(result.current.matchCount).toBe(0);
    });

    it('triggers search after compositionend', () => {
      const messages = [makeMessage({ content: 'こんにちは' })];
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.onCompositionStart(); });
      act(() => { result.current.setQuery('こん'); });
      act(() => { vi.advanceTimersByTime(500); });
      expect(result.current.matchCount).toBe(0);

      act(() => { result.current.onCompositionEnd(); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(1);
    });
  });

  // ============================================================================
  // 500-cap
  // ============================================================================

  describe('max matches', () => {
    it('caps at 500 matches and reports isAtMaxMatches=true', () => {
      // 600 single-char "a" messages, each with one "aa" match impossible (single char),
      // so build longer messages.
      const messages = Array.from({ length: 600 }, (_, i) =>
        makeMessage({ id: `m${i}`, content: 'aa' })
      );
      const { result } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('aa'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(500);
      expect(result.current.isAtMaxMatches).toBe(true);
    });
  });

  // ============================================================================
  // cleanup
  // ============================================================================

  describe('cleanup', () => {
    it('clears query / matchPositions on unmount', () => {
      const messages = [makeMessage({ content: 'hello' })];
      const { result, unmount } = renderHook(() => useHistorySearch({ messages }));
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current.matchCount).toBe(1);
      // Unmount should not throw and any pending debounce timer should be cleared.
      expect(() => unmount()).not.toThrow();
    });
  });

  // ============================================================================
  // re-computation suppression
  // ============================================================================

  describe('memoization', () => {
    it('does not re-run search when messages array changes by identity but length/last-id/last-timestamp are stable', () => {
      const ts = new Date(1000);
      const m1 = makeMessage({ id: 'm1', content: 'hello', timestamp: ts });

      const { result, rerender } = renderHook(
        ({ messages }: { messages: ChatMessage[] }) => useHistorySearch({ messages }),
        { initialProps: { messages: [m1] } }
      );
      act(() => { result.current.setQuery('hello'); });
      act(() => { vi.advanceTimersByTime(300); });
      const firstMatchPositions = result.current.matchPositions;

      // New array reference, but same content fingerprint (length + last id/timestamp)
      const m1Copy = makeMessage({ id: 'm1', content: 'hello', timestamp: ts });
      rerender({ messages: [m1Copy] });

      // Without re-running search, matchPositions reference should be preserved.
      expect(result.current.matchPositions).toBe(firstMatchPositions);
    });
  });
});
