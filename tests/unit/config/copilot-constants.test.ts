/**
 * Unit tests for Copilot timing constants
 * Issue #565: Validates constant values and types
 */

import { describe, it, expect } from 'vitest';
import {
  COPILOT_SEND_ENTER_DELAY_MS,
  COPILOT_TEXT_INPUT_DELAY_MS,
} from '@/config/copilot-constants';

describe('copilot-constants', () => {
  it('COPILOT_SEND_ENTER_DELAY_MS should be 200', () => {
    expect(COPILOT_SEND_ENTER_DELAY_MS).toBe(200);
  });

  it('COPILOT_TEXT_INPUT_DELAY_MS should be 100', () => {
    expect(COPILOT_TEXT_INPUT_DELAY_MS).toBe(100);
  });

  it('COPILOT_SEND_ENTER_DELAY_MS should be a positive number', () => {
    expect(typeof COPILOT_SEND_ENTER_DELAY_MS).toBe('number');
    expect(COPILOT_SEND_ENTER_DELAY_MS).toBeGreaterThan(0);
  });

  it('COPILOT_TEXT_INPUT_DELAY_MS should be a positive number', () => {
    expect(typeof COPILOT_TEXT_INPUT_DELAY_MS).toBe('number');
    expect(COPILOT_TEXT_INPUT_DELAY_MS).toBeGreaterThan(0);
  });

  it('COPILOT_TEXT_INPUT_DELAY_MS should be less than COPILOT_SEND_ENTER_DELAY_MS', () => {
    expect(COPILOT_TEXT_INPUT_DELAY_MS).toBeLessThan(COPILOT_SEND_ENTER_DELAY_MS);
  });
});
