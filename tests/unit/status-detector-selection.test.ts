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

  it('should contain all selection list reasons', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.OPENCODE_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CLAUDE_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.COPILOT_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CODEX_SELECTION_LIST)).toBe(true);
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST)).toBe(true);
    // Issue #1017: Codex pager/edit-previous mode also drives NavigationButtons.
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CODEX_PAGER)).toBe(true);
  });

  it('should have exactly 6 entries', () => {
    expect(SELECTION_LIST_REASONS.size).toBe(6);
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

  it('should prioritize selection list over thinking when both present (Issue #622)', () => {
    // When "press enter to confirm" footer and thinking indicator are both present,
    // selection list detection (priority 0.8) runs first and takes precedence.
    // This is correct because the footer definitively indicates a selection list UI.
    const output = buildCodexOutput([
      'Select a model',
      '  \u276F o4-mini (current)',
      'press enter to confirm or esc to cancel',
      '\u2022 Planning something',  // thinking indicator in last lines
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
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

describe('detectSessionStatus - Codex /model Step 1 model selection (Issue #622)', () => {
  it('should detect Codex /model Step 1 with "press enter to select" as codex_selection_list', () => {
    // Step 1: Model selection uses "Press enter to select reasoning effort, or esc to dismiss."
    // This must be detected as codex_selection_list, NOT as multiple_choice prompt.
    const output = buildCodexOutput([
      'Select Model and Effort',
      '',
      '\u203A 1. gpt-5.4 (current)   Latest frontier agentic coding model.',
      '  2. gpt-5.4-mini        Smaller frontier agentic coding model.',
      '  3. o3                   Advanced reasoning model.',
      '  4. o4-mini              Fast, affordable reasoning model.',
      '',
      'Press enter to select reasoning effort, or esc to dismiss.',
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should detect Codex /model Step 2 with "press enter to confirm" as codex_selection_list', () => {
    // Step 2: Reasoning level selection uses "Press enter to confirm or esc to go back"
    // This must still be detected as codex_selection_list (regression check).
    const output = buildCodexOutput([
      'Select Reasoning Level for gpt-5.4',
      '',
      '  1. Low                         Fast responses with lighter reasoning',
      '\u203A 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks',
      '  3. High                        Greater reasoning depth for complex problems',
      '  4. Extra high                  Extra high reasoning depth for complex problems',
      '',
      'Press enter to confirm or esc to go back',
    ]);

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should NOT affect "press number to confirm" detection (Issue #616 regression)', () => {
    // "press number to confirm" should still be detected as multiple_choice prompt,
    // not codex_selection_list.
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
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe('prompt_detected');
  });

  it('should NOT detect selection list when "Press enter to confirm" is stale in scrollback', () => {
    // Bug fix: previously, CODEX_SELECTION_LIST_PATTERN was evaluated against the full
    // content, so an already-answered approval prompt left behind in scrollback would
    // keep NavigationButtons visible even while Codex was actively running commands.
    // The detection window is now scoped to the content just above the status bar,
    // so stale footer text far up in scrollback no longer triggers it.
    const staleHistory = [
      '› 1. Yes, proceed (y)',
      '  2. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
      '✔ You approved codex to run something this time',
    ];
    const recentActivity: string[] = [];
    for (let i = 0; i < 40; i++) {
      recentActivity.push(`• Ran command step ${i}`);
    }
    recentActivity.push('› Write tests for @filename');

    const output = buildCodexOutput([...staleHistory, ...recentActivity]);
    const result = detectSessionStatus(output, 'codex');

    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });
});

// Helper: Build Codex pager / edit-previous (transcript) output (Issue #1017).
// Unlike buildCodexOutput, the pager renders a scroll-percentage separator
// ("─ N% ─") and key-hint footer INSTEAD of the "model · N% left · path" bar.
function buildCodexPagerOutput(footerLines: string[]): string {
  const transcript = [
    'user',
    'Please summarize the previous conversation.',
    '',
    'codex',
    'Here is the full transcript of our conversation so far:',
    'line 1 of the transcript',
    'line 2 of the transcript',
    'line 3 of the transcript',
  ];
  const scrollSeparator = '──────────────────────── 2% ────────────────────────';
  const padding = Array(3).fill('');
  return [...transcript, scrollSeparator, ...footerLines, ...padding].join('\n');
}

const CODEX_PAGER_SCROLL_FOOTER = [
  '↑/↓ to scroll   pgup/pgdn to page   home/end to jump',
  'q to quit   esc/← to edit prev   → to edit next   enter to edit message',
];

describe('STATUS_REASON - CODEX_PAGER (Issue #1017)', () => {
  it('should export CODEX_PAGER constant', () => {
    expect(STATUS_REASON.CODEX_PAGER).toBe('codex_pager');
  });

  it('should include CODEX_PAGER in SELECTION_LIST_REASONS (NavigationButtons shown)', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.CODEX_PAGER)).toBe(true);
  });
});

describe('detectSessionStatus - Codex pager / edit-previous detection (Issue #1017)', () => {
  it('should detect the pager scroll/edit footer and return waiting status', () => {
    const output = buildCodexPagerOutput(CODEX_PAGER_SCROLL_FOOTER);
    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.CODEX_PAGER);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should detect the scroll-hint footer line alone', () => {
    const output = buildCodexPagerOutput([
      '↑/↓ to scroll   pgup/pgdn to page   home/end to jump',
    ]);
    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).toBe(STATUS_REASON.CODEX_PAGER);
    expect(result.status).toBe('waiting');
  });

  it('should detect the edit-previous footer line alone', () => {
    const output = buildCodexPagerOutput([
      'q to quit   esc/← to edit prev   → to edit next   enter to edit message',
    ]);
    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).toBe(STATUS_REASON.CODEX_PAGER);
    expect(result.status).toBe('waiting');
  });

  it('should be content-based / instance-independent (primary and additional instances alike)', () => {
    // detectSessionStatus takes no instance parameter: the same captured pager
    // frame yields the same result whether it came from codex (primary) or
    // codex-2 / codex-3. This is the "instance non-dependence" acceptance check.
    const output = buildCodexPagerOutput(CODEX_PAGER_SCROLL_FOOTER);
    const primary = detectSessionStatus(output, 'codex');
    const additional = detectSessionStatus(output, 'codex');
    expect(primary.reason).toBe(STATUS_REASON.CODEX_PAGER);
    expect(additional.reason).toBe(primary.reason);
  });

  it('should NOT detect pager for a normal Codex response (no false positive)', () => {
    const output = buildCodexOutput([
      'Here is the implementation:',
      '```typescript',
      'function hello() { return "world"; }',
      '```',
      '› Write tests for @filename',
    ]);
    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_PAGER);
  });

  it('should NOT reclassify the genuine /model selection list as pager (no regression)', () => {
    // The /model footer is "press enter to select ... esc to dismiss" — it has no
    // scroll/page/jump or edit-prev/next/message hint, so it stays CODEX_SELECTION_LIST.
    const output = buildCodexOutput([
      'Select Model and Effort',
      '',
      '› 1. gpt-5.4 (current)   Latest frontier agentic coding model.',
      '  2. gpt-5.4-mini        Smaller frontier agentic coding model.',
      '',
      'Press enter to select reasoning effort, or esc to dismiss.',
    ]);
    const result = detectSessionStatus(output, 'codex');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_PAGER);
  });

  it('should NOT trigger pager detection for non-codex tools', () => {
    const output = [
      'q to quit   esc/← to edit prev   → to edit next   enter to edit message',
      '> ',
    ].join('\n');
    const result = detectSessionStatus(output, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_PAGER);
  });
});

describe('STATUS_REASON - ANTIGRAVITY_SELECTION_LIST (Issue #995)', () => {
  it('should export ANTIGRAVITY_SELECTION_LIST constant', () => {
    expect(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST).toBe('antigravity_selection_list');
  });
});

// Actual agy "Switch Model" TUI from Issue #995. The footer status bar renders
// "esc to cancel", which ANTIGRAVITY_THINKING_PATTERN also matches — so this is
// the exact collision the fix must resolve (selection list must win over thinking).
const AGY_SWITCH_MODEL_OUTPUT = [
  'Switch Model',
  '',
  '> Gemini 3.5 Flash (Medium)    (current)',
  '  Gemini 3.5 Flash (High)',
  '  Gemini 3.1 Pro (Low)',
  '  Claude Sonnet 4.6 (Thinking)',
  '  Claude Opus 4.6 (Thinking)',
  '  GPT-OSS 120B (Medium)',
  '',
  'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back',
  '',
  'esc to cancel                                        Gemini 3.5 Flash (Medium)',
].join('\n');

describe('detectSessionStatus - Antigravity selection_list detection (Issue #995)', () => {
  it('should detect the Switch Model TUI and return waiting status', () => {
    const result = detectSessionStatus(AGY_SWITCH_MODEL_OUTPUT, 'antigravity');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should prioritize selection list over the "esc to cancel" thinking footer', () => {
    // Regression guard for the root cause: the "esc to cancel" footer matches
    // ANTIGRAVITY_THINKING_PATTERN, so without priority-0.9 ordering the screen
    // would be misreported as running/thinking_indicator.
    const result = detectSessionStatus(AGY_SWITCH_MODEL_OUTPUT, 'antigravity');
    expect(result.reason).not.toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(result.status).not.toBe('running');
  });

  it('should mark the reason as a selection-list reason (NavigationButtons shown)', () => {
    const result = detectSessionStatus(AGY_SWITCH_MODEL_OUTPUT, 'antigravity');
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });

  it('should still detect running from the "esc to cancel" footer during generation', () => {
    // No selection-list markers → the thinking footer must still win (running).
    const output = [
      '  Generating a response for you',
      '────────────────────────────',
      '> ',
      '⠉ esc to cancel',
    ].join('\n');

    const result = detectSessionStatus(output, 'antigravity');
    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
  });

  it('should still detect ready from the bare ">" prompt when idle', () => {
    const output = [
      '  Here is the answer.',
      '────────────────────────────',
      '> ',
      '? for shortcuts                          gemini-2.5',
    ].join('\n');

    const result = detectSessionStatus(output, 'antigravity');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it('should NOT trigger antigravity_selection_list for non-antigravity tools', () => {
    const result = detectSessionStatus(AGY_SWITCH_MODEL_OUTPUT, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
  });

  it('should NOT detect selection list for a normal antigravity response', () => {
    const output = [
      '  Here is your refactored function.',
      '────────────────────────────',
      '> ',
      '? for shortcuts                          gemini-2.5',
    ].join('\n');

    const result = detectSessionStatus(output, 'antigravity');
    expect(result.reason).not.toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
  });
});

// Actual agy "Do you want to proceed?" permission-approval menu from Issue #997.
// Its footer is "↑/↓ Navigate · tab Amend · ctrl+g … · ctrl+r Review" — note there
// is NO "enter Select" hint, so the #995 pattern missed it and the "esc to cancel"
// footer misreported the screen as running/thinking. #997 broadens the pattern to
// the "↑/↓ Navigate" footer alone.
const AGY_PERMISSION_MENU_OUTPUT = [
  '  Requesting permission for:',
  '     git status',
  'Do you want to proceed?',
  '> 1. Yes',
  "  2. Yes, and always allow in this conversation for commands that start with 'git status'",
  "  3. Yes, and always allow for commands that start with 'git status' (Persist to settings.json)",
  '  4. No',
  '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command · ctrl+r Review',
  'esc to cancel                                                          Gemini 3.5 Flash (Medium)',
].join('\n');

describe('detectSessionStatus - Antigravity permission-approval menu detection (Issue #997)', () => {
  it('should detect the "Do you want to proceed?" menu and return waiting status', () => {
    const result = detectSessionStatus(AGY_PERMISSION_MENU_OUTPUT, 'antigravity');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('should prioritize the selection list over the "esc to cancel" thinking footer', () => {
    // Root-cause regression guard: the "esc to cancel" footer matches
    // ANTIGRAVITY_THINKING_PATTERN, so without priority-0.9 ordering the
    // permission menu would be misreported as running/thinking_indicator.
    const result = detectSessionStatus(AGY_PERMISSION_MENU_OUTPUT, 'antigravity');
    expect(result.reason).not.toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(result.status).not.toBe('running');
  });

  it('should mark the reason as a selection-list reason (NavigationButtons shown)', () => {
    const result = detectSessionStatus(AGY_PERMISSION_MENU_OUTPUT, 'antigravity');
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });

  it('should NOT trigger antigravity_selection_list for non-antigravity tools', () => {
    const result = detectSessionStatus(AGY_PERMISSION_MENU_OUTPUT, 'claude');
    expect(result.reason).not.toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
  });
});

// ===========================================================================
// Issue #1150: Codex status-bar version drift must not break the footer boundary
// used by selection-list detection.
//
// buildCodexOutput() above pins the LEGACY "N% left ·" bar; these tests use the
// v0.141 bar ("model effort · path", no "% left") to prove the relaxed
// CODEX_STATUS_BAR_PATTERN still anchors the footer boundary for priority 0.8.
// ===========================================================================
describe('detectSessionStatus - Codex selection list with v0.141 status bar (Issue #1150)', () => {
  const V0141_BAR = 'gpt-5.5 xhigh · ~/share/work/github_kewton/commandmate-issue-947';

  it('should detect the /model selection list above a v0.141 status bar (no "% left")', () => {
    const output = [
      'Select a model',
      '',
      '  ❯ gpt-5.5 (current)',
      '    gpt-5.4',
      '    codex-mini-latest',
      '',
      'press enter to confirm or esc to cancel',
      ...Array(10).fill(''),
      V0141_BAR,
    ].join('\n');

    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });
});
