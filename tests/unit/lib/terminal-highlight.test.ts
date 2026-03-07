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
});
