/**
 * Unit tests for Copilot timing constants
 * Issue #565: Validates constant values and types
 */

import { describe, it, expect } from 'vitest';
import {
  COPILOT_SEND_ENTER_DELAY_MS,
  COPILOT_TEXT_INPUT_DELAY_MS,
  COPILOT_MODEL_SWITCH_TIMEOUT_MS,
  MODEL_NAME_PATTERN,
  MAX_MODEL_NAME_LENGTH,
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

  it('COPILOT_MODEL_SWITCH_TIMEOUT_MS should be 30000', () => {
    expect(COPILOT_MODEL_SWITCH_TIMEOUT_MS).toBe(30_000);
  });

  it('COPILOT_MODEL_SWITCH_TIMEOUT_MS should be a positive number', () => {
    expect(typeof COPILOT_MODEL_SWITCH_TIMEOUT_MS).toBe('number');
    expect(COPILOT_MODEL_SWITCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  // Issue #588: MODEL_NAME_PATTERN and MAX_MODEL_NAME_LENGTH
  it('MODEL_NAME_PATTERN should be a RegExp', () => {
    expect(MODEL_NAME_PATTERN).toBeInstanceOf(RegExp);
  });

  it('MODEL_NAME_PATTERN should require leading alphanumeric (DR4-001)', () => {
    expect(MODEL_NAME_PATTERN.test('a')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('0model')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('-model')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('.model')).toBe(false);
  });

  it('MODEL_NAME_PATTERN should allow hyphens, dots, slashes, colons, underscores', () => {
    expect(MODEL_NAME_PATTERN.test('gpt-4.1')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('openai/gpt-4')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('model:latest')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('my_model')).toBe(true);
  });

  it('MODEL_NAME_PATTERN should reject spaces and special chars', () => {
    expect(MODEL_NAME_PATTERN.test('model name')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('model@name')).toBe(false);
  });

  it('MAX_MODEL_NAME_LENGTH should be 128', () => {
    expect(MAX_MODEL_NAME_LENGTH).toBe(128);
  });

  it('MAX_MODEL_NAME_LENGTH should be a positive number', () => {
    expect(typeof MAX_MODEL_NAME_LENGTH).toBe('number');
    expect(MAX_MODEL_NAME_LENGTH).toBeGreaterThan(0);
  });
});
