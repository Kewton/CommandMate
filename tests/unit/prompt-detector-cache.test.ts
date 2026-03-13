/**
 * Prompt Detector Cache Unit Tests
 * Tests for duplicate log suppression in detectPrompt()
 *
 * Issue #402: Duplicate log output suppression to reduce I/O load
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));


describe('Prompt Detector - Duplicate log suppression', () => {
  beforeEach(() => {
    // T5: Cache reset for test isolation
    resetDetectPromptCache();

    // Clear mock logger call counts
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    // T5: Cache reset after each test for isolation
    resetDetectPromptCache();
    vi.restoreAllMocks();
  });

  // T1: Same output -> 2nd call suppresses logs
  it('T1: should suppress logs on second call with same output', () => {
    const output = 'Some output\nMore lines\nDo you want to proceed? (y/n)';

    // First call - should produce logs
    const result1 = detectPrompt(output);
    const callCountAfterFirst = mockLogger.debug.mock.calls.length;

    // Reset spy counts to measure second call independently
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();

    // Second call with same output - should suppress logs
    const result2 = detectPrompt(output);
    const callCountAfterSecond = mockLogger.debug.mock.calls.length;

    // Second call should produce fewer log calls than first
    // (debug logs for detectPrompt:start and detectPrompt:complete should be suppressed)
    expect(callCountAfterSecond).toBeLessThan(callCountAfterFirst);

    // Return values should still be correct
    expect(result1.isPrompt).toBe(true);
    expect(result2.isPrompt).toBe(true);
  });

  // T2: Different output -> logs appear normally
  it('T2: should emit logs normally when output changes', () => {
    const output1 = 'First output\nDo you want to proceed? (y/n)';
    const output2 = 'Second output\nDo you want to continue? (y/n)';

    detectPrompt(output1);
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();

    // Different output should produce logs
    detectPrompt(output2);

    // Should have at least one debug log call (detectPrompt:start)
    const hasDetectPromptLog = mockLogger.debug.mock.calls.some(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('detectPrompt')
    );
    expect(hasDetectPromptLog).toBe(true);
  });

  // T3: Return value same whether cache hit or miss (D4-001)
  it('T3: should return identical result regardless of cache state', () => {
    const output = 'Some content\nApprove?';

    // First call (cache miss)
    const result1 = detectPrompt(output);

    // Second call (cache hit)
    const result2 = detectPrompt(output);

    // Results must be structurally identical
    expect(result1.isPrompt).toEqual(result2.isPrompt);
    expect(result1.promptData?.type).toEqual(result2.promptData?.type);
    expect(result1.promptData?.question).toEqual(result2.promptData?.question);
    expect(result1.promptData?.options).toEqual(result2.promptData?.options);
    expect(result1.cleanContent).toEqual(result2.cleanContent);
  });

  // T3b: Return value for no-prompt output is also identical
  it('T3b: should return identical no-prompt result regardless of cache state', () => {
    const output = 'Just regular output\nNo prompt here\nPlain text';

    const result1 = detectPrompt(output);
    const result2 = detectPrompt(output);

    expect(result1.isPrompt).toBe(false);
    expect(result2.isPrompt).toBe(false);
    expect(result1.cleanContent).toEqual(result2.cleanContent);
  });

  // T4: After resetDetectPromptCache() -> logs appear again
  it('T4: should emit logs again after cache reset', () => {
    const output = 'Some output\nNo prompt here\nJust text';

    // First call
    detectPrompt(output);

    // Second call (should be suppressed)
    mockLogger.debug.mockClear();
    detectPrompt(output);
    const suppressedCount = mockLogger.debug.mock.calls.length;

    // Reset cache
    resetDetectPromptCache();

    // Third call after reset (should emit logs again)
    mockLogger.debug.mockClear();
    detectPrompt(output);
    const afterResetCount = mockLogger.debug.mock.calls.length;

    // After reset, should have more log calls than when suppressed
    expect(afterResetCount).toBeGreaterThan(suppressedCount);
  });

  // T5: Test isolation verification
  it('T5: should not be affected by previous test cache state', () => {
    // This test verifies that beforeEach properly resets cache
    // If cache leaked from a previous test, the first call would be
    // incorrectly treated as a cache hit
    const output = 'Isolated test output\nApprove?';

    const result = detectPrompt(output);

    // Should detect the prompt (not affected by previous test state)
    expect(result.isPrompt).toBe(true);
    expect(result.promptData?.question).toBe('Approve?');

    // The debug log for detectPrompt:start should have been emitted
    // (because this is the first call after cache reset)
    const hasStartLog = mockLogger.debug.mock.calls.some(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('detectPrompt:start')
    );
    expect(hasStartLog).toBe(true);
  });

  // T1b: Multiple choice prompt log suppression
  it('T1b: should suppress multipleChoice info logs on duplicate calls', () => {
    const output = [
      'Select an option:',
      '\u276F 1. Yes',
      '  2. No',
      '  3. Cancel',
    ].join('\n');

    // First call
    detectPrompt(output);
    mockLogger.debug.mockClear();

    // Second call with same output
    detectPrompt(output);

    // multipleChoice info log should also be suppressed
    const hasMultipleChoiceLog = mockLogger.debug.mock.calls.some(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('multipleChoice')
    );
    // Since logger uses console.log for info level too (in text format),
    // the multipleChoice log should not appear on second call
    expect(hasMultipleChoiceLog).toBe(false);
  });
});
