/**
 * Tests for terminal-highlight.ts
 * CSS Custom Highlight API wrapper functions
 * [Issue #47] Terminal text search
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCSSHighlightSupported,
  applyTerminalHighlights,
  clearTerminalHighlights,
  applyHistoryHighlights,
  clearHistoryHighlights,
  HISTORY_SEARCH_NAMESPACE,
  type HighlightNamespace,
} from '@/lib/terminal-highlight';

describe('terminal-highlight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // isCSSHighlightSupported
  // ============================================================================

  describe('isCSSHighlightSupported', () => {
    it('should return true when CSS.highlights is available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: new Map() },
        writable: true,
        configurable: true,
      });
      expect(isCSSHighlightSupported()).toBe(true);
    });

    it('should return false when CSS is not available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(isCSSHighlightSupported()).toBe(false);
    });

    it('should return false when CSS.highlights is not available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: {},
        writable: true,
        configurable: true,
      });
      expect(isCSSHighlightSupported()).toBe(false);
    });
  });

  // ============================================================================
  // clearTerminalHighlights
  // ============================================================================

  describe('clearTerminalHighlights', () => {
    it('should call CSS.highlights.delete for terminal-search', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      clearTerminalHighlights();
      expect(mockDelete).toHaveBeenCalledWith('terminal-search');
    });

    it('should call CSS.highlights.delete for terminal-search-current', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      clearTerminalHighlights();
      expect(mockDelete).toHaveBeenCalledWith('terminal-search-current');
    });

    it('should not throw when CSS is not available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(() => clearTerminalHighlights()).not.toThrow();
    });

    it('should not throw when CSS.highlights is not available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: {},
        writable: true,
        configurable: true,
      });
      expect(() => clearTerminalHighlights()).not.toThrow();
    });
  });

  // ============================================================================
  // applyTerminalHighlights
  // ============================================================================

  describe('applyTerminalHighlights', () => {
    it('should not throw when CSS Highlight API is not supported', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello world';
      expect(() =>
        applyTerminalHighlights(container, [{ start: 0, end: 5 }], 0)
      ).not.toThrow();
    });

    it('should not throw when matchPositions is empty', () => {
      const mockSet = vi.fn();
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { set: mockSet, delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello';
      expect(() => applyTerminalHighlights(container, [], 0)).not.toThrow();
    });

    it('should not throw with valid match positions', () => {
      const mockSet = vi.fn();
      const mockDelete = vi.fn();
      // Mock Highlight constructor (must be a proper class/function for `new`)
      function MockHighlight(..._args: unknown[]) { return {}; }
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { set: mockSet, delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'Highlight', {
        value: MockHighlight,
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello world';
      expect(() =>
        applyTerminalHighlights(container, [{ start: 0, end: 5 }], 0)
      ).not.toThrow();
    });
  });

  // ============================================================================
  // [Issue #716] HISTORY_SEARCH_NAMESPACE
  // ============================================================================

  describe('HISTORY_SEARCH_NAMESPACE', () => {
    it('should be a HighlightNamespace with history-search names', () => {
      const ns: HighlightNamespace = HISTORY_SEARCH_NAMESPACE;
      expect(ns.highlightName).toBe('history-search');
      expect(ns.currentHighlightName).toBe('history-search-current');
      expect(ns.fallbackOverlayId).toBe('history-search-fallback-overlay');
      expect(typeof ns.fallbackOverlayBgColor).toBe('string');
      expect(ns.fallbackOverlayBgColor.length).toBeGreaterThan(0);
    });

    it('should use a distinct fallback color from the terminal namespace', () => {
      // Terminal uses an orange tone (255,165,0); history must differ visibly.
      expect(HISTORY_SEARCH_NAMESPACE.fallbackOverlayBgColor).not.toBe(
        'rgba(255, 165, 0, 0.6)'
      );
    });
  });

  // ============================================================================
  // [Issue #716] clearHistoryHighlights
  // ============================================================================

  describe('clearHistoryHighlights', () => {
    it('should delete history-search namespace from CSS.highlights', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      clearHistoryHighlights();
      expect(mockDelete).toHaveBeenCalledWith('history-search');
      expect(mockDelete).toHaveBeenCalledWith('history-search-current');
    });

    it('should NOT delete terminal-search namespace', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      clearHistoryHighlights();
      expect(mockDelete).not.toHaveBeenCalledWith('terminal-search');
      expect(mockDelete).not.toHaveBeenCalledWith('terminal-search-current');
    });

    it('should remove fallback overlay element with history-search id', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const overlay = document.createElement('div');
      overlay.id = 'history-search-fallback-overlay';
      document.body.appendChild(overlay);
      clearHistoryHighlights();
      expect(document.getElementById('history-search-fallback-overlay')).toBeNull();
    });

    it('should not throw when CSS is not available', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(() => clearHistoryHighlights()).not.toThrow();
    });
  });

  // ============================================================================
  // [Issue #716] applyHistoryHighlights
  // ============================================================================

  describe('applyHistoryHighlights', () => {
    it('should call CSS.highlights.set with the history-search name', () => {
      const mockSet = vi.fn();
      const mockDelete = vi.fn();
      function MockHighlight(..._args: unknown[]) { return {}; }
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { set: mockSet, delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'Highlight', {
        value: MockHighlight,
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello world hello';
      applyHistoryHighlights(
        container,
        [
          { start: 0, end: 5 },
          { start: 12, end: 17 },
        ],
        0
      );
      // The non-current matches are aggregated under the namespace name.
      const setCallNames = mockSet.mock.calls.map((c) => c[0]);
      expect(setCallNames).toContain('history-search');
      expect(setCallNames).not.toContain('terminal-search');
    });

    it('should clear when matchPositions is empty', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello';
      applyHistoryHighlights(container, [], 0);
      expect(mockDelete).toHaveBeenCalledWith('history-search');
    });

    it('should not throw when CSS API is unavailable', () => {
      Object.defineProperty(globalThis, 'CSS', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const container = document.createElement('div');
      container.textContent = 'hello world';
      expect(() =>
        applyHistoryHighlights(container, [{ start: 0, end: 5 }], 0)
      ).not.toThrow();
    });

    it('should coexist with applyTerminalHighlights (different namespaces)', () => {
      const mockSet = vi.fn();
      const mockDelete = vi.fn();
      function MockHighlight(..._args: unknown[]) { return {}; }
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { set: mockSet, delete: mockDelete } },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'Highlight', {
        value: MockHighlight,
        writable: true,
        configurable: true,
      });
      const containerT = document.createElement('div');
      containerT.textContent = 'aaa bbb';
      const containerH = document.createElement('div');
      containerH.textContent = 'aaa bbb';
      applyTerminalHighlights(containerT, [{ start: 0, end: 3 }], 0);
      applyHistoryHighlights(containerH, [{ start: 4, end: 7 }], 0);

      const setNamespaces = mockSet.mock.calls.map((c) => c[0]);
      expect(setNamespaces).toContain('terminal-search');
      expect(setNamespaces).toContain('history-search');

      // clearing history must not touch terminal-search names
      mockDelete.mockClear();
      clearHistoryHighlights();
      expect(mockDelete).not.toHaveBeenCalledWith('terminal-search');
      expect(mockDelete).not.toHaveBeenCalledWith('terminal-search-current');
    });
  });
});
