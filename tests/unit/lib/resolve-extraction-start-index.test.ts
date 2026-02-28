/**
 * Unit tests for resolveExtractionStartIndex()
 * Issue #326: Fix interactive prompt detection to return only lastCapturedLine onwards
 *
 * Tests the 4-branch startIndex determination logic (design policy section 3-2):
 *   Branch 1: bufferWasReset -> findRecentUserPromptIndex(40) + 1, or 0
 *   Branch 2: cliToolId === 'codex' -> Math.max(0, lastCapturedLine)
 *   Branch 3: lastCapturedLine >= totalLines - 5 (scroll boundary) ->
 *             findRecentUserPromptIndex(50) + 1, or totalLines - 40
 *   Branch 4: Normal case -> Math.max(0, lastCapturedLine)
 *
 * Additional coverage:
 *   - Stage 4 SF-001: Defensive validation for negative lastCapturedLine
 *   - Stage 4 SF-002: Empty buffer edge case (totalLines=0)
 *   - windowSize argument verification for branches 1 and 3
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveExtractionStartIndex } from '@/lib/response-poller';

/** Stub callback that always returns "not found" (-1). */
const noPromptFound = () => -1;

describe('resolveExtractionStartIndex() - Issue #326', () => {
  // -------------------------------------------------------------------
  // Branch 4: Normal case (most common path, tested first)
  // Design policy section 3-2, row 4: startIndex = Math.max(0, lastCapturedLine)
  // -------------------------------------------------------------------
  describe('Branch 4: normal case', () => {
    it('returns lastCapturedLine when buffer has not reset or scrolled (test #1)', () => {
      const result = resolveExtractionStartIndex(
        50,    // lastCapturedLine
        100,   // totalLines
        false, // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(50);
    });

    it('returns 0 when lastCapturedLine is 0 (Stage 2 SF-001: Math.max guard, test #8)', () => {
      const result = resolveExtractionStartIndex(
        0,     // lastCapturedLine
        100,   // totalLines
        false, // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Branch 1: bufferWasReset (lastCapturedLine >= totalLines OR bufferReset flag)
  // Design policy section 3-2, row 1: search for recent user prompt within 40 lines
  // -------------------------------------------------------------------
  describe('Branch 1: bufferWasReset', () => {
    it('returns foundUserPrompt + 1 when user prompt is found (test #2)', () => {
      const result = resolveExtractionStartIndex(
        200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
        80,    // totalLines
        true,  // bufferReset
        'claude',
        () => 60 // user prompt found at index 60
      );
      expect(result).toBe(61);
    });

    it('returns 0 when no user prompt is found (fallback, test #3)', () => {
      const result = resolveExtractionStartIndex(
        200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
        80,    // totalLines
        true,  // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(0);
    });

    it('passes windowSize=40 to findRecentUserPromptIndex', () => {
      let capturedWindowSize = 0;
      resolveExtractionStartIndex(
        200,   // lastCapturedLine (>= totalLines -> bufferWasReset)
        80,    // totalLines
        false, // bufferReset (not needed; lastCapturedLine >= totalLines suffices)
        'claude',
        (windowSize) => {
          capturedWindowSize = windowSize;
          return 60;
        }
      );
      expect(capturedWindowSize).toBe(40);
    });
  });

  // -------------------------------------------------------------------
  // Branch 2: Codex normal case
  // Design policy section 3-2, row 2: startIndex = Math.max(0, lastCapturedLine)
  // -------------------------------------------------------------------
  describe('Branch 2: Codex-specific path', () => {
    it('returns lastCapturedLine for Codex (test #4)', () => {
      const result = resolveExtractionStartIndex(
        50,    // lastCapturedLine
        100,   // totalLines
        false, // bufferReset
        'codex',
        noPromptFound
      );
      expect(result).toBe(50);
    });

    it('returns 0 when lastCapturedLine is 0 (Stage 2 SF-001: Math.max guard, test #7)', () => {
      const result = resolveExtractionStartIndex(
        0,     // lastCapturedLine
        100,   // totalLines
        false, // bufferReset
        'codex',
        noPromptFound
      );
      expect(result).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Branch 3: Scroll boundary (lastCapturedLine >= totalLines - 5)
  // Design policy section 3-2, row 3: search for recent user prompt within 50 lines
  // -------------------------------------------------------------------
  describe('Branch 3: near scroll boundary', () => {
    it('returns foundUserPrompt + 1 when user prompt is found (test #5)', () => {
      const result = resolveExtractionStartIndex(
        96,    // lastCapturedLine (>= 100 - 5 = 95 -> scroll boundary)
        100,   // totalLines
        false, // bufferReset
        'claude',
        () => 85 // user prompt found at index 85
      );
      expect(result).toBe(86);
    });

    it('returns totalLines - 40 when no user prompt is found (fallback, test #6)', () => {
      const result = resolveExtractionStartIndex(
        96,    // lastCapturedLine (>= 100 - 5 = 95 -> scroll boundary)
        100,   // totalLines
        false, // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(60); // Math.max(0, 100 - 40) = 60
    });

    it('passes windowSize=50 to findRecentUserPromptIndex', () => {
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

  // -------------------------------------------------------------------
  // Branch 2a: OpenCode alternate screen mode
  // Always search for user prompt (fixed-size buffer, lastCapturedLine meaningless)
  // -------------------------------------------------------------------
  describe('Branch 2a: OpenCode alternate screen', () => {
    it('returns foundUserPrompt + 1 when prompt found, ignoring lastCapturedLine', () => {
      const result = resolveExtractionStartIndex(
        190,   // lastCapturedLine (would be wrong for normal tools)
        200,   // totalLines (fixed pane height)
        false, // bufferReset
        'opencode',
        () => 5 // user prompt found at index 5
      );
      expect(result).toBe(6);
    });

    it('returns 0 when no user prompt found', () => {
      const result = resolveExtractionStartIndex(
        190,   // lastCapturedLine
        200,   // totalLines
        false, // bufferReset
        'opencode',
        noPromptFound
      );
      expect(result).toBe(0);
    });

    it('passes totalLines as windowSize to search entire buffer', () => {
      let capturedWindowSize = 0;
      resolveExtractionStartIndex(
        190,
        200,
        false,
        'opencode',
        (windowSize) => {
          capturedWindowSize = windowSize;
          return 10;
        }
      );
      expect(capturedWindowSize).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // Edge cases: defensive validation and boundary conditions
  // -------------------------------------------------------------------
  describe('edge cases', () => {
    it('clamps negative lastCapturedLine to 0 (Stage 4 SF-001: defensive validation, test #9)', () => {
      const result = resolveExtractionStartIndex(
        -1,    // lastCapturedLine (negative input)
        100,   // totalLines
        false, // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(0);
    });

    it('returns 0 when totalLines is 0 (Stage 4 SF-002: empty buffer, test #10)', () => {
      // When totalLines=0 and lastCapturedLine=0: 0 >= 0 -> bufferWasReset=true
      // findRecentUserPromptIndex returns -1 -> fallback to 0
      const result = resolveExtractionStartIndex(
        0,     // lastCapturedLine
        0,     // totalLines (empty buffer)
        false, // bufferReset
        'claude',
        noPromptFound
      );
      expect(result).toBe(0);
    });
  });
});
