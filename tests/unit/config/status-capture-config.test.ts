/**
 * Tests for status-capture-config.ts
 *
 * Issue #604: Shared capture line count constant for consistent
 * status detection across worktree-status-helper and current-output API.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';

describe('status-capture-config', () => {
  describe('STATUS_CAPTURE_LINES', () => {
    it('should be 10000', () => {
      expect(STATUS_CAPTURE_LINES).toBe(10000);
    });

    it('should be a positive number', () => {
      expect(STATUS_CAPTURE_LINES).toBeGreaterThan(0);
    });
  });
});
