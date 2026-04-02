/**
 * Tests for message-preview-config
 *
 * Validates preview truncation constants and sanitizePreview function.
 * Issue #606: Sessions page enhancement
 */

import { describe, it, expect } from 'vitest';
import {
  MESSAGE_PREVIEW_MAX_LENGTH_PC,
  MESSAGE_PREVIEW_MAX_LENGTH_SP,
  sanitizePreview,
} from '@/config/message-preview-config';

// ============================================================================
// Constants
// ============================================================================

describe('message-preview-config constants', () => {
  it('should define PC preview max length as a positive integer', () => {
    expect(MESSAGE_PREVIEW_MAX_LENGTH_PC).toBeGreaterThan(0);
    expect(Number.isInteger(MESSAGE_PREVIEW_MAX_LENGTH_PC)).toBe(true);
  });

  it('should define SP preview max length as a positive integer', () => {
    expect(MESSAGE_PREVIEW_MAX_LENGTH_SP).toBeGreaterThan(0);
    expect(Number.isInteger(MESSAGE_PREVIEW_MAX_LENGTH_SP)).toBe(true);
  });

  it('should have PC length >= SP length', () => {
    expect(MESSAGE_PREVIEW_MAX_LENGTH_PC).toBeGreaterThanOrEqual(
      MESSAGE_PREVIEW_MAX_LENGTH_SP
    );
  });
});

// ============================================================================
// sanitizePreview
// ============================================================================

describe('sanitizePreview', () => {
  it('should return plain text unchanged', () => {
    expect(sanitizePreview('Hello world')).toBe('Hello world');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(sanitizePreview('  hello  ')).toBe('hello');
  });

  it('should normalize newlines to spaces', () => {
    expect(sanitizePreview('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('should normalize carriage returns to spaces', () => {
    expect(sanitizePreview('line1\r\nline2')).toBe('line1 line2');
  });

  it('should normalize tabs to spaces', () => {
    expect(sanitizePreview('col1\tcol2\tcol3')).toBe('col1 col2 col3');
  });

  it('should collapse multiple spaces into one', () => {
    expect(sanitizePreview('hello    world')).toBe('hello world');
  });

  it('should collapse mixed whitespace into one space', () => {
    expect(sanitizePreview('a\n\n\t  b')).toBe('a b');
  });

  // Security: C0/C1 control character removal
  it('should remove NUL character (\\x00)', () => {
    expect(sanitizePreview('hello\x00world')).toBe('helloworld');
  });

  it('should remove bell character (\\x07)', () => {
    expect(sanitizePreview('hello\x07world')).toBe('helloworld');
  });

  it('should remove backspace (\\x08)', () => {
    expect(sanitizePreview('hello\x08world')).toBe('helloworld');
  });

  it('should remove C1 control characters (\\x80-\\x9F)', () => {
    expect(sanitizePreview('hello\x80\x8F\x9Fworld')).toBe('helloworld');
  });

  it('should remove escape character (\\x1B)', () => {
    expect(sanitizePreview('hello\x1Bworld')).toBe('helloworld');
  });

  // Security: zero-width and bidi character removal
  it('should remove zero-width space (\\u200B)', () => {
    expect(sanitizePreview('hello\u200Bworld')).toBe('helloworld');
  });

  it('should remove zero-width non-joiner (\\u200C)', () => {
    expect(sanitizePreview('hello\u200Cworld')).toBe('helloworld');
  });

  it('should remove zero-width joiner (\\u200D)', () => {
    expect(sanitizePreview('hello\u200Dworld')).toBe('helloworld');
  });

  it('should remove left-to-right mark (\\u200E)', () => {
    expect(sanitizePreview('hello\u200Eworld')).toBe('helloworld');
  });

  it('should remove right-to-left mark (\\u200F)', () => {
    expect(sanitizePreview('hello\u200Fworld')).toBe('helloworld');
  });

  it('should remove bidi override characters (\\u202A-\\u202E)', () => {
    expect(sanitizePreview('hello\u202A\u202B\u202C\u202D\u202Eworld')).toBe('helloworld');
  });

  it('should remove BOM (\\uFEFF)', () => {
    expect(sanitizePreview('\uFEFFhello world')).toBe('hello world');
  });

  it('should remove Arabic letter mark (\\u061C)', () => {
    expect(sanitizePreview('hello\u061Cworld')).toBe('helloworld');
  });

  // Edge cases
  it('should return empty string for empty input', () => {
    expect(sanitizePreview('')).toBe('');
  });

  it('should return empty string for whitespace-only input', () => {
    expect(sanitizePreview('   \n\t\r  ')).toBe('');
  });

  it('should return empty string for control-chars-only input', () => {
    expect(sanitizePreview('\x00\x01\x02')).toBe('');
  });

  it('should handle combined control chars, bidi, and normal text', () => {
    const input = '\uFEFF\u200BHello\x00\n\u202Aworld\x1B!';
    expect(sanitizePreview(input)).toBe('Hello world!');
  });

  it('should preserve non-ASCII text (Japanese)', () => {
    expect(sanitizePreview('Hello')).toBe('Hello');
  });
});
