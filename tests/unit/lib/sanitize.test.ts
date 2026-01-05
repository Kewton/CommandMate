/**
 * XSS Prevention Tests for sanitize.ts
 */

import { describe, it, expect } from 'vitest';
import { sanitizeTerminalOutput, sanitizeUserInput, containsDangerousContent } from '@/lib/sanitize';

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
    });
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
