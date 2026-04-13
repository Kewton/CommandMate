/**
 * Global session poller unit tests
 * Issue #649: Test global session polling lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock CLIToolManager
const mockGetSessionName = vi.fn().mockReturnValue('mcbd-claude-__global__');
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue({
        getSessionName: (...args: unknown[]) => mockGetSessionName(...args),
      }),
    }),
  },
}));

// Mock tmux
const mockHasSession = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: (...args: unknown[]) => mockHasSession(...args),
}));

import {
  pollGlobalSession,
  stopGlobalSessionPolling,
  stopAllGlobalSessionPolling,
  isGlobalPollerActive,
  getActiveGlobalPollers,
} from '@/lib/polling/global-session-poller';

describe('global-session-poller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Clean up any leftover pollers
    stopAllGlobalSessionPolling();
  });

  afterEach(() => {
    stopAllGlobalSessionPolling();
    vi.useRealTimers();
  });

  describe('pollGlobalSession', () => {
    it('should start polling for a given CLI tool', () => {
      pollGlobalSession('claude');

      expect(isGlobalPollerActive('claude')).toBe(true);
      expect(getActiveGlobalPollers()).toContain('claude');
    });

    it('should stop existing poller before starting a new one', () => {
      pollGlobalSession('claude');
      expect(isGlobalPollerActive('claude')).toBe(true);

      // Start again - should stop the old one first
      pollGlobalSession('claude');
      expect(isGlobalPollerActive('claude')).toBe(true);

      // Only one entry should exist
      expect(getActiveGlobalPollers().filter(k => k === 'claude').length).toBe(1);
    });

    it('should support multiple CLI tools simultaneously', () => {
      pollGlobalSession('claude');
      pollGlobalSession('codex');

      expect(isGlobalPollerActive('claude')).toBe(true);
      expect(isGlobalPollerActive('codex')).toBe(true);
      expect(getActiveGlobalPollers().length).toBe(2);
    });
  });

  describe('stopGlobalSessionPolling', () => {
    it('should stop polling for a specific CLI tool', () => {
      pollGlobalSession('claude');
      expect(isGlobalPollerActive('claude')).toBe(true);

      stopGlobalSessionPolling('claude');
      expect(isGlobalPollerActive('claude')).toBe(false);
    });

    it('should be safe to call on non-active poller', () => {
      expect(() => stopGlobalSessionPolling('claude')).not.toThrow();
    });
  });

  describe('stopAllGlobalSessionPolling', () => {
    it('should stop all active pollers', () => {
      pollGlobalSession('claude');
      pollGlobalSession('codex');
      pollGlobalSession('gemini');

      expect(getActiveGlobalPollers().length).toBe(3);

      stopAllGlobalSessionPolling();

      expect(getActiveGlobalPollers().length).toBe(0);
      expect(isGlobalPollerActive('claude')).toBe(false);
      expect(isGlobalPollerActive('codex')).toBe(false);
      expect(isGlobalPollerActive('gemini')).toBe(false);
    });
  });

  describe('polling lifecycle', () => {
    it('should stop polling when session no longer exists', async () => {
      mockHasSession.mockResolvedValue(false);

      pollGlobalSession('claude');
      expect(isGlobalPollerActive('claude')).toBe(true);

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2100);

      expect(isGlobalPollerActive('claude')).toBe(false);
    });

    it('should continue polling when session exists', async () => {
      mockHasSession.mockResolvedValue(true);

      pollGlobalSession('claude');

      // Advance past first poll
      await vi.advanceTimersByTimeAsync(2100);

      expect(isGlobalPollerActive('claude')).toBe(true);
    });

    it('should stop after max retries', async () => {
      mockHasSession.mockResolvedValue(true);

      pollGlobalSession('claude');

      // Advance past max retries (900 * 2000ms = 1800000ms)
      // We need to advance in steps to allow each setTimeout to fire
      for (let i = 0; i < 901; i++) {
        await vi.advanceTimersByTimeAsync(2100);
      }

      expect(isGlobalPollerActive('claude')).toBe(false);
    });
  });

  describe('isGlobalPollerActive', () => {
    it('should return false for non-started poller', () => {
      expect(isGlobalPollerActive('claude')).toBe(false);
    });

    it('should return true for active poller', () => {
      pollGlobalSession('claude');
      expect(isGlobalPollerActive('claude')).toBe(true);
    });
  });
});
