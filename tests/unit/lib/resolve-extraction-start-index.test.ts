/**
 * Unit tests for resolveExtractionStartIndex()
 * Issue #326: Fix interactive prompt detection to return only lastCapturedLine onwards
 *
 * Tests the 4-branch startIndex determination logic:
 * 1. bufferWasReset -> findRecentUserPromptIndex(40) + 1 or 0
 * 2. cliToolId === 'codex' -> Math.max(0, lastCapturedLine)
 * 3. lastCapturedLine >= totalLines - 5 -> findRecentUserPromptIndex(50) + 1 or totalLines - 40
 * 4. normal -> Math.max(0, lastCapturedLine)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveExtractionStartIndex } from '@/lib/response-poller';

describe('resolveExtractionStartIndex() - Issue #326', () => {
  // Test case #1: Normal case (branch 4 - default)
  it('should return lastCapturedLine for normal case', () => {
    const result = resolveExtractionStartIndex(
      50,    // lastCapturedLine
      100,   // totalLines
      false, // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex (not called in this branch)
    );
    expect(result).toBe(50);
  });

  // Test case #2: Buffer reset with user prompt found (branch 1)
  it('should return foundUserPrompt + 1 when buffer was reset and user prompt found', () => {
    const result = resolveExtractionStartIndex(
      200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
      80,    // totalLines
      true,  // bufferReset
      'claude',
      () => 60 // findRecentUserPromptIndex returns 60
    );
    expect(result).toBe(61);
  });

  // Test case #3: Buffer reset without user prompt found (branch 1, fallback)
  it('should return 0 when buffer was reset and no user prompt found', () => {
    const result = resolveExtractionStartIndex(
      200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
      80,    // totalLines
      true,  // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex returns -1
    );
    expect(result).toBe(0);
  });

  // Test case #4: Codex normal case (branch 2)
  it('should return lastCapturedLine for Codex normal case', () => {
    const result = resolveExtractionStartIndex(
      50,    // lastCapturedLine
      100,   // totalLines
      false, // bufferReset
      'codex',
      () => -1 // findRecentUserPromptIndex (not called in this branch)
    );
    expect(result).toBe(50);
  });

  // Test case #5: Buffer scroll boundary with user prompt (branch 3)
  it('should return foundUserPrompt + 1 when near buffer scroll boundary', () => {
    const result = resolveExtractionStartIndex(
      96,    // lastCapturedLine (>= 100 - 5 = 95 -> scroll boundary)
      100,   // totalLines
      false, // bufferReset
      'claude',
      () => 85 // findRecentUserPromptIndex returns 85
    );
    expect(result).toBe(86);
  });

  // Test case #6: Buffer scroll boundary without user prompt (branch 3, fallback)
  it('should return totalLines - 40 when near buffer scroll boundary and no user prompt', () => {
    const result = resolveExtractionStartIndex(
      96,    // lastCapturedLine (>= 100 - 5 = 95 -> scroll boundary)
      100,   // totalLines
      false, // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex returns -1
    );
    expect(result).toBe(60); // Math.max(0, 100 - 40) = 60
  });

  // Test case #7: Codex with lastCapturedLine=0 (SF-001: Math.max guard)
  it('should return 0 for Codex when lastCapturedLine is 0', () => {
    const result = resolveExtractionStartIndex(
      0,     // lastCapturedLine
      100,   // totalLines
      false, // bufferReset
      'codex',
      () => -1 // findRecentUserPromptIndex (not called)
    );
    expect(result).toBe(0);
  });

  // Test case #8: Normal with lastCapturedLine=0 (SF-001: Math.max guard)
  it('should return 0 for normal case when lastCapturedLine is 0', () => {
    const result = resolveExtractionStartIndex(
      0,     // lastCapturedLine
      100,   // totalLines
      false, // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex (not called in this branch)
    );
    expect(result).toBe(0);
  });

  // Test case #9: Negative lastCapturedLine (Stage 4 SF-001: defensive validation)
  it('should return 0 when lastCapturedLine is negative (defensive validation)', () => {
    const result = resolveExtractionStartIndex(
      -1,    // lastCapturedLine (negative input)
      100,   // totalLines
      false, // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex (not called in this branch)
    );
    expect(result).toBe(0);
  });

  // Test case #10: Empty buffer (Stage 4 SF-002: totalLines=0)
  it('should return 0 when totalLines is 0 (empty buffer)', () => {
    const result = resolveExtractionStartIndex(
      0,     // lastCapturedLine
      0,     // totalLines (empty buffer -> bufferWasReset because 0 >= 0)
      false, // bufferReset
      'claude',
      () => -1 // findRecentUserPromptIndex returns -1
    );
    expect(result).toBe(0);
  });

  // Additional test: Verify findRecentUserPromptIndex receives correct windowSize
  it('should pass windowSize=40 to findRecentUserPromptIndex when buffer was reset', () => {
    let capturedWindowSize = 0;
    resolveExtractionStartIndex(
      200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
      80,    // totalLines
      false, // bufferReset (not needed because lastCapturedLine >= totalLines)
      'claude',
      (windowSize) => {
        capturedWindowSize = windowSize;
        return 60;
      }
    );
    expect(capturedWindowSize).toBe(40);
  });

  it('should pass windowSize=50 to findRecentUserPromptIndex when near scroll boundary', () => {
    let capturedWindowSize = 0;
    resolveExtractionStartIndex(
      96,    // lastCapturedLine (>= 100 - 5 = 95 -> scroll boundary)
      100,   // totalLines
      false, // bufferReset
      'claude',
      (windowSize) => {
        capturedWindowSize = windowSize;
        return 85;
      }
    );
    expect(capturedWindowSize).toBe(50);
  });
});
