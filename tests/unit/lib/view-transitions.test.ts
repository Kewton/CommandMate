/**
 * Tests for the View Transitions guard utilities (Issue #1122).
 *
 * jsdom implements neither `document.startViewTransition` nor
 * `window.matchMedia`, so both are stubbed to exercise the feature-detection
 * guard, the reduced-motion opt-out, and the instant-navigation fallback.
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prefersReducedMotion,
  startViewTransition,
  supportsViewTransitions,
  type ViewTransitionLike,
} from '@/lib/view-transitions';

// lib.dom types startViewTransition as a required method; re-declare it optional
// so the feature-absent path (`delete`) and the fake stub are expressible.
type MutableVTDoc = Omit<Document, 'startViewTransition'> & {
  startViewTransition?: (cb: () => void | Promise<void>) => unknown;
};

const doc = document as unknown as MutableVTDoc;

/** A resolved fake ViewTransition, matching the browser API's promise surface. */
function fakeTransition(): ViewTransitionLike {
  return {
    finished: Promise.resolve(),
    ready: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    skipTransition: vi.fn(),
  };
}

/** Stub `window.matchMedia` so the reduced-motion query returns `reduced`. */
function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('view-transitions guard', () => {
  beforeEach(() => {
    stubReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete doc.startViewTransition;
  });

  describe('supportsViewTransitions', () => {
    it('returns true when document.startViewTransition is a function', () => {
      doc.startViewTransition = vi.fn();
      expect(supportsViewTransitions()).toBe(true);
    });

    it('returns false when the API is absent', () => {
      delete doc.startViewTransition;
      expect(supportsViewTransitions()).toBe(false);
    });
  });

  describe('prefersReducedMotion', () => {
    it('is true when the reduce-motion media query matches', () => {
      stubReducedMotion(true);
      expect(prefersReducedMotion()).toBe(true);
    });

    it('is false when it does not match', () => {
      stubReducedMotion(false);
      expect(prefersReducedMotion()).toBe(false);
    });
  });

  describe('startViewTransition', () => {
    it('wraps the update in document.startViewTransition when supported and motion is allowed', () => {
      const update = vi.fn();
      const svt = vi.fn((cb: () => void | Promise<void>) => {
        void cb();
        return fakeTransition();
      });
      doc.startViewTransition = svt;

      const result = startViewTransition(update);

      expect(svt).toHaveBeenCalledTimes(1);
      expect(svt).toHaveBeenCalledWith(update);
      expect(update).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
    });

    it('falls back to running the update immediately when the API is unavailable', () => {
      delete doc.startViewTransition;
      const update = vi.fn();

      let result: ViewTransitionLike | null = null;
      expect(() => {
        result = startViewTransition(update);
      }).not.toThrow();

      expect(update).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('is disabled under prefers-reduced-motion — skips startViewTransition, runs the update immediately', () => {
      stubReducedMotion(true);
      const svt = vi.fn();
      doc.startViewTransition = svt;
      const update = vi.fn();

      const result = startViewTransition(update);

      expect(svt).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });
  });
});
