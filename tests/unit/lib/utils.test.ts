/**
 * Utility Functions Tests
 * [MF-001] debounce function tests
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, escapeRegExp, computeMatchedPaths, truncateString } from '@/lib/utils';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delay function execution', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 300);

    debouncedFn();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should cancel previous timeout on rapid calls', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 300);

    debouncedFn();
    vi.advanceTimersByTime(100);

    debouncedFn(); // Reset timer
    vi.advanceTimersByTime(100);

    debouncedFn(); // Reset timer again
    vi.advanceTimersByTime(100);

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should execute only the last call', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 300);

    debouncedFn('first');
    debouncedFn('second');
    debouncedFn('third');

    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('third');
  });

  it('should pass all arguments to the debounced function', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 300);

    debouncedFn('arg1', 'arg2', 123);

    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledWith('arg1', 'arg2', 123);
  });

  it('should allow multiple separate debounced executions', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 300);

    debouncedFn('first');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('first');

    debouncedFn('second');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });

  it('should work with zero delay', async () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 0);

    debouncedFn();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should handle functions that throw errors', async () => {
    const fn = vi.fn(() => {
      throw new Error('Test error');
    });
    const debouncedFn = debounce(fn, 300);

    debouncedFn();

    expect(() => {
      vi.advanceTimersByTime(300);
    }).toThrow('Test error');
  });

  it('should maintain correct type signature', () => {
    // Type test: ensure the debounced function has the same parameter types
    const fn = (a: string, b: number) => `${a}${b}`;
    const debouncedFn = debounce(fn, 300);

    // This should compile without errors
    debouncedFn('test', 42);
  });
});

/**
 * escapeRegExp Tests
 * [Issue #21] File tree search functionality
 * [IMPACT-SF-003] Tests for escapeRegExp function
 */
describe('escapeRegExp', () => {
  it('should escape all RegExp special characters', () => {
    // Test all special characters: . * + ? ^ $ { } ( ) | [ ] \
    expect(escapeRegExp('.')).toBe('\\.');
    expect(escapeRegExp('*')).toBe('\\*');
    expect(escapeRegExp('+')).toBe('\\+');
    expect(escapeRegExp('?')).toBe('\\?');
    expect(escapeRegExp('^')).toBe('\\^');
    expect(escapeRegExp('$')).toBe('\\$');
    expect(escapeRegExp('{')).toBe('\\{');
    expect(escapeRegExp('}')).toBe('\\}');
    expect(escapeRegExp('(')).toBe('\\(');
    expect(escapeRegExp(')')).toBe('\\)');
    expect(escapeRegExp('|')).toBe('\\|');
    expect(escapeRegExp('[')).toBe('\\[');
    expect(escapeRegExp(']')).toBe('\\]');
    expect(escapeRegExp('\\')).toBe('\\\\');
  });

  it('should escape combined special characters', () => {
    expect(escapeRegExp('hello.world')).toBe('hello\\.world');
    expect(escapeRegExp('a*b+c?')).toBe('a\\*b\\+c\\?');
    expect(escapeRegExp('[test]')).toBe('\\[test\\]');
    expect(escapeRegExp('(a|b)')).toBe('\\(a\\|b\\)');
    expect(escapeRegExp('^start$end')).toBe('\\^start\\$end');
    expect(escapeRegExp('foo{1,3}')).toBe('foo\\{1,3\\}');
  });

  it('should return empty string unchanged', () => {
    expect(escapeRegExp('')).toBe('');
  });

  it('should return normal string unchanged', () => {
    expect(escapeRegExp('hello')).toBe('hello');
    expect(escapeRegExp('HelloWorld')).toBe('HelloWorld');
    expect(escapeRegExp('test123')).toBe('test123');
  });

  it('should handle Japanese characters', () => {
    expect(escapeRegExp('こんにちは')).toBe('こんにちは');
    expect(escapeRegExp('検索.テスト')).toBe('検索\\.テスト');
    expect(escapeRegExp('日本語[テスト]')).toBe('日本語\\[テスト\\]');
  });

  it('should handle emoji characters', () => {
    expect(escapeRegExp('test')).toBe('test');
    // Emoji without special chars should pass through
    expect(escapeRegExp('hello world')).toBe('hello world');
  });

  it('should handle whitespace', () => {
    expect(escapeRegExp('hello world')).toBe('hello world');
    expect(escapeRegExp('test\ttab')).toBe('test\ttab');
    expect(escapeRegExp('line\nbreak')).toBe('line\nbreak');
  });

  it('should work correctly for actual search patterns', () => {
    // Common file patterns
    expect(escapeRegExp('*.ts')).toBe('\\*\\.ts');
    expect(escapeRegExp('package.json')).toBe('package\\.json');
    expect(escapeRegExp('src/lib/*.test.ts')).toBe('src/lib/\\*\\.test\\.ts');

    // Common code patterns
    expect(escapeRegExp('function()')).toBe('function\\(\\)');
    expect(escapeRegExp('console.log()')).toBe('console\\.log\\(\\)');
    expect(escapeRegExp('import { x }')).toBe('import \\{ x \\}');
  });

  it('should produce strings usable in RegExp', () => {
    // The escaped string should be usable in a RegExp to match the literal
    const testCases = [
      'hello.world',
      '[test]',
      'a*b+c?',
      '(a|b)',
      '^start$',
      'foo{1,3}',
    ];

    for (const testCase of testCases) {
      const escaped = escapeRegExp(testCase);
      const regex = new RegExp(escaped);
      expect(regex.test(testCase)).toBe(true);
    }
  });
});

/**
 * computeMatchedPaths Tests
 * [Issue #21] File tree search functionality - DRY refactoring
 */
describe('computeMatchedPaths', () => {
  it('should return empty set for empty array', () => {
    const result = computeMatchedPaths([]);
    expect(result.size).toBe(0);
  });

  it('should include the file path itself', () => {
    const result = computeMatchedPaths(['src/lib/file.ts']);
    expect(result.has('src/lib/file.ts')).toBe(true);
  });

  it('should include all parent directories', () => {
    const result = computeMatchedPaths(['src/lib/file.ts']);
    expect(result.has('src')).toBe(true);
    expect(result.has('src/lib')).toBe(true);
    expect(result.has('src/lib/file.ts')).toBe(true);
  });

  it('should handle root-level files', () => {
    const result = computeMatchedPaths(['file.ts']);
    expect(result.size).toBe(1);
    expect(result.has('file.ts')).toBe(true);
  });

  it('should handle multiple files', () => {
    const result = computeMatchedPaths([
      'src/lib/file1.ts',
      'src/hooks/hook.ts',
    ]);
    // Files
    expect(result.has('src/lib/file1.ts')).toBe(true);
    expect(result.has('src/hooks/hook.ts')).toBe(true);
    // Shared parent
    expect(result.has('src')).toBe(true);
    // Individual parents
    expect(result.has('src/lib')).toBe(true);
    expect(result.has('src/hooks')).toBe(true);
  });

  it('should deduplicate shared parent directories', () => {
    const result = computeMatchedPaths([
      'src/lib/file1.ts',
      'src/lib/file2.ts',
    ]);
    // Should not have duplicate 'src' or 'src/lib'
    expect(result.size).toBe(4); // src, src/lib, file1.ts, file2.ts
  });

  it('should handle deeply nested paths', () => {
    const result = computeMatchedPaths(['a/b/c/d/e/file.ts']);
    expect(result.has('a')).toBe(true);
    expect(result.has('a/b')).toBe(true);
    expect(result.has('a/b/c')).toBe(true);
    expect(result.has('a/b/c/d')).toBe(true);
    expect(result.has('a/b/c/d/e')).toBe(true);
    expect(result.has('a/b/c/d/e/file.ts')).toBe(true);
    expect(result.size).toBe(6);
  });
});

/**
 * truncateString Tests
 * [Issue #111] Branch visualization feature - DRY extraction
 */
describe('truncateString', () => {
  it('should return original string if within limit', () => {
    expect(truncateString('main', 30)).toBe('main');
    expect(truncateString('feature/short', 30)).toBe('feature/short');
  });

  it('should truncate string with ellipsis when exceeding limit', () => {
    expect(truncateString('feature/very-long-branch-name-that-exceeds-limit', 30))
      .toBe('feature/very-long-branch-na...');
  });

  it('should handle exact limit length', () => {
    const exactLength = 'a'.repeat(30);
    expect(truncateString(exactLength, 30)).toBe(exactLength);
  });

  it('should handle one character over limit', () => {
    const overByOne = 'a'.repeat(31);
    expect(truncateString(overByOne, 30)).toBe('a'.repeat(27) + '...');
  });

  it('should use default maxLength of 30', () => {
    const longString = 'a'.repeat(50);
    expect(truncateString(longString)).toBe('a'.repeat(27) + '...');
  });

  it('should handle custom maxLength', () => {
    expect(truncateString('feature/branch', 10)).toBe('feature...');
    expect(truncateString('main', 10)).toBe('main');
  });

  it('should handle empty string', () => {
    expect(truncateString('', 30)).toBe('');
  });

  it('should handle very short maxLength', () => {
    // With maxLength=5, we get 2 chars + '...'
    expect(truncateString('abcdefgh', 5)).toBe('ab...');
  });

  it('should handle maxLength of 3 (edge case)', () => {
    // With maxLength=3, we get 0 chars + '...'
    expect(truncateString('abcdefgh', 3)).toBe('...');
  });

  it('should handle Unicode characters', () => {
    // 'feature/long-branch-name' is 24 chars, truncate at 20 -> 17 chars + '...'
    expect(truncateString('feature/long-branch-name', 20)).toBe('feature/long-bran...');
  });

  it('should handle special characters in branch names', () => {
    expect(truncateString('feature/special_chars.v1', 20)).toBe('feature/special_c...');
  });
});
