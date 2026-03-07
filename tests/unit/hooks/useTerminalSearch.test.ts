/**
 * useTerminalSearch Hook Tests
 * [Issue #47] Terminal text search functionality
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSearch } from '@/hooks/useTerminalSearch';
import type React from 'react';

describe('useTerminalSearch', () => {
  let containerRef: React.RefObject<HTMLDivElement>;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    containerRef = { current: container } as React.RefObject<HTMLDivElement>;

    // Mock CSS.highlights
    const mockHighlightsMap = {
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
    };
    Object.defineProperty(globalThis, 'CSS', {
      value: { highlights: mockHighlightsMap },
      writable: true,
      configurable: true,
    });
    // Mock Highlight constructor (must be a proper constructor for `new Highlight(...)`)
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
    if (document.body.contains(container)) {
      document.body.removeChild(container);
    }
  });

  // ============================================================================
  // Initial State
  // ============================================================================

  describe('Initial State', () => {
    it('should have isOpen=false initially', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      expect(result.current.isOpen).toBe(false);
    });

    it('should have matchCount=0 initially', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      expect(result.current.matchCount).toBe(0);
    });

    it('should have currentIndex=0 initially', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      expect(result.current.currentIndex).toBe(0);
    });

    it('should have empty query initially', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      expect(result.current.query).toBe('');
    });
  });

  // ============================================================================
  // openSearch / closeSearch
  // ============================================================================

  describe('openSearch / closeSearch', () => {
    it('should set isOpen=true when openSearch is called', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
      });
      expect(result.current.isOpen).toBe(true);
    });

    it('should set isOpen=false when closeSearch is called', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
      });
      act(() => {
        result.current.closeSearch();
      });
      expect(result.current.isOpen).toBe(false);
    });

    it('should clear query when closeSearch is called', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        result.current.closeSearch();
      });
      expect(result.current.query).toBe('');
    });

    it('should reset matchCount when closeSearch is called', () => {
      container.textContent = 'hello world hello';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      act(() => {
        result.current.closeSearch();
      });
      expect(result.current.matchCount).toBe(0);
    });
  });

  // ============================================================================
  // findMatches - minimum 2 chars (SEC-TS-004)
  // ============================================================================

  describe('findMatches - minimum 2 chars (SEC-TS-004)', () => {
    it('should not find matches for 1-character query', () => {
      container.textContent = 'hello world';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('h');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBe(0);
    });

    it('should not find matches for empty query', () => {
      container.textContent = 'hello world';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBe(0);
    });

    it('should find matches for 2-character query', () => {
      container.textContent = 'hello world hello';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('he');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBeGreaterThan(0);
    });

    it('should find correct number of matches for multi-char query', () => {
      container.textContent = 'hello world hello';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBe(2);
    });
  });

  // ============================================================================
  // Case-insensitive search
  // ============================================================================

  describe('Case-insensitive search', () => {
    it('should match regardless of case', () => {
      container.textContent = 'Hello HELLO hello';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'Hello HELLO hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBe(3);
    });
  });

  // ============================================================================
  // Max matches cap (TERMINAL_SEARCH_MAX_MATCHES = 500)
  // ============================================================================

  describe('Max matches cap', () => {
    it('should not exceed 500 matches', () => {
      const text = 'ab '.repeat(600);
      container.textContent = text;
      const { result } = renderHook(() =>
        useTerminalSearch({ output: text, containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('ab');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.matchCount).toBeLessThanOrEqual(500);
    });

    it('should set isAtMaxMatches when limit is reached', () => {
      const text = 'ab '.repeat(600);
      container.textContent = text;
      const { result } = renderHook(() =>
        useTerminalSearch({ output: text, containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('ab');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.isAtMaxMatches).toBe(true);
    });
  });

  // ============================================================================
  // nextMatch / prevMatch navigation
  // ============================================================================

  describe('nextMatch / prevMatch', () => {
    beforeEach(() => {
      container.textContent = 'hello world hello foo hello';
    });

    it('should advance currentIndex with nextMatch', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello foo hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      act(() => {
        result.current.nextMatch();
      });
      expect(result.current.currentIndex).toBe(1);
    });

    it('should wrap around to 0 at the end with nextMatch', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello foo hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // Advance past last match (matchCount=3, so indices 0,1,2)
      act(() => {
        result.current.nextMatch(); // 1
        result.current.nextMatch(); // 2
        result.current.nextMatch(); // wraps to 0
      });
      expect(result.current.currentIndex).toBe(0);
    });

    it('should go backwards with prevMatch', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello foo hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // prevMatch from 0 should wrap to last (index 2)
      act(() => {
        result.current.prevMatch();
      });
      expect(result.current.currentIndex).toBe(2);
    });

    it('should not change currentIndex when matchCount is 0', () => {
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello foo hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
      });
      act(() => {
        result.current.nextMatch();
      });
      expect(result.current.currentIndex).toBe(0);
    });
  });

  // ============================================================================
  // Debounce
  // ============================================================================

  describe('Debounce (300ms)', () => {
    it('should debounce search by 300ms', () => {
      container.textContent = 'hello world hello';
      const { result } = renderHook(() =>
        useTerminalSearch({ output: 'hello world hello', containerRef })
      );
      act(() => {
        result.current.openSearch();
        result.current.setQuery('hello');
      });
      // Before debounce: no matches yet
      expect(result.current.matchCount).toBe(0);

      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(result.current.matchCount).toBe(0);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.matchCount).toBe(2);
    });
  });
});
