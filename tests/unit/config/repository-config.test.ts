/**
 * Unit tests for repository-config.ts
 * Issue #644: MAX_DISPLAY_NAME_LENGTH
 * Issue #760: CLONE_STATUS_POLL_INTERVAL_MS (consolidated polling interval)
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_DISPLAY_NAME_LENGTH,
  CLONE_STATUS_POLL_INTERVAL_MS,
} from '@/config/repository-config';

describe('repository-config', () => {
  it('MAX_DISPLAY_NAME_LENGTH should be 100', () => {
    expect(MAX_DISPLAY_NAME_LENGTH).toBe(100);
  });

  describe('CLONE_STATUS_POLL_INTERVAL_MS (Issue #760)', () => {
    it('should be 2000 (2 seconds), preserving the original literal', () => {
      expect(CLONE_STATUS_POLL_INTERVAL_MS).toBe(2000);
    });

    it('should be a positive number', () => {
      expect(typeof CLONE_STATUS_POLL_INTERVAL_MS).toBe('number');
      expect(CLONE_STATUS_POLL_INTERVAL_MS).toBeGreaterThan(0);
    });
  });
});
