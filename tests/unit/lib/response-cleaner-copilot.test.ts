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

  // Issue #565 追加: TUI装飾パターンのフィルタリング
  describe('Copilot TUI decoration filtering', () => {
    it('should skip logo/banner lines', () => {
      const input = [
        'GitHub Copilot v1.0.12',
        '█ ▘▝ █',
        '▔▔▔▔',
        '╭─╮╭─╮',
        '╰─╯╰─╯',
        'Actual response content',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Actual response content');
    });

    it('should skip status bar lines with branch and model info', () => {
      const input = [
        '~/share/work/github/Anvil-develop [⎇ develop] GPT-5 mini (medium)',
        'The analysis result is:',
        'Bug is in line 42',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('The analysis result is:\nBug is in line 42');
    });

    it('should skip operation guide lines', () => {
      const input = [
        'shift+tab switch mode',
        '? for shortcuts',
        'ctrl+q enqueue',
        'Actual content here',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Actual content here');
    });

    it('should skip prompt lines', () => {
      const input = [
        '❯ Type @ to mention files...',
        '❯',
        'Response text here',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Response text here');
    });

    it('should skip tip/hint lines', () => {
      const input = [
        'Tip: /share Share session or research report...',
        'Tip: /model Switch between available models',
        'Here is the actual response',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Here is the actual response');
    });

    it('should skip initial display text', () => {
      const input = [
        'Describe a task to get started.',
        'The result of the analysis:',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('The result of the analysis:');
    });

    it('should handle complex real-world Copilot TUI output', () => {
      const input = [
        'GitHub Copilot v1.0.12',
        '█ ▘▝ █',
        '──────────────────',
        'Describe a task to get started.',
        'Tip: /share Share session or research report...',
        '~/share/work/github/Anvil-develop [⎇ develop] GPT-5 mini (medium)',
        '❯ Type @ to mention files...',
        'shift+tab switch mode',
        '? for shortcuts',
        '──────────────────',
        'Here is my analysis of the issue:',
        '',
        'The bug is caused by a null pointer.',
        'I recommend fixing line 42.',
        '',
        '❯',
        'shift+tab switch mode',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe(
        'Here is my analysis of the issue:\nThe bug is caused by a null pointer.\nI recommend fixing line 42.'
      );
    });
  });
});
