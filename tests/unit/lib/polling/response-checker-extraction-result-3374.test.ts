/**
 * Issue #3374 — `response-checker-extraction-result`, the result shape of
 * `extractResponse` and its two builders, split out of `response-checker.ts`.
 *
 * Pins the builders directly, and that `response-checker` still hands out the
 * same functions under the names it had.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  incompleteResult,
  buildPromptExtractionResult,
} from '@/lib/polling/response-checker-extraction-result';
import * as responseChecker from '@/lib/polling/response-checker';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';

describe('[#3374] response-checker-extraction-result', () => {
  it('incompleteResult returns an empty, unfinished result at the given line count', () => {
    expect(incompleteResult(42)).toEqual({ response: '', isComplete: false, lineCount: 42 });
  });

  it('buildPromptExtractionResult slices from lastCapturedLine and strips ANSI (codex keeps the cursor)', () => {
    const lines = ['old 1', 'old 2', '\x1b[1mDo you want to proceed?\x1b[0m', '❯ 1. Yes', '  2. No'];
    const promptDetection: PromptDetectionResult = { isPrompt: true, cleanContent: 'Do you want to proceed?' };
    const result = buildPromptExtractionResult(
      lines, 2, lines.length, false, 'codex', () => -1, promptDetection,
    );
    expect(result).toEqual({
      response: 'Do you want to proceed?\n❯ 1. Yes\n  2. No',
      isComplete: true,
      lineCount: 5,
      promptDetection,
      bufferReset: false,
      captureWindowSaturated: false,
    });
  });

  it('buildPromptExtractionResult re-anchors on the user prompt after a buffer reset', () => {
    const lines = ['banner', '❯ hello', 'Pick one', '❯ 1. A', '  2. B'];
    const result = buildPromptExtractionResult(
      lines, 900, lines.length, true, 'claude', () => 1,
    );
    expect(result.response).toBe('Pick one\n❯ 1. A\n  2. B');
    expect(result.bufferReset).toBe(true);
    expect(result.promptDetection).toBeUndefined();
  });

  it('response-checker re-exports the same functions', () => {
    expect(responseChecker.incompleteResult).toBe(incompleteResult);
    expect(responseChecker.buildPromptExtractionResult).toBe(buildPromptExtractionResult);
  });
});
