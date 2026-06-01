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
  makeHistoryNamespace,
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

  // ============================================================================
  // [Issue #744] makeHistoryNamespace (per-split namespace isolation)
  // ============================================================================

  describe('makeHistoryNamespace (Issue #744)', () => {
    it('returns a namespace whose names are suffixed with the splitIndex', () => {
      const ns0: HighlightNamespace = makeHistoryNamespace(0);
      expect(ns0.highlightName).toBe('history-search-0');
      expect(ns0.currentHighlightName).toBe('history-search-current-0');
      expect(ns0.fallbackOverlayId).toBe('history-search-fallback-overlay-0');
      expect(typeof ns0.fallbackOverlayBgColor).toBe('string');
      expect(ns0.fallbackOverlayBgColor.length).toBeGreaterThan(0);
    });

    it('produces distinct names for different split indices', () => {
      const ns0 = makeHistoryNamespace(0);
      const ns1 = makeHistoryNamespace(1);
      const ns2 = makeHistoryNamespace(2);

      expect(ns0.highlightName).not.toBe(ns1.highlightName);
      expect(ns1.highlightName).not.toBe(ns2.highlightName);
      expect(ns0.currentHighlightName).not.toBe(ns1.currentHighlightName);
      expect(ns0.fallbackOverlayId).not.toBe(ns1.fallbackOverlayId);
      expect(ns1.fallbackOverlayId).not.toBe(ns2.fallbackOverlayId);
    });

    it('reuses the same blue fallback color as the legacy history namespace', () => {
      expect(makeHistoryNamespace(0).fallbackOverlayBgColor).toBe(
        HISTORY_SEARCH_NAMESPACE.fallbackOverlayBgColor
      );
    });

    it('differs from the legacy global HISTORY_SEARCH_NAMESPACE names', () => {
      const ns0 = makeHistoryNamespace(0);
      expect(ns0.highlightName).not.toBe(HISTORY_SEARCH_NAMESPACE.highlightName);
      expect(ns0.currentHighlightName).not.toBe(
        HISTORY_SEARCH_NAMESPACE.currentHighlightName
      );
      expect(ns0.fallbackOverlayId).not.toBe(
        HISTORY_SEARCH_NAMESPACE.fallbackOverlayId
      );
    });

    it('applying split 0 highlights does not clobber split 1 highlights (CSS.highlights set keys differ)', () => {
      const store = new Map<string, unknown>();
      const mockSet = vi.fn((name: string, value: unknown) => store.set(name, value));
      const mockDelete = vi.fn((name: string) => store.delete(name));
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

      const container0 = document.createElement('div');
      container0.textContent = 'aaa bbb';
      const container1 = document.createElement('div');
      container1.textContent = 'aaa bbb';

      // Split 1 applies its highlights first.
      applyHistoryHighlights(container1, [{ start: 0, end: 3 }], 0, makeHistoryNamespace(1));
      // Then split 0 applies its highlights. It must NOT remove split 1's entry.
      applyHistoryHighlights(container0, [{ start: 4, end: 7 }], 0, makeHistoryNamespace(0));

      // Both namespaces coexist in the registry.
      expect(store.has('history-search-1')).toBe(true);
      expect(store.has('history-search-0')).toBe(true);
    });

    it('clearing one split namespace does not touch the other split namespace', () => {
      const mockDelete = vi.fn();
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { delete: mockDelete } },
        writable: true,
        configurable: true,
      });

      clearHistoryHighlights(makeHistoryNamespace(0));
      // Only split-0 names are deleted.
      expect(mockDelete).toHaveBeenCalledWith('history-search-0');
      expect(mockDelete).toHaveBeenCalledWith('history-search-current-0');
      expect(mockDelete).not.toHaveBeenCalledWith('history-search-1');
      expect(mockDelete).not.toHaveBeenCalledWith('history-search-current-1');
    });
  });

  // ============================================================================
  // [Issue #744] applyHistoryHighlights / clearHistoryHighlights backward compat
  // ============================================================================

  describe('history highlight backward compatibility (Issue #744)', () => {
    it('applyHistoryHighlights with no namespace arg still uses the legacy history-search name', () => {
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
      container.textContent = 'hello world';
      applyHistoryHighlights(container, [{ start: 0, end: 5 }], 0);
      const setCallNames = mockSet.mock.calls.map((c) => c[0]);
      expect(setCallNames).toContain('history-search');
      expect(setCallNames).not.toContain('history-search-0');
    });

    it('clearHistoryHighlights with no namespace arg still clears the legacy history-search name', () => {
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
  });
});
