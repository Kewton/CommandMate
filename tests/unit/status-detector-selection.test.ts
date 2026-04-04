/**
 * Unit tests for status-detector.ts selection_list detection
 * Issue #473: OpenCode selection list detection in priority 2.5 block
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus, STATUS_REASON, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';

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

describe('STATUS_REASON - COPILOT_SELECTION_LIST', () => {
  it('should export COPILOT_SELECTION_LIST constant', () => {
    expect(STATUS_REASON.COPILOT_SELECTION_LIST).toBe('copilot_selection_list');
  });
});

describe('SELECTION_LIST_REASONS Set', () => {
  it('should be a Set', () => {
    expect(SELECTION_LIST_REASONS).toBeInstanceOf(Set);
  });

  it('should contain all four selection list reasons', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.OPENCODE_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CLAUDE_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.COPILOT_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CODEX_SELECTION_LIST)).toBe(true);
  });

  it('should have exactly 4 entries', () => {
    expect(SELECTION_LIST_REASONS.size).toBe(4);
  });

  it('should not contain unrelated reasons', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.THINKING_INDICATOR)).toBe(false);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.PROMPT_DETECTED)).toBe(false);
  });
});

describe('detectSessionStatus - Copilot selection_list detection', () => {
  it('should detect Copilot selection list and return waiting status', () => {
    const output = [
      'Select Model',
      'Search models...',
      '❯ gpt-4o',
      '  gpt-4o-mini',
      '  claude-3.5-sonnet',
    ].join('\n');

    const result = detectSessionStatus(output, 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should NOT detect copilot_selection_list when cliToolId is claude (negative test)', () => {
    // Even if the output contains Copilot selection list text,
    // with cliToolId='claude', it should NOT trigger copilot_selection_list
    const output = [
      'Select Model',
      'Search models...',
      '❯ gpt-4o',
    ].join('\n');

    const result = detectSessionStatus(output, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
  });

  it('should detect selection list even when Reasoning indicator is present', () => {
    // /model selection screen shows "Reasoning ■■■ medium" which matches
    // COPILOT_THINKING_PATTERN. Selection list must take priority.
    const output = [
      'Select Model',
      'Choose the AI model to use for Copilot CLI.',
      '[Available] Upgrade',
      'Search models...',
      '❯ Claude Sonnet 4.6 (default) ✓        1x',
      '  Claude Sonnet 4.5                     1x',
      '  Claude Haiku 4.5                   0.33x',
      '  Claude Opus 4.6                       3x',
      '  GPT-5 mini                            0x',
      '',
      'Reasoning ■■■ medium',
      '',
      '↑↓ to navigate · Tab switch tab · ←→ reasoning effort · Enter to select · Esc to cancel',
    ].join('\n');

    const result = detectSessionStatus(output, 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
  });

  it('should detect prompt (not selection list) for yes/no confirmation (2 options)', () => {
    // Copilot yes/no prompts (2-3 options) should show PromptPanel, not NavigationButtons.
    const output = [
      'Do you want to run this command?',
      '',
      '❯ 1. Yes',
      '  2. No, and tell Copilot what to do differently (Esc to stop)',
      '',
      '↑↓ to navigate · Enter to select · Esc to cancel',
    ].join('\n');

    const result = detectSessionStatus(output, 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe('prompt_detected');
    expect(result.hasActivePrompt).toBe(true);
  });

  it('should detect selection list (not prompt) for ask_user multi-select (4+ options)', () => {
    // Copilot ask_user with 4+ options should show NavigationButtons for ↑↓ selection.
    const output = [
      '次のアクションを選んでください（推奨はビルド+テスト）。',
      '❯ 1. ビルド+テスト実行 (推奨)',
      '  2. Clippyチェックのみ',
      '  3. 特定ファイルを詳しく調査する（ファイル名を指定）',
      '  4. 何もしない',
      '  5. Other (type your answer)',
      '',
      '↑↓ to select · Enter to confirm · Esc to cancel',
    ].join('\n');

    const result = detectSessionStatus(output, 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should NOT detect copilot_selection_list for normal Copilot response', () => {
    const output = [
      'Here is your code:',
      '```typescript',
      'console.log("hello");',
      '```',
    ].join('\n');

    const result = detectSessionStatus(output, 'copilot');
    expect(result.reason).not.toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
  });
});

// Helper: Build Codex TUI output with content area + status bar
// Codex TUI layout: content area (top) | empty padding | status bar (bottom)
function buildCodexOutput(contentLines: string[]): string {
  const statusBar = '  o4-mini                                       50% left · /path/to/project';
  const padding = Array(10).fill('');
  return [...contentLines, ...padding, statusBar].join('\n');
}

describe('STATUS_REASON - CODEX_SELECTION_LIST', () => {
  it('should export CODEX_SELECTION_LIST constant', () => {
    expect(STATUS_REASON.CODEX_SELECTION_LIST).toBe('codex_selection_list');
  });
});

describe('detectSessionStatus - Codex selection_list detection (Issue #619)', () => {
  it('should detect Codex /model Step 1 selection list and return waiting status', () => {
    const output = buildCodexOutput([
      'Select a model',
      '',
      '  ❯ o4-mini (current)',
      '    o3',
      '    o3-pro',
      '    codex-mini-latest',
      '',
      'press enter to confirm or esc to cancel',
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should prioritize thinking (A) over selection list', () => {
    // If thinking indicator is present alongside "press enter to confirm",
    // thinking should take priority (step A before selection list step)
    const output = buildCodexOutput([
      'Select a model',
      '  ❯ o4-mini (current)',
      'press enter to confirm or esc to cancel',
      '• Planning something',  // thinking indicator in last lines
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('running');
    expect(result.reason).toBe('thinking_indicator');
  });

  it('should detect numbered prompt (Step 2) via priority 1 detectPrompt, not selection list', () => {
    // Codex /model Step 2 uses "press number to confirm" (NOT "press enter to confirm")
    // This is handled by detectMultipleChoicePrompt (priority 1) as a multiple_choice prompt
    const output = buildCodexOutput([
      'Reasoning level',
      '',
      '  1. low',
      '  2. medium (default)',
      '  3. high',
      '',
      'press number to confirm or esc to cancel',
    ]);

    const result = detectSessionStatus(output, 'codex');
    // Should be detected as prompt_detected (priority 1), not codex_selection_list
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe('prompt_detected');
  });

  it('should NOT detect selection list for normal Codex response', () => {
    const output = buildCodexOutput([
      'Here is the implementation:',
      '```typescript',
      'function hello() { return "world"; }',
      '```',
      '• Ran command: npm test',
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });

  it('should NOT trigger codex_selection_list for non-codex tools', () => {
    // Even if output contains "press enter to confirm", other tools should not match
    const output = [
      'press enter to confirm or esc to cancel',
      '> ',
    ].join('\n');

    const result = detectSessionStatus(output, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });
});
