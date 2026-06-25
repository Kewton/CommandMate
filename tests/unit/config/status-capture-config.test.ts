/**
 * Tests for status-capture-config.ts
 *
 * Issue #604: Shared capture line count constant for consistent
 * status detection across worktree-status-helper and current-output API.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { STATUS_CAPTURE_LINES, STATUS_DETECTION_CAPTURE_LINES } from '@/config/status-capture-config';

describe('status-capture-config', () => {
  describe('STATUS_CAPTURE_LINES', () => {
    it('should be 10000', () => {
      expect(STATUS_CAPTURE_LINES).toBe(10000);
    });

    it('should be a positive number', () => {
      expect(STATUS_CAPTURE_LINES).toBeGreaterThan(0);
    });
  });

  // Issue #965: detection uses a smaller capture than the display path.
  describe('STATUS_DETECTION_CAPTURE_LINES', () => {
    it('should be 1000', () => {
      expect(STATUS_DETECTION_CAPTURE_LINES).toBe(1000);
    });

    it('should be a positive number', () => {
      expect(STATUS_DETECTION_CAPTURE_LINES).toBeGreaterThan(0);
    });

    it('should be smaller than the display capture (perf) yet large enough to clear #604 trailing-blank padding', () => {
      expect(STATUS_DETECTION_CAPTURE_LINES).toBeLessThan(STATUS_CAPTURE_LINES);
      // #604 observed ~150+ trailing blank lines after a prompt; keep a wide margin.
      expect(STATUS_DETECTION_CAPTURE_LINES).toBeGreaterThan(150);
    });
  });
});
