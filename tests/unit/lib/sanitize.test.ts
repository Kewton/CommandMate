/**
 * XSS Prevention Tests for sanitize.ts
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeTerminalOutput,
  truncateTerminalOutput,
  sanitizeUserInput,
  containsDangerousContent,
} from '@/lib/security/sanitize';
import {
  MAX_TERMINAL_OUTPUT_LENGTH,
  TERMINAL_TRUNCATION_MARKER,
} from '@/config/terminal-output-config';

describe('sanitizeTerminalOutput', () => {
  describe('XSS攻撃ベクター対策（HTMLエスケープ）', () => {
    // Note: ansi-to-html with escapeXML:true converts < to &lt;, > to &gt;
    // This means dangerous HTML tags become harmless text when rendered
    // The tests verify that actual HTML tags are escaped, not that the text is removed

    it('should escape script tags to HTML entities', () => {
      const malicious = '<script>alert("xss")</script>';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual executable script tags
      expect(result).not.toContain('<script>');
      // Should contain the escaped version (safe as text)
      expect(result).toContain('&lt;script&gt;');
    });

    it('should escape script tags within ANSI codes', () => {
      const malicious = '\x1b[31m<script>alert("xss")</script>\x1b[0m';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual executable script tags
      expect(result).not.toContain('<script>');
    });

    it('should escape img tags (img is not allowed)', () => {
      const malicious = '<img src="x" onerror="alert(1)">';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual img tag
      expect(result).not.toContain('<img');
    });

    it('should escape svg tags (svg is not allowed)', () => {
      const malicious = '<svg onload="alert(1)">';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual svg tag
      expect(result).not.toContain('<svg');
    });

    it('should escape a tags (anchor is not allowed)', () => {
      const malicious = '<a href="javascript:alert(1)">click</a>';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual anchor tag
      expect(result).not.toContain('<a ');
      expect(result).not.toContain('</a>');
    });

    it('should escape div tags (div is not allowed)', () => {
      const malicious = '<div onclick="alert(1)">click me</div>';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual div tag
      expect(result).not.toContain('<div');
      expect(result).not.toContain('</div>');
    });

    it('should handle encoded attacks', () => {
      const malicious = '&lt;script&gt;alert(1)&lt;/script&gt;';
      const result = sanitizeTerminalOutput(malicious);
      // Double-encoded should remain safe - no actual script tags
      expect(result).not.toMatch(/<script>/i);
    });

    it('should escape unicode script tags', () => {
      // Unicode escape sequences that form <script>
      const malicious = '\u003cscript\u003ealert(1)\u003c/script\u003e';
      const result = sanitizeTerminalOutput(malicious);
      // Should NOT contain actual executable script tags
      expect(result).not.toContain('<script>');
    });

    it('should escape iframe tags', () => {
      const malicious = '<iframe src="https://evil.com"></iframe>';
      const result = sanitizeTerminalOutput(malicious);
      expect(result).not.toContain('<iframe');
    });

    it('should escape object tags', () => {
      const malicious = '<object data="evil.swf"></object>';
      const result = sanitizeTerminalOutput(malicious);
      expect(result).not.toContain('<object');
    });

    it('should escape embed tags', () => {
      const malicious = '<embed src="evil.swf">';
      const result = sanitizeTerminalOutput(malicious);
      expect(result).not.toContain('<embed');
    });

    it('should escape form tags', () => {
      const malicious = '<form action="https://evil.com"><input></form>';
      const result = sanitizeTerminalOutput(malicious);
      expect(result).not.toContain('<form');
    });

    it('should escape meta tags', () => {
      const malicious = '<meta http-equiv="refresh" content="0;url=https://evil.com">';
      const result = sanitizeTerminalOutput(malicious);
      expect(result).not.toContain('<meta');
    });

    it('should only allow span and br tags after DOMPurify', () => {
      // This tests that DOMPurify only keeps span/br
      const input = 'Normal text\nwith newline';
      const result = sanitizeTerminalOutput(input);
      // Only text, span, and br should be present
      expect(result).toContain('Normal text');
      // Should not introduce any unexpected tags
      expect(result).not.toMatch(/<(?!span|br|\/span)[a-z]/i);
    });
  });

  describe('正常なANSI出力の保持', () => {
    it('should preserve red colored text', () => {
      const input = '\x1b[31mError: Something went wrong\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Error: Something went wrong');
      expect(result).toContain('style=');  // 色スタイルが適用されている
    });

    it('should preserve green colored text', () => {
      const input = '\x1b[32mSuccess!\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Success!');
    });

    it('should preserve bold text', () => {
      const input = '\x1b[1mBold Text\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Bold Text');
    });

    it('should preserve multiple colors', () => {
      const input = '\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[34mBlue\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Red');
      expect(result).toContain('Green');
      expect(result).toContain('Blue');
    });

    it('should preserve newlines', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
    });

    it('should preserve yellow warning text', () => {
      const input = '\x1b[33mWarning: Check this\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Warning: Check this');
    });

    it('should preserve cyan info text', () => {
      const input = '\x1b[36mInfo: Process started\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Info: Process started');
    });
  });

  describe('エッジケース', () => {
    it('should handle empty string', () => {
      const result = sanitizeTerminalOutput('');
      expect(result).toBe('');
    });

    it('should handle very long output', () => {
      const longText = 'a'.repeat(100000);
      const result = sanitizeTerminalOutput(longText);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle nested ANSI codes', () => {
      const input = '\x1b[31m\x1b[1mBold Red\x1b[0m\x1b[0m';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Bold Red');
    });

    it('should handle malformed ANSI codes', () => {
      const input = '\x1b[Red text without proper code';
      const result = sanitizeTerminalOutput(input);
      // Should not throw and should handle gracefully
      expect(typeof result).toBe('string');
    });

    it('should handle mixed valid and invalid ANSI codes', () => {
      const input = '\x1b[31mValid Red\x1b[0m and \x1b[invalid code';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('Valid Red');
    });

    it('should handle special characters', () => {
      const input = 'Special: <>&"\'';
      const result = sanitizeTerminalOutput(input);
      // Special chars should be escaped
      expect(result).not.toContain('<>');
    });

    it('should handle null bytes', () => {
      const input = 'Text\x00with\x00null';
      const result = sanitizeTerminalOutput(input);
      expect(typeof result).toBe('string');
      // Null bytes should be removed from the output
      expect(result).not.toContain('\x00');
      expect(result).toContain('Textwithnull');
    });

    it('should remove null bytes from input', () => {
      const input = 'hello\x00world';
      const result = sanitizeTerminalOutput(input);
      expect(result).toContain('helloworld');
      expect(result).not.toContain('\x00');
    });

    it('should truncate oversized input', () => {
      // 2MB input
      const input = 'a'.repeat(2 * 1024 * 1024);
      const result = sanitizeTerminalOutput(input);
      // Output should be at most 1MB worth of content (after sanitization).
      // Issue #1674: the kept text is `marker + '\n' + tail`, capped at
      // MAX_TERMINAL_OUTPUT_LENGTH; the '\n' becomes '<br>' so the HTML is a
      // handful of characters longer than the text cap.
      expect(result.length).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_LENGTH + 8);
    });

    it('should return empty string for empty input', () => {
      const result = sanitizeTerminalOutput('');
      expect(result).toBe('');
    });
  });

  // ==========================================================================
  // [Issue #1674] 1MB 超は末尾（最新）を残して先頭（最古）を捨てる
  // ==========================================================================

  describe('[Issue #1674] oversized output keeps the tail', () => {
    /**
     * Length of the real capture that exposed the defect
     * (`mcbd-codex-commandagent-develop`, measured via
     * `/api/worktrees/.../current-output`).
     */
    const REAL_CAPTURE_LENGTH = 1_182_902;
    /** The 24-bit SGR sequence that straddled the cut point in that capture. */
    const SGR = '\x1b[38;2;205;214;244m';
    const HEAD_SENTINEL = 'OLDEST-LINE-DROPPED-FIRST';
    const TAIL_SENTINEL = 'Goal blocked (/goal resume)';

    /** Index the truncation cuts at *before* line alignment. */
    const rawCutIndex = (totalLength: number): number =>
      totalLength - (MAX_TERMINAL_OUTPUT_LENGTH - (TERMINAL_TRUNCATION_MARKER.length + 1));

    /**
     * Build a capture-shaped fixture of exactly `totalLength` characters whose
     * raw cut point lands strictly inside an ANSI SGR sequence, as the real one
     * did (`...43m+\x1b[38;2;205;214;2` | `44m    \x1b[38;2;147;15`).
     */
    function buildOversizedCapture(totalLength = REAL_CAPTURE_LENGTH): string {
      const head = `${HEAD_SENTINEL}\n`;
      const tail = `\n\x1b[38;5;5m${TAIL_SENTINEL}\x1b[39m\n`;
      const line = `${SGR}        "uat-console.log"     15 \x1b[0m`;
      const fillerLength = totalLength - head.length - tail.length;
      let filler = '';
      while (filler.length + line.length + 1 <= fillerLength) filler += `${line}\n`;
      filler += '.'.repeat(fillerLength - filler.length);

      const capture = head + filler + tail;
      const at = rawCutIndex(totalLength) - 10;
      return capture.slice(0, at) + SGR + capture.slice(at + SGR.length);
    }

    const capture = buildOversizedCapture();

    it('fixture matches the measured capture: 1,182,902 chars, cut inside an SGR sequence', () => {
      expect(capture.length).toBe(REAL_CAPTURE_LENGTH);
      expect(capture.length).toBeGreaterThan(MAX_TERMINAL_OUTPUT_LENGTH);
      const cut = rawCutIndex(REAL_CAPTURE_LENGTH);
      // A character-exact cut would land 10 chars into this escape sequence.
      expect(capture.slice(cut - 10, cut - 10 + SGR.length)).toBe(SGR);
      expect(capture[cut]).not.toBe('\n');
    });

    it('renders the newest output and drops the oldest', () => {
      const html = sanitizeTerminalOutput(capture);
      expect(html).toContain(TAIL_SENTINEL);
      expect(html).not.toContain(HEAD_SENTINEL);
    }, 30_000);

    it('cuts on a line boundary, never inside an ANSI sequence', () => {
      const truncated = truncateTerminalOutput(capture);
      expect(truncated.startsWith(`${TERMINAL_TRUNCATION_MARKER}\n`)).toBe(true);

      const kept = truncated.slice(TERMINAL_TRUNCATION_MARKER.length + 1);
      const start = capture.length - kept.length;
      // The kept part is a pure suffix of the input...
      expect(capture.slice(start)).toBe(kept);
      // ...that begins right after a newline (an escape never spans one).
      expect(capture[start - 1]).toBe('\n');
      expect(truncated.length).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_LENGTH);
    });

    it('does not leak the straddled sequence parameter bytes into the HTML', () => {
      // Before the fix this rendered a literal `+2;205;214;2` as the last line.
      expect(sanitizeTerminalOutput(capture)).not.toContain('205;214;244m');
    }, 30_000);

    it('a tail beginning inside an ANSI sequence leaks its bytes as text (why alignment matters)', () => {
      expect(sanitizeTerminalOutput('2;205;214;244m    rest')).toContain('2;205;214;244m');
    });

    it('tells the user that output was dropped', () => {
      // DOMPurify may serialize the Japanese half as numeric entities depending
      // on the surrounding markup, so the HTML assertion uses the ASCII half and
      // the exact marker is pinned at the pre-HTML layer.
      expect(sanitizeTerminalOutput(capture)).toContain('older output truncated');
      expect(truncateTerminalOutput(capture).startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    }, 30_000);

    it('leaves input at or below the cap byte-for-byte unchanged', () => {
      const atCap = 'x'.repeat(MAX_TERMINAL_OUTPUT_LENGTH);
      expect(truncateTerminalOutput(atCap)).toBe(atCap);
      const justUnder = `y\n${'z'.repeat(MAX_TERMINAL_OUTPUT_LENGTH - 3)}`;
      expect(justUnder.length).toBe(MAX_TERMINAL_OUTPUT_LENGTH - 1);
      expect(truncateTerminalOutput(justUnder)).toBe(justUnder);
      expect(truncateTerminalOutput('')).toBe('');
    }, 30_000);

    it('renders sub-cap output exactly as before the fix', () => {
      expect(sanitizeTerminalOutput('\x1b[31mError\x1b[0m\nline2\n')).toBe(
        '<span style="color:#A00">Error</span><br>line2<br>'
      );
      expect(sanitizeTerminalOutput('plain line\nsecond\n')).toBe('plain line<br>second<br>');
      expect(sanitizeTerminalOutput('\x1b[31mError\x1b[0m')).not.toContain('older output truncated');
    });

    it('truncates input that is a single character over the cap', () => {
      const over = `a\n${'b'.repeat(MAX_TERMINAL_OUTPUT_LENGTH - 1)}`;
      expect(over.length).toBe(MAX_TERMINAL_OUTPUT_LENGTH + 1);
      const truncated = truncateTerminalOutput(over);
      expect(truncated.startsWith(`${TERMINAL_TRUNCATION_MARKER}\n`)).toBe(true);
      expect(truncated.endsWith('b')).toBe(true);
      expect(truncated.length).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_LENGTH);
    }, 30_000);

    it('falls back to an escape-aware cut when the tail has no line boundary', () => {
      const total = MAX_TERMINAL_OUTPUT_LENGTH + 200_000;
      const cut = rawCutIndex(total);
      const single =
        'z'.repeat(cut - 10) + SGR + 'z'.repeat(total - (cut - 10) - SGR.length);
      expect(single.length).toBe(total);
      expect(single.includes('\n')).toBe(false);

      const kept = truncateTerminalOutput(single).slice(TERMINAL_TRUNCATION_MARKER.length + 1);
      // The cut is pushed past the whole sequence instead of splitting it.
      expect(kept.startsWith('z')).toBe(true);
      expect(sanitizeTerminalOutput(single)).not.toContain('214;244m');
    }, 30_000);

    it('does not split a surrogate pair when no line boundary is available', () => {
      const total = MAX_TERMINAL_OUTPUT_LENGTH + 100_000;
      const cut = rawCutIndex(total);
      // '😀' is a surrogate pair; its low half sits exactly on the cut.
      const single = 'a'.repeat(cut - 1) + '😀' + 'a'.repeat(total - (cut - 1) - 2);
      expect(single.length).toBe(total);
      expect(single.charCodeAt(cut)).toBe(0xde00);

      const kept = truncateTerminalOutput(single).slice(TERMINAL_TRUNCATION_MARKER.length + 1);
      expect(kept.includes('\udc00')).toBe(false);
      expect(kept.includes('\ude00')).toBe(false);
      expect(kept.startsWith('a')).toBe(true);
    }, 30_000);
  });
});

describe('sanitizeUserInput', () => {
  it('should strip all HTML tags', () => {
    const input = '<b>Bold</b> and <i>italic</i>';
    const result = sanitizeUserInput(input);
    expect(result).not.toContain('<b>');
    expect(result).not.toContain('<i>');
  });

  it('should strip script tags', () => {
    const input = '<script>alert(1)</script>';
    const result = sanitizeUserInput(input);
    expect(result).not.toContain('<script>');
  });

  it('should preserve plain text', () => {
    const input = 'Hello, World!';
    const result = sanitizeUserInput(input);
    expect(result).toBe('Hello, World!');
  });

  it('should handle empty input', () => {
    const result = sanitizeUserInput('');
    expect(result).toBe('');
  });

  it('should strip nested tags', () => {
    const input = '<div><span><script>alert(1)</script></span></div>';
    const result = sanitizeUserInput(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('should preserve text content after stripping tags', () => {
    const input = '<p>Hello</p> <span>World</span>';
    const result = sanitizeUserInput(input);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('should handle Japanese characters', () => {
    const input = 'こんにちは世界';
    const result = sanitizeUserInput(input);
    expect(result).toBe('こんにちは世界');
  });

  it('should handle emoji', () => {
    const input = 'Hello 👋 World 🌍';
    const result = sanitizeUserInput(input);
    expect(result).toContain('👋');
    expect(result).toContain('🌍');
  });
});

describe('containsDangerousContent', () => {
  it('should detect script tags', () => {
    expect(containsDangerousContent('<script>alert(1)</script>')).toBe(true);
  });

  it('should detect javascript: URLs', () => {
    expect(containsDangerousContent('javascript:alert(1)')).toBe(true);
  });

  it('should detect onclick handlers', () => {
    expect(containsDangerousContent('onclick="alert(1)"')).toBe(true);
  });

  it('should detect onerror handlers', () => {
    expect(containsDangerousContent('onerror = "alert(1)"')).toBe(true);
  });

  it('should detect iframe tags', () => {
    expect(containsDangerousContent('<iframe src="evil.com">')).toBe(true);
  });

  it('should detect object tags', () => {
    expect(containsDangerousContent('<object data="evil.swf">')).toBe(true);
  });

  it('should detect embed tags', () => {
    expect(containsDangerousContent('<embed src="evil">')).toBe(true);
  });

  it('should detect data:text/html', () => {
    expect(containsDangerousContent('data:text/html,<script>')).toBe(true);
  });

  it('should not flag safe content', () => {
    expect(containsDangerousContent('Hello, World!')).toBe(false);
  });

  it('should not flag ANSI codes', () => {
    expect(containsDangerousContent('\x1b[31mRed text\x1b[0m')).toBe(false);
  });

  it('should not flag normal HTML-like text', () => {
    expect(containsDangerousContent('Use <tag> in XML')).toBe(false);
  });
});
