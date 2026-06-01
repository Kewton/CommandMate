/**
 * Unit tests for browser-compat fullscreen-api shims
 *
 * Verifies the vendor-prefix fallback branches (webkit/moz/ms) of each compat
 * function. JSDOM does not define the legacy prefixed Fullscreen API surface,
 * so we mock them with `Object.defineProperty(document/element, ...)` and clean
 * up (delete) in afterEach to avoid cross-test leakage.
 *
 * SSR guard note: `typeof document === 'undefined'` cannot be exercised
 * directly under JSDOM (document is always defined). The functions are written
 * defensively for the SSR path; behavior parity with the original
 * useFullscreen.ts is covered by the hook's existing tests + the branch tests
 * below.
 *
 * @module tests/unit/lib/browser-compat/fullscreen-api
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFullscreenSupportedCompat,
  getFullscreenElementCompat,
  requestFullscreenCompat,
  exitFullscreenCompat,
  addFullscreenChangeListenerCompat,
} from '@/lib/browser-compat/fullscreen-api';

/**
 * Define a (possibly prefixed) property on a target, tracking it for cleanup.
 */
function defineProp(
  target: object,
  key: string,
  value: unknown,
  registry: Array<{ target: object; key: string }>
): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
  registry.push({ target, key });
}

describe('browser-compat/fullscreen-api', () => {
  // Track every property we add so afterEach can remove it.
  const defined: Array<{ target: object; key: string }> = [];

  afterEach(() => {
    while (defined.length > 0) {
      const entry = defined.pop();
      if (entry) {
        // delete restores JSDOM's "undefined" default for prefixed props.
        delete (entry.target as Record<string, unknown>)[entry.key];
      }
    }
    vi.clearAllMocks();
  });

  describe('requestFullscreenCompat', () => {
    it('calls the standard element.requestFullscreen when available', async () => {
      const standard = vi.fn().mockResolvedValue(undefined);
      const element = document.createElement('div');
      defineProp(element, 'requestFullscreen', standard, defined);

      await requestFullscreenCompat(element);

      expect(standard).toHaveBeenCalledTimes(1);
    });

    it('falls back to webkitRequestFullscreen when only webkit prefix exists', async () => {
      const webkit = vi.fn().mockResolvedValue(undefined);
      const element = document.createElement('div');
      // Ensure standard API is absent on this element.
      defineProp(element, 'requestFullscreen', undefined, defined);
      defineProp(element, 'webkitRequestFullscreen', webkit, defined);

      await requestFullscreenCompat(element);

      expect(webkit).toHaveBeenCalledTimes(1);
    });

    it('falls back to mozRequestFullScreen when only moz prefix exists', async () => {
      const moz = vi.fn().mockResolvedValue(undefined);
      const element = document.createElement('div');
      defineProp(element, 'requestFullscreen', undefined, defined);
      defineProp(element, 'mozRequestFullScreen', moz, defined);

      await requestFullscreenCompat(element);

      expect(moz).toHaveBeenCalledTimes(1);
    });

    it('falls back to msRequestFullscreen when only ms prefix exists', async () => {
      const ms = vi.fn().mockResolvedValue(undefined);
      const element = document.createElement('div');
      defineProp(element, 'requestFullscreen', undefined, defined);
      defineProp(element, 'msRequestFullscreen', ms, defined);

      await requestFullscreenCompat(element);

      expect(ms).toHaveBeenCalledTimes(1);
    });

    it('throws "Fullscreen API not supported" when no API is present', async () => {
      const element = document.createElement('div');
      defineProp(element, 'requestFullscreen', undefined, defined);

      await expect(requestFullscreenCompat(element)).rejects.toThrow(
        'Fullscreen API not supported'
      );
    });
  });

  describe('exitFullscreenCompat', () => {
    it('calls the standard document.exitFullscreen when available', async () => {
      const standard = vi.fn().mockResolvedValue(undefined);
      defineProp(document, 'exitFullscreen', standard, defined);

      await exitFullscreenCompat();

      expect(standard).toHaveBeenCalledTimes(1);
    });

    it('falls back to webkitExitFullscreen when only webkit prefix exists', async () => {
      const webkit = vi.fn().mockResolvedValue(undefined);
      defineProp(document, 'exitFullscreen', undefined, defined);
      defineProp(document, 'webkitExitFullscreen', webkit, defined);

      await exitFullscreenCompat();

      expect(webkit).toHaveBeenCalledTimes(1);
    });

    it('falls back to mozCancelFullScreen when only moz prefix exists', async () => {
      const moz = vi.fn().mockResolvedValue(undefined);
      defineProp(document, 'exitFullscreen', undefined, defined);
      defineProp(document, 'mozCancelFullScreen', moz, defined);

      await exitFullscreenCompat();

      expect(moz).toHaveBeenCalledTimes(1);
    });

    it('falls back to msExitFullscreen when only ms prefix exists', async () => {
      const ms = vi.fn().mockResolvedValue(undefined);
      defineProp(document, 'exitFullscreen', undefined, defined);
      defineProp(document, 'msExitFullscreen', ms, defined);

      await exitFullscreenCompat();

      expect(ms).toHaveBeenCalledTimes(1);
    });

    it('resolves to void (does not throw) when no exit API is present', async () => {
      defineProp(document, 'exitFullscreen', undefined, defined);

      await expect(exitFullscreenCompat()).resolves.toBeUndefined();
    });
  });

  describe('getFullscreenElementCompat', () => {
    it('returns the standard document.fullscreenElement when set', () => {
      const el = document.createElement('div');
      defineProp(document, 'fullscreenElement', el, defined);

      expect(getFullscreenElementCompat()).toBe(el);
    });

    it('falls back to a prefixed fullscreen element', () => {
      const el = document.createElement('section');
      defineProp(document, 'fullscreenElement', null, defined);
      defineProp(document, 'webkitFullscreenElement', el, defined);

      expect(getFullscreenElementCompat()).toBe(el);
    });

    it('returns null when no fullscreen element is present', () => {
      defineProp(document, 'fullscreenElement', null, defined);

      expect(getFullscreenElementCompat()).toBeNull();
    });
  });

  describe('isFullscreenSupportedCompat', () => {
    it('returns boolean true when webkit prefix flag is set', () => {
      defineProp(document, 'fullscreenEnabled', false, defined);
      defineProp(document, 'webkitFullscreenEnabled', true, defined);

      const result = isFullscreenSupportedCompat();
      expect(result).toBe(true);
      expect(typeof result).toBe('boolean');
    });

    it('returns boolean true when moz prefix flag is set', () => {
      defineProp(document, 'fullscreenEnabled', false, defined);
      defineProp(document, 'mozFullScreenEnabled', true, defined);

      const result = isFullscreenSupportedCompat();
      expect(result).toBe(true);
      expect(typeof result).toBe('boolean');
    });

    it('returns boolean true when ms prefix flag is set', () => {
      defineProp(document, 'fullscreenEnabled', false, defined);
      defineProp(document, 'msFullscreenEnabled', true, defined);

      const result = isFullscreenSupportedCompat();
      expect(result).toBe(true);
      expect(typeof result).toBe('boolean');
    });

    it('returns boolean false (not undefined) when no API flag is set', () => {
      defineProp(document, 'fullscreenEnabled', false, defined);

      const result = isFullscreenSupportedCompat();
      expect(result).toBe(false);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('addFullscreenChangeListenerCompat', () => {
    const PREFIXED_EVENTS = [
      'fullscreenchange',
      'webkitfullscreenchange',
      'mozfullscreenchange',
      'MSFullscreenChange',
    ];

    it('registers the handler on standard + all prefixed change events', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const handler = vi.fn();

      addFullscreenChangeListenerCompat(handler);

      for (const evt of PREFIXED_EVENTS) {
        expect(addSpy).toHaveBeenCalledWith(evt, handler);
      }
      addSpy.mockRestore();
    });

    it('removes all listeners via the returned cleanup function', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const handler = vi.fn();

      const cleanup = addFullscreenChangeListenerCompat(handler);
      expect(typeof cleanup).toBe('function');

      cleanup();

      for (const evt of PREFIXED_EVENTS) {
        expect(removeSpy).toHaveBeenCalledWith(evt, handler);
      }
      removeSpy.mockRestore();
    });
  });
});
