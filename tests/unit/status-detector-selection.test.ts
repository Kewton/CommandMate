/**
 * Unit tests for status-detector.ts selection_list detection
 * Issue #473: OpenCode selection list detection in priority 2.5 block
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-detector';

// Helper: Build OpenCode TUI output with content area + footer
// OpenCode TUI layout: content area (top) | empty padding | footer (ctrl+t/ctrl+p line)
function buildOpenCodeOutput(contentLines: string[], footerLines?: string[]): string {
  const defaultFooter = [
    '  \u2503                                                                \u2503',
    '  \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580',
    '  Build GPT-5-mini GitHub Copilot',
    '  ctrl+t theme  ctrl+p commands',
  ];
  const footer = footerLines ?? defaultFooter;
  // Add padding between content and footer (mimicking TUI layout)
  const padding = Array(10).fill('');
  return [...contentLines, ...padding, ...footer].join('\n');
}

describe('STATUS_REASON constants', () => {
  it('should export STATUS_REASON with opencode_selection_list', () => {
    expect(STATUS_REASON).toBeDefined();
    expect(STATUS_REASON.OPENCODE_SELECTION_LIST).toBe('opencode_selection_list');
  });

  it('should include existing reason values', () => {
    expect(STATUS_REASON.THINKING_INDICATOR).toBe('thinking_indicator');
    expect(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR).toBe('opencode_processing_indicator');
    expect(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE).toBe('opencode_response_complete');
    expect(STATUS_REASON.PROMPT_DETECTED).toBe('prompt_detected');
    expect(STATUS_REASON.INPUT_PROMPT).toBe('input_prompt');
    expect(STATUS_REASON.NO_RECENT_OUTPUT).toBe('no_recent_output');
    expect(STATUS_REASON.DEFAULT).toBe('default');
  });
});

describe('detectSessionStatus - OpenCode selection_list detection', () => {
  it('should detect "Select model" header and return waiting status', () => {
    const output = buildOpenCodeOutput([
      '              Select model                                     esc',
      '',
      '              Search',
      '',
      '              Recent',
      '            > GPT-5.1-Codex-mini GitHub Copilot',
      '              GPT-5-mini GitHub Copilot',
      '              claude-3.5-sonnet',
    ]);

    const result = detectSessionStatus(output, 'opencode');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should detect "Select provider" header', () => {
    const output = buildOpenCodeOutput([
      '              Select provider                                  esc',
      '',
      '              Search',
      '',
      '              OpenAI',
      '              Anthropic',
      '              Ollama',
    ]);

    const result = detectSessionStatus(output, 'opencode');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
  });

  // [DR3-002] Regression: normal OpenCode response should not trigger selection_list
  it('should NOT detect selection_list for normal OpenCode response', () => {
    const output = buildOpenCodeOutput([
      'Here is your code:',
      '```typescript',
      'console.log("hello");',
      '```',
      '\u25A3 Build \u00b7 qwen3.5:27b \u00b7 2.1s',
    ]);

    const result = detectSessionStatus(output, 'opencode');
    expect(result.reason).not.toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
  });

  // [DR3-002] Regression: response_complete should reach (D) and not be caught by (C)
  it('should detect response_complete (D) when no selection list is present', () => {
    const output = buildOpenCodeOutput([
      'Some response text here',
      '\u25A3 Build \u00b7 qwen3.5:27b \u00b7 5.2s',
    ]);

    const result = detectSessionStatus(output, 'opencode');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  // [DR3-002] Priority: (A) processing_indicator takes precedence over (C) selection_list
  it('should prioritize processing_indicator (A) over selection_list (C)', () => {
    const output = buildOpenCodeOutput(
      ['              Select model                                     esc', '  GPT-5-mini'],
      [
        '  \u2503                                \u2503',
        '  \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580',
        '  Build GPT-5-mini',
        '  esc interrupt',  // processing indicator in footer
      ]
    );

    const result = detectSessionStatus(output, 'opencode');
    // (A) should fire before (C)
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
    expect(result.status).toBe('running');
  });

  // [DR3-002] Priority: (B) thinking takes precedence over (C) selection_list
  it('should prioritize thinking (B) over selection_list (C)', () => {
    const output = buildOpenCodeOutput([
      '              Select model                                     esc',
      'Thinking:',  // thinking indicator in content
    ]);

    const result = detectSessionStatus(output, 'opencode');
    expect(result.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(result.status).toBe('running');
  });

  // Non-OpenCode tools should not be affected
  it('should not affect Claude CLI detection', () => {
    const output = '> \nSome output here';
    const result = detectSessionStatus(output, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
  });

  it('should not affect Codex detection', () => {
    const output = '\u203A \nSome output';
    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).not.toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
  });
});
