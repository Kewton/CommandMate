/**
 * Unit tests for cleanCopilotResponse
 * Issue #565: Copilot TUI artifact removal using normalizeCopilotLine + COPILOT_SKIP_PATTERNS
 */

import { describe, it, expect } from 'vitest';
import { cleanCopilotResponse } from '@/lib/response-cleaner';

describe('cleanCopilotResponse', () => {
  it('should return clean text unchanged', () => {
    const input = 'This is a clean response.\nSecond line.';
    expect(cleanCopilotResponse(input)).toBe(input);
  });

  it('should strip ANSI escape codes', () => {
    const input = '\x1b[32mGreen text\x1b[0m\nNormal text';
    expect(cleanCopilotResponse(input)).toBe('Green text\nNormal text');
  });

  it('should remove empty lines', () => {
    const input = 'First line\n\n  \n\nSecond line';
    expect(cleanCopilotResponse(input)).toBe('First line\nSecond line');
  });

  it('should skip separator lines', () => {
    const input = '──────────────────\nContent line\n──────────────────';
    expect(cleanCopilotResponse(input)).toBe('Content line');
  });

  it('should skip thinking/spinner patterns', () => {
    const input = '\u2801 Loading...\nActual response';
    expect(cleanCopilotResponse(input)).toBe('Actual response');
  });

  it('should skip selection list patterns', () => {
    const input = 'Search models...\nContent\nSelect Model';
    expect(cleanCopilotResponse(input)).toBe('Content');
  });

  it('should skip pasted text markers', () => {
    const input = '[Pasted text #1 +46 lines]\nActual response content';
    expect(cleanCopilotResponse(input)).toBe('Actual response content');
  });

  it('should normalize box-drawing characters in content', () => {
    const input = '\u2500\u2500 Content \u2502\u2502\nMore content';
    expect(cleanCopilotResponse(input)).toBe('Content\nMore content');
  });

  it('should handle complex mixed content', () => {
    const input = [
      '──────────────────',      // separator - skip
      'Here is my answer:',      // content - keep
      '',                         // empty - skip
      '\u2801\u2802 Thinking',   // thinking - skip
      'The result is 42.',       // content - keep
      '[Pasted text #1 +5 lines]', // pasted text - skip
      'Thank you!',              // content - keep
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe(
      'Here is my answer:\nThe result is 42.\nThank you!'
    );
  });

  it('should return empty string for all-artifact content', () => {
    const input = '──────────────────\n[Pasted text #1 +5 lines]\n   ';
    expect(cleanCopilotResponse(input)).toBe('');
  });

  it('should trim leading and trailing whitespace', () => {
    const input = '  \nContent line\n  ';
    expect(cleanCopilotResponse(input)).toBe('Content line');
  });
});
