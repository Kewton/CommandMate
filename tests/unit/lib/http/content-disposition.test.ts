/**
 * Unit tests for Content-Disposition helpers (Issue #1024)
 *
 * Verifies filename sanitization for attachment downloads:
 * - basename-only (path components stripped)
 * - CR/LF / control-char removal (header-injection defense)
 * - ASCII fallback (non-ASCII stripped, quotes/backslash neutralized)
 * - RFC 5987 percent-encoded `filename*` for non-ASCII names
 */

import { describe, it, expect } from 'vitest';
import {
  buildAttachmentContentDisposition,
  sanitizeAsciiFilename,
  sanitizeUtf8Filename,
} from '@/lib/http/content-disposition';

describe('sanitizeAsciiFilename', () => {
  it('keeps a simple ASCII filename unchanged', () => {
    expect(sanitizeAsciiFilename('report.txt')).toBe('report.txt');
  });

  it('reduces a path to its basename (POSIX and Windows separators stripped)', () => {
    expect(sanitizeAsciiFilename('a/b/c/report.txt')).toBe('report.txt');
    // Backslash is treated as a directory separator (defense vs. Windows-style
    // paths), so only the trailing component survives.
    expect(sanitizeAsciiFilename('a\\b\\c\\report.txt')).toBe('report.txt');
  });

  it('strips CR/LF and control characters (prevents header injection)', () => {
    const result = sanitizeAsciiFilename('evil\r\nSet-Cookie: x=1.txt');
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).toBe('evilSet-Cookie: x=1.txt');
  });

  it('strips non-ASCII characters from the fallback', () => {
    expect(sanitizeAsciiFilename('日本語ファイル.txt')).toBe('.txt');
  });

  it('neutralizes the double-quote that would break the quoted-string', () => {
    expect(sanitizeAsciiFilename('a"b.txt')).toBe('a_b.txt');
  });

  it('falls back to "download" when nothing printable remains', () => {
    expect(sanitizeAsciiFilename('日本語')).toBe('download');
    expect(sanitizeAsciiFilename('')).toBe('download');
  });
});

describe('sanitizeUtf8Filename', () => {
  it('percent-encodes a Japanese filename (UTF-8)', () => {
    const encoded = sanitizeUtf8Filename('レポート.txt');
    // Round-trips back to the original after decoding.
    expect(decodeURIComponent(encoded)).toBe('レポート.txt');
    expect(encoded).not.toMatch(/[^\x20-\x7e]/);
  });

  it('reduces to basename before encoding', () => {
    expect(sanitizeUtf8Filename('dir/レポート.txt')).toBe(
      sanitizeUtf8Filename('レポート.txt'),
    );
  });

  it('percent-encodes RFC 5987 reserved symbols ( ) * and quote', () => {
    const encoded = sanitizeUtf8Filename("f(o)*'.txt");
    expect(encoded).not.toContain('(');
    expect(encoded).not.toContain(')');
    expect(encoded).not.toContain('*');
    expect(encoded).not.toContain("'");
    expect(encoded).toContain('%28');
    expect(encoded).toContain('%29');
    expect(encoded).toContain('%2A');
    expect(encoded).toContain('%27');
  });

  it('strips control characters before encoding', () => {
    const encoded = sanitizeUtf8Filename('a\r\nb.txt');
    expect(encoded).toBe('ab.txt');
  });
});

describe('buildAttachmentContentDisposition', () => {
  it('produces attachment with both filename and filename* parameters', () => {
    const header = buildAttachmentContentDisposition('report.txt');
    expect(header).toBe(
      "attachment; filename=\"report.txt\"; filename*=UTF-8''report.txt",
    );
  });

  it('never contains raw CR/LF (header-injection safe)', () => {
    const header = buildAttachmentContentDisposition('a\r\nb.txt');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('encodes a Japanese filename in filename* and strips it in the ASCII fallback', () => {
    const header = buildAttachmentContentDisposition('日本語.txt');
    expect(header).toContain('filename="');
    expect(header).toContain("filename*=UTF-8''");
    // filename* must round-trip to the original.
    const match = header.match(/filename\*=UTF-8''(.+)$/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe('日本語.txt');
  });
});
