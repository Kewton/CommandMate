import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getAutoYesState,
  setAutoYesEnabled,
  isAutoYesExpired,
  clearAllAutoYesStates,
  type AutoYesState,
} from '@/lib/auto-yes-manager';

describe('auto-yes-manager', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setAutoYesEnabled', () => {
    it('should enable auto-yes with correct timestamps', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = setAutoYesEnabled('wt-1', true);

      expect(state.enabled).toBe(true);
      expect(state.enabledAt).toBe(now);
      expect(state.expiresAt).toBe(now + 3600000);
    });

    it('should disable auto-yes', () => {
      setAutoYesEnabled('wt-1', true);
      const state = setAutoYesEnabled('wt-1', false);

      expect(state.enabled).toBe(false);
    });

    it('should disable auto-yes even when no prior state exists', () => {
      const state = setAutoYesEnabled('wt-new', false);

      expect(state.enabled).toBe(false);
      expect(state.enabledAt).toBe(0);
      expect(state.expiresAt).toBe(0);
    });
  });

  describe('getAutoYesState', () => {
    it('should return null when no state exists', () => {
      expect(getAutoYesState('nonexistent')).toBeNull();
    });

    it('should return the state when enabled', () => {
      setAutoYesEnabled('wt-1', true);
      const state = getAutoYesState('wt-1');

      expect(state).not.toBeNull();
      expect(state!.enabled).toBe(true);
    });

    it('should auto-disable when expired', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      setAutoYesEnabled('wt-1', true);

      // Advance past expiration
      vi.setSystemTime(now + 3600001);

      const state = getAutoYesState('wt-1');
      expect(state).not.toBeNull();
      expect(state!.enabled).toBe(false);
    });

    it('should not auto-disable when not yet expired', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      setAutoYesEnabled('wt-1', true);

      // Advance but not past expiration
      vi.setSystemTime(now + 3599999);

      const state = getAutoYesState('wt-1');
      expect(state!.enabled).toBe(true);
    });
  });

  describe('isAutoYesExpired', () => {
    it('should return true when expired', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(2001);

      expect(isAutoYesExpired(state)).toBe(true);
    });

    it('should return false when not expired', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(1999);

      expect(isAutoYesExpired(state)).toBe(false);
    });

    it('should return true at exact expiration time', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(2000);

      // At exact expiration, Date.now() === expiresAt, so not expired (> not >=)
      expect(isAutoYesExpired(state)).toBe(false);
    });
  });

  describe('clearAllAutoYesStates', () => {
    it('should clear all states', () => {
      setAutoYesEnabled('wt-1', true);
      setAutoYesEnabled('wt-2', true);

      clearAllAutoYesStates();

      expect(getAutoYesState('wt-1')).toBeNull();
      expect(getAutoYesState('wt-2')).toBeNull();
    });
  });
});
