/**
 * Env Manager — content validation (Issue #1968).
 *
 * Covers the "不正な構文や危険な制御文字の入力時に適切なバリデーションエラー"
 * acceptance criterion, plus the invariant that an issue NEVER carries a value
 * (requirement 3: values must not reach a log or an error body).
 */

import { describe, it, expect } from 'vitest';
import {
  DANGEROUS_CONTROL_CHAR_PATTERN,
  ENV_MAX_ENTRIES,
  ENV_MAX_SIZE_BYTES,
  validateEnvContent,
  validateEnvPair,
} from '@/lib/env-manager/env-validator';

describe('validateEnvContent', () => {
  it('accepts a well-formed file', () => {
    const result = validateEnvContent('# comment\nA=1\nB="two words"\n');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((e) => e.key)).toEqual(['A', 'B']);
  });

  it('accepts an empty file', () => {
    expect(validateEnvContent('').valid).toBe(true);
  });

  describe('dangerous control characters', () => {
    it.each([
      ['NUL', '\x00'],
      ['BEL', '\x07'],
      ['backspace', '\x08'],
      ['vertical tab', '\x0B'],
      ['form feed', '\x0C'],
      ['ESC (terminal escape sequence)', '\x1B'],
      ['DEL', '\x7F'],
    ])('refuses %s in a value', (_label, char) => {
      const result = validateEnvContent(`A=safe\nB=bad${char}value\n`);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        line: 2,
        code: 'control-character',
        severity: 'error',
      });
    });

    it('allows tab, LF and CR, which are the format\'s own whitespace', () => {
      expect(DANGEROUS_CONTROL_CHAR_PATTERN.test('\t')).toBe(false);
      expect(DANGEROUS_CONTROL_CHAR_PATTERN.test('\n')).toBe(false);
      expect(DANGEROUS_CONTROL_CHAR_PATTERN.test('\r')).toBe(false);
      expect(validateEnvContent('A="tab\there"\n').valid).toBe(true);
    });

    it('reports the line but never the offending value', () => {
      const secret = 'sk-live-0123456789';
      const result = validateEnvContent(`TOKEN=${secret}\x1B[31m\n`);
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result.issues)).not.toContain(secret);
    });
  });

  describe('syntax', () => {
    it('refuses a line that is not an assignment', () => {
      const result = validateEnvContent('A=1\nthis is not an assignment\n');
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({ line: 2, code: 'invalid-syntax', severity: 'error' });
    });

    it('refuses an invalid variable name', () => {
      const result = validateEnvContent('9LIVES=cat\n');
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toMatchObject({ code: 'invalid-key', severity: 'error' });
    });

    it('refuses an unterminated quote', () => {
      const result = validateEnvContent('A="open forever\n');
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('unterminated-quote');
    });

    it('accepts a file whose only problem is a duplicate key (warning)', () => {
      const result = validateEnvContent('A=1\nA=2\n');
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([
        { line: 2, code: 'duplicate-key', severity: 'warning', key: 'A' },
      ]);
    });
  });

  describe('size limits', () => {
    it('refuses content past the byte ceiling', () => {
      const result = validateEnvContent(`A=${'x'.repeat(ENV_MAX_SIZE_BYTES)}`);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([{ line: null, code: 'too-large', severity: 'error' }]);
    });

    it('measures bytes, not code units', () => {
      // Three bytes per character in UTF-8, so a third of the ceiling in
      // characters is right at it.
      const chars = Math.ceil(ENV_MAX_SIZE_BYTES / 3);
      const result = validateEnvContent(`A=${'あ'.repeat(chars)}`);
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('too-large');
    });

    it('refuses too many entries', () => {
      const lines = Array.from({ length: ENV_MAX_ENTRIES + 1 }, (_, i) => `K${i}=v`).join('\n');
      const result = validateEnvContent(lines);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        line: null,
        code: 'too-many-entries',
        severity: 'error',
      });
    });
  });

  it('orders issues by line so the UI can point at the first problem', () => {
    const result = validateEnvContent('A=1\nnot-an-assignment\n9BAD=x\n');
    const lines = result.issues.map((issue) => issue.line);
    expect(lines).toEqual([...lines].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe('validateEnvPair', () => {
  it('passes a valid row', () => {
    expect(validateEnvPair('API_KEY', 'anything at all')).toEqual([]);
  });

  it('flags an invalid key', () => {
    expect(validateEnvPair('9BAD', 'x')).toEqual(['invalid-key']);
  });

  it('flags a control character in the value', () => {
    expect(validateEnvPair('OK', 'bad\x00value')).toEqual(['control-character']);
  });

  it('flags both at once', () => {
    expect(validateEnvPair('9BAD', 'bad\x1Bvalue')).toEqual(['invalid-key', 'control-character']);
  });
});
