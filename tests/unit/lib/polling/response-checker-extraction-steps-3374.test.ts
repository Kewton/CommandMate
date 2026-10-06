/**
 * Issue #3374 — `response-checker-extraction-steps`, the steps split out of
 * `extractResponse`, reached directly rather than through it.
 *
 * The frames are hand-written and the patterns are handed in on the context,
 * so these pin each step's own decision; the per-tool behaviour on captured
 * frames stays pinned by the `response-checker-*` suites through
 * `extractResponse`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  findChromeStart,
  findRecentUserPromptIndexInFrame,
  isTurnComplete,
  extractCompletedResponse,
  extractPartialResponse,
  type ExtractionContext,
} from '@/lib/polling/response-checker-extraction-steps';
import type { CLIToolType } from '@/lib/cli-tools/types';

function context(cliToolId: CLIToolType, lines: string[], overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  const totalLines = lines.length;
  const base: ExtractionContext = {
    cliToolId,
    lines,
    totalLines,
    openCodeCleanLines: null,
    chromeStart: -1,
    contentEnd: totalLines,
    lastCapturedLine: 0,
    bufferReset: false,
    captureWindowSaturated: false,
    checkLineCount: 20,
    cleanOutputToCheck: lines.join('\n'),
    promptPattern: /^PROMPT>$/m,
    separatorPattern: /^-----$/m,
    thinkingPattern: /THINKING/,
    skipPatterns: [/^SKIP/],
    findRecentUserPromptIndex: () => -1,
  };
  return { ...base, ...overrides };
}

describe('[#3374] response-checker-extraction-steps', () => {
  describe('findChromeStart', () => {
    it('is -1 for a tool that pins no chrome', () => {
      expect(findChromeStart('gemini', ['a', 'b'], null)).toBe(-1);
      expect(findChromeStart('vibe-local', ['a', 'b'], null)).toBe(-1);
    });
  });

  describe('findRecentUserPromptIndexInFrame', () => {
    it('finds the newest `❯ <text>` echo above contentEnd', () => {
      const lines = ['❯ first', 'reply 1', '❯ second', 'reply 2', '❯ composer'];
      expect(findRecentUserPromptIndexInFrame('claude', lines, null, 4, 4, 60)).toBe(2);
    });

    it('is -1 when the echo is outside the window', () => {
      const lines = ['❯ first', 'r', 'r', 'r', 'r'];
      expect(findRecentUserPromptIndexInFrame('claude', lines, null, -1, 5, 2)).toBe(-1);
    });
  });

  describe('isTurnComplete', () => {
    it('claude: prompt and separator with nothing thinking', () => {
      const lines = ['reply', '-----', 'PROMPT>'];
      expect(isTurnComplete(context('claude', lines))).toBe(true);
    });

    it('claude: not while thinking', () => {
      const lines = ['THINKING', '-----', 'PROMPT>'];
      expect(isTurnComplete(context('claude', lines))).toBe(false);
    });

    it('gemini: the prompt alone is enough', () => {
      expect(isTurnComplete(context('gemini', ['reply', 'PROMPT>']))).toBe(true);
      expect(isTurnComplete(context('gemini', ['reply']))).toBe(false);
    });
  });

  describe('extractCompletedResponse', () => {
    it('collects the rows past the echoed prompt, dropping skipped ones', () => {
      const lines = ['❯ hi', 'answer line 1', 'SKIP me', 'answer line 2'];
      const result = extractCompletedResponse(context('gemini', lines, { findRecentUserPromptIndex: () => 0 }));
      expect(result).toMatchObject({
        response: 'answer line 1\nanswer line 2',
        isComplete: true,
        lineCount: 4,
        bufferReset: false,
        captureWindowSaturated: false,
      });
    });

    it('is incomplete when the tail of the reply still shows thinking', () => {
      const lines = ['answer', 'THINKING'];
      expect(extractCompletedResponse(context('gemini', lines))).toEqual({
        response: '', isComplete: false, lineCount: 2,
      });
    });

    it('gemini: a loading indicator is not a reply', () => {
      const lines = ['Waiting for auth ✦ please'];
      expect(extractCompletedResponse(context('gemini', lines))).toEqual({
        response: '', isComplete: false, lineCount: 1,
      });
    });
  });

  describe('extractPartialResponse', () => {
    it('returns what has streamed so far, unfinished', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `row ${i}`);
      expect(extractPartialResponse(context('gemini', lines, { lastCapturedLine: 10 }))).toEqual({
        response: lines.slice(10).join('\n'),
        isComplete: false,
        lineCount: 20,
      });
    });

    it('re-anchors on the echoed prompt after a buffer reset', () => {
      const lines = ['banner', '❯ hi', 'streamed'];
      const ctx = context('claude', lines, { bufferReset: true, findRecentUserPromptIndex: () => 1 });
      expect(extractPartialResponse(ctx).response).toBe('streamed');
    });

    it('is an empty incomplete result when nothing has streamed', () => {
      const lines = Array.from({ length: 10 }, () => 'SKIP');
      expect(extractPartialResponse(context('gemini', lines, { lastCapturedLine: 0 }))).toEqual({
        response: '', isComplete: false, lineCount: 10,
      });
    });
  });
});
