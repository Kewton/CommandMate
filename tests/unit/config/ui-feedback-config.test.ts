/**
 * Unit tests for UI feedback / interaction timing constants.
 * Issue #760: Validates that consolidated delay values match the original
 * hardcoded literals (behavior-preserving refactor).
 */

import { describe, it, expect } from 'vitest';
import {
  COPY_FEEDBACK_RESET_MS,
  COPY_FEEDBACK_RESET_SHORT_MS,
  NOTIFICATION_DISMISS_MS,
  KEY_PRESS_FEEDBACK_RESET_MS,
  NAV_KEY_REFRESH_DELAY_MS,
} from '@/config/ui-feedback-config';

describe('ui-feedback-config', () => {
  it('preserves the original literal values (no behavior change)', () => {
    expect(COPY_FEEDBACK_RESET_MS).toBe(2000);
    expect(COPY_FEEDBACK_RESET_SHORT_MS).toBe(1500);
    expect(NOTIFICATION_DISMISS_MS).toBe(2000);
    expect(KEY_PRESS_FEEDBACK_RESET_MS).toBe(150);
    expect(NAV_KEY_REFRESH_DELAY_MS).toBe(100);
  });

  it('exposes positive numbers for every constant', () => {
    const all = [
      COPY_FEEDBACK_RESET_MS,
      COPY_FEEDBACK_RESET_SHORT_MS,
      NOTIFICATION_DISMISS_MS,
      KEY_PRESS_FEEDBACK_RESET_MS,
      NAV_KEY_REFRESH_DELAY_MS,
    ];
    for (const value of all) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
  });

  it('keeps the short copy reset shorter than the standard one', () => {
    expect(COPY_FEEDBACK_RESET_SHORT_MS).toBeLessThan(COPY_FEEDBACK_RESET_MS);
  });
});
