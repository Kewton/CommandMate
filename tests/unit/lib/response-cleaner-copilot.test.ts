/**
 * Unit tests for cleanCopilotResponse
 * Issue #565: Copilot TUI artifact removal using normalizeCopilotLine + COPILOT_SKIP_PATTERNS
 */

import { describe, it, expect } from 'vitest';
import { cleanCopilotResponse, truncateMessage } from '@/lib/response-cleaner';
import { COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER } from '@/config/copilot-constants';

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

  // Issue #571: Latest response extraction — filter TUI decoration residue
  describe('Issue #571: latest response extraction', () => {
    it('should extract only content after the last ❯ prompt line', () => {
      const input = [
        '● Model changed to: gpt-5-mini (medium)',
        '❯ このブランチを解説して',
        '● ブランチ名、アップストリーム、直近コミット...',
        '● Get current branch, branch -vv, recent commits, status, and remotes (shell)',
        'git --no-pager symbolic-ref --short HEAD && echo \'--- branch -vv ---\'',
        '17 lines...',
        '◐ I realize I need to focus on creating a concise Japanese summary...',
        '● 要約（簡潔）：',
        '- 現在チェックアウト中のブランチ: develop',
        '- 直近はマージ中心の履歴...',
        '続けて詳しい差分・特定ブランチのコミット一覧・PR 内容の表示など対応可能です。',
        '❯ hello',
        'Hello! How can I help you with this repository?',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'Hello! How can I help you with this repository?'
      );
    });

    it('should skip ● tool-action lines (Get, Read, Run, etc.)', () => {
      const input = [
        '❯ explain this code',
        '● Read package.json',
        '● Get current directory structure (shell)',
        '● Here is the explanation of the code.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'Here is the explanation of the code.'
      );
    });

    it('should preserve ● lines with non-action content (actual response)', () => {
      const input = [
        '❯ 要約して',
        '● 要約（簡潔）：',
        '- ポイント1: テスト実装',
        '- ポイント2: リファクタリング',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        '要約（簡潔）：\n- ポイント1: テスト実装\n- ポイント2: リファクタリング'
      );
    });

    it('should skip ◐◑◒◓ thinking indicator lines', () => {
      const input = [
        '❯ fix the bug',
        '◐ Analyzing the code...',
        '◑ Still thinking...',
        '● The bug is on line 42.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe('The bug is on line 42.');
    });

    it('should skip "N lines..." fold markers', () => {
      const input = [
        '❯ show git log',
        '17 lines...',
        '3 lines...',
        'Here is the summary of recent commits.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'Here is the summary of recent commits.'
      );
    });

    it('should skip shell command output lines', () => {
      const input = [
        '❯ check the branch',
        'git --no-pager symbolic-ref --short HEAD',
        'npm run test:unit',
        'The current branch is develop.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'The current branch is develop.'
      );
    });

    it('should skip ● Model changed to: lines', () => {
      const input = [
        '● Model changed to: gpt-5-mini (medium)',
        '❯ hello',
        'Hi there!',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe('Hi there!');
    });

    it('should skip ❯ prompt lines that leak through after extraction', () => {
      const input = [
        '❯ first question',
        'First answer.',
        '❯ second question',
        'Second answer.',
        '❯',  // empty prompt at end
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe('Second answer.');
    });

    it('should handle content with no ❯ prompt (fallback to full content)', () => {
      const input = [
        'This is content without any prompt marker.',
        'It should be returned as-is.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'This is content without any prompt marker.\nIt should be returned as-is.'
      );
    });

    it('should handle the full real-world example from the issue', () => {
      const input = [
        '● Model changed to: gpt-5-mini (medium)',
        '❯ このブランチを解説して',
        '● ブランチ名、アップストリーム、直近コミット...',
        '● Get current branch, branch -vv, recent commits, status, and remotes (shell)',
        'git --no-pager symbolic-ref --short HEAD && echo \'--- branch -vv ---\'',
        '17 lines...',
        '◐ I realize I need to focus on creating a concise Japanese summary...',
        '● 要約（簡潔）：',
        '- 現在チェックアウト中のブランチ: develop',
        '- 直近はマージ中心の履歴...',
        '続けて詳しい差分・特定ブランチのコミット一覧・PR 内容の表示など対応可能です。',
        '❯ hello',
        '◐ thinking about what to say...',
        '● Hello! How can I help you with this repository?',
        'Feel free to ask about code, branches, or anything else.',
      ].join('\n');

      expect(cleanCopilotResponse(input)).toBe(
        'Hello! How can I help you with this repository?\nFeel free to ask about code, branches, or anything else.'
      );
    });
  });

  // Issue #571: New COPILOT_SKIP_PATTERNS for disclaimer, init message, environment info
  describe('Issue #571: COPILOT_SKIP_PATTERNS additions', () => {
    it('should skip Copilot disclaimer text', () => {
      const input = [
        'Copilot uses AI, so always check for mistakes.',
        'Here is the actual response.',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Here is the actual response.');
    });

    it('should skip initialization message lines starting with bullet lightbulb', () => {
      const input = [
        '\u25CF \uD83D\uDCA1 You can use /help to see available commands',
        'Actual content here',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Actual content here');
    });

    it('should skip environment loaded lines', () => {
      const input = [
        '\u25CF Environment loaded: .copilot/.env',
        'Response content',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('Response content');
    });

    it('should skip all three new patterns together', () => {
      const input = [
        'Copilot uses AI, so always check for mistakes.',
        '\u25CF \uD83D\uDCA1 Quick tip: use /model to switch models',
        '\u25CF Environment loaded: .env.local',
        'The analysis shows the bug is on line 42.',
      ].join('\n');
      expect(cleanCopilotResponse(input)).toBe('The analysis shows the bug is on line 42.');
    });

    it('should NOT skip user content that mentions Copilot AI', () => {
      // Partial match should not trigger skip - only full line match
      const input = 'Copilot uses AI, so always check for mistakes. But here is more text.';
      expect(cleanCopilotResponse(input)).toBe('Copilot uses AI, so always check for mistakes. But here is more text.');
    });
  });

});

// Issue #571: truncateMessage tests
describe('truncateMessage', () => {
  const MARKER = COPILOT_TRUNCATION_MARKER;

  it('should return content as-is when within maxLength', () => {
    const content = 'Short message';
    expect(truncateMessage(content, 100, MARKER)).toBe(content);
  });

  it('should return content as-is when exactly at maxLength', () => {
    const content = 'a'.repeat(100);
    expect(truncateMessage(content, 100, MARKER)).toBe(content);
  });

  it('should truncate content exceeding maxLength with marker + tail', () => {
    // Create a string longer than maxLength
    const maxLen = 50;
    const content = 'HEAD_CONTENT_' + 'x'.repeat(40) + '_TAIL_END';
    const result = truncateMessage(content, maxLen, MARKER);

    // Result should start with marker
    expect(result.startsWith(MARKER + '\n')).toBe(true);
    // Result should end with the tail of the original content
    expect(result.endsWith('_TAIL_END')).toBe(true);
    // Result length should be <= maxLength
    expect(result.length).toBeLessThanOrEqual(maxLen);
  });

  it('should handle empty string', () => {
    expect(truncateMessage('', 100, MARKER)).toBe('');
  });

  it('should handle surrogate pairs at boundary correctly', () => {
    // Create content with emoji (surrogate pair) near the cut point
    const maxLen = 30;
    const emoji = '\uD83D\uDE00'; // U+1F600 grinning face
    // Place emoji so that a naive slice would cut it in half
    const content = 'a'.repeat(25) + emoji + 'b'.repeat(20);
    const result = truncateMessage(content, maxLen, MARKER);

    // Result should not contain broken surrogate pairs
    // Check there's no lone high surrogate (U+D800-U+DBFF) or low surrogate (U+DC00-U+DFFF)
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        // High surrogate must be followed by low surrogate
        const next = result.charCodeAt(i + 1);
        expect(next >= 0xDC00 && next <= 0xDFFF).toBe(true);
      }
      if (code >= 0xDC00 && code <= 0xDFFF) {
        // Low surrogate must be preceded by high surrogate
        const prev = result.charCodeAt(i - 1);
        expect(prev >= 0xD800 && prev <= 0xDBFF).toBe(true);
      }
    }
    expect(result.length).toBeLessThanOrEqual(maxLen);
  });

  it('should use default COPILOT_MAX_MESSAGE_LENGTH and COPILOT_TRUNCATION_MARKER', () => {
    // Verify constants are exported correctly
    expect(COPILOT_MAX_MESSAGE_LENGTH).toBe(100_000);
    expect(COPILOT_TRUNCATION_MARKER).toBe('[... truncated ...]');
  });

  it('should preserve the tail (most recent content) when truncating', () => {
    const maxLen = 40;
    const tail = 'IMPORTANT_TAIL';
    const content = 'x'.repeat(100) + tail;
    const result = truncateMessage(content, maxLen, MARKER);

    expect(result).toContain(tail);
    expect(result.startsWith(MARKER + '\n')).toBe(true);
  });
});
