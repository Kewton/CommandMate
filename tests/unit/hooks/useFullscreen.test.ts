/**
 * Unit tests for useFullscreen hook
 *
 * @module tests/unit/hooks/useFullscreen
 * @vitest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFullscreen } from '@/hooks/useFullscreen';

describe('useFullscreen', () => {
  // Mock Fullscreen API
  let mockFullscreenEnabled: boolean;
  let mockFullscreenElement: Element | null;
  let mockRequestFullscreen: ReturnType<typeof vi.fn>;
  let mockExitFullscreen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFullscreenEnabled = true;
    mockFullscreenElement = null;
    mockRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    mockExitFullscreen = vi.fn().mockResolvedValue(undefined);

    // Mock document properties
    Object.defineProperty(document, 'fullscreenEnabled', {
      get: () => mockFullscreenEnabled,
      configurable: true,
    });

    Object.defineProperty(document, 'fullscreenElement', {
      get: () => mockFullscreenElement,
      configurable: true,
    });

    document.exitFullscreen = mockExitFullscreen;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with isFullscreen false', () => {
      const { result } = renderHook(() => useFullscreen());

      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.isFallbackMode).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('enterFullscreen', () => {
    it('should enter fullscreen using API when supported', async () => {
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(mockRequestFullscreen).toHaveBeenCalled();
      expect(result.current.isFullscreen).toBe(true);
      expect(result.current.isFallbackMode).toBe(false);
    });

    it('should use fallback mode when API fails', async () => {
      mockRequestFullscreen = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(result.current.isFullscreen).toBe(true);
      expect(result.current.isFallbackMode).toBe(true);
      expect(result.current.error).toBe('Permission denied');
    });

    it('should use fallback mode when API not supported', async () => {
      mockFullscreenEnabled = false;
      const mockElement = {} as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(result.current.isFullscreen).toBe(true);
      expect(result.current.isFallbackMode).toBe(true);
    });

    it('should call onEnter callback when entering fullscreen', async () => {
      const onEnter = vi.fn();
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() =>
        useFullscreen({ elementRef, onEnter })
      );

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(onEnter).toHaveBeenCalled();
    });
  });

  describe('exitFullscreen', () => {
    it('should exit fullscreen using API', async () => {
      mockFullscreenElement = document.createElement('div');
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      // First enter fullscreen
      await act(async () => {
        await result.current.enterFullscreen();
      });

      // Then exit
      await act(async () => {
        await result.current.exitFullscreen();
      });

      expect(mockExitFullscreen).toHaveBeenCalled();
      expect(result.current.isFullscreen).toBe(false);
    });

    it('should exit fallback mode without calling API', async () => {
      mockFullscreenEnabled = false;
      const mockElement = {} as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      // Enter fallback mode
      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(result.current.isFallbackMode).toBe(true);

      // Exit fallback mode
      await act(async () => {
        await result.current.exitFullscreen();
      });

      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.isFallbackMode).toBe(false);
      expect(mockExitFullscreen).not.toHaveBeenCalled();
    });

    it('should call onExit callback when exiting fullscreen', async () => {
      const onExit = vi.fn();
      mockFullscreenElement = document.createElement('div');
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() =>
        useFullscreen({ elementRef, onExit })
      );

      await act(async () => {
        await result.current.enterFullscreen();
      });

      await act(async () => {
        await result.current.exitFullscreen();
      });

      expect(onExit).toHaveBeenCalled();
    });
  });

  describe('toggleFullscreen', () => {
    it('should toggle between fullscreen states', async () => {
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      // Toggle on
      await act(async () => {
        await result.current.toggleFullscreen();
      });

      expect(result.current.isFullscreen).toBe(true);

      // Toggle off
      await act(async () => {
        await result.current.toggleFullscreen();
      });

      expect(result.current.isFullscreen).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should set error and call onError when API fails', async () => {
      const onError = vi.fn();
      mockRequestFullscreen = vi.fn().mockRejectedValue(new Error('API Error'));
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() =>
        useFullscreen({ elementRef, onError })
      );

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(result.current.error).toBe('API Error');
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should clear error on new operation', async () => {
      mockRequestFullscreen = vi.fn().mockRejectedValue(new Error('API Error'));
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      await act(async () => {
        await result.current.enterFullscreen();
      });

      expect(result.current.error).toBe('API Error');

      // Clear error by attempting exit
      await act(async () => {
        await result.current.exitFullscreen();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('fullscreenchange event', () => {
    it('should update state when fullscreenchange event fires', async () => {
      const mockElement = {
        requestFullscreen: mockRequestFullscreen,
      } as unknown as HTMLDivElement;
      const elementRef = { current: mockElement };

      const { result } = renderHook(() => useFullscreen({ elementRef }));

      // Simulate entering fullscreen via API event
      await act(async () => {
        mockFullscreenElement = mockElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      });

      await waitFor(() => {
        expect(result.current.isFullscreen).toBe(true);
      });

      // Simulate exiting fullscreen via API event
      await act(async () => {
        mockFullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      });

      await waitFor(() => {
        expect(result.current.isFullscreen).toBe(false);
      });
    });
  });
});
