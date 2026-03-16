/**
 * Unit Tests for link-utils
 *
 * Issue #505: File link navigation utilities
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLink,
  resolveRelativePath,
  sanitizeHref,
  REHYPE_SANITIZE_SCHEMA,
} from '@/lib/link-utils';
import type { LinkType } from '@/lib/link-utils';

// ============================================================================
// classifyLink Tests
// ============================================================================

describe('classifyLink', () => {
  it('should return "anchor" for hash links', () => {
    expect(classifyLink('#section')).toBe('anchor');
    expect(classifyLink('#')).toBe('anchor');
    expect(classifyLink('#heading-1')).toBe('anchor');
  });

  it('should return "external" for http:// links', () => {
    expect(classifyLink('http://example.com')).toBe('external');
    expect(classifyLink('http://example.com/page')).toBe('external');
  });

  it('should return "external" for https:// links', () => {
    expect(classifyLink('https://example.com')).toBe('external');
    expect(classifyLink('https://github.com/repo')).toBe('external');
  });

  it('should return "relative" for relative paths', () => {
    expect(classifyLink('./readme.md')).toBe('relative');
    expect(classifyLink('../docs/guide.md')).toBe('relative');
    expect(classifyLink('docs/guide.md')).toBe('relative');
    expect(classifyLink('file.txt')).toBe('relative');
  });

  it('should return "relative" for paths starting with /', () => {
    expect(classifyLink('/docs/guide.md')).toBe('relative');
  });

  it('should return "relative" for mailto: and tel: (not external)', () => {
    // mailto: and tel: are not http/https, so classifyLink treats them as relative
    // This is fine because sanitizeHref handles the protocol validation
    expect(classifyLink('mailto:test@example.com')).toBe('relative');
    expect(classifyLink('tel:+1234567890')).toBe('relative');
  });
});

// ============================================================================
// resolveRelativePath Tests
// ============================================================================

describe('resolveRelativePath', () => {
  it('should resolve ./ relative paths', () => {
    const result = resolveRelativePath('src/docs/readme.md', './guide.md');
    expect(result).toBe('src/docs/guide.md');
  });

  it('should resolve ../ relative paths', () => {
    const result = resolveRelativePath('src/docs/readme.md', '../utils.ts');
    expect(result).toBe('src/utils.ts');
  });

  it('should resolve deeply nested relative paths', () => {
    const result = resolveRelativePath('a/b/c/d.md', '../../e/f.md');
    expect(result).toBe('a/e/f.md');
  });

  it('should resolve simple file name (same directory)', () => {
    const result = resolveRelativePath('src/docs/readme.md', 'guide.md');
    expect(result).toBe('src/docs/guide.md');
  });

  it('should return null for empty href', () => {
    const result = resolveRelativePath('src/readme.md', '');
    expect(result).toBeNull();
  });

  it('should handle root-level files', () => {
    const result = resolveRelativePath('readme.md', 'guide.md');
    expect(result).toBe('guide.md');
  });

  it('should handle paths that resolve to root (return null)', () => {
    // Going above root should return null (empty after stripping /)
    const result = resolveRelativePath('readme.md', '../');
    expect(result).toBeNull();
  });

  it('should handle paths with spaces via URL encoding', () => {
    const result = resolveRelativePath('docs/readme.md', './my%20file.md');
    expect(result).toBe('docs/my file.md');
  });
});

// ============================================================================
// sanitizeHref Tests [DR4-003]
// ============================================================================

describe('sanitizeHref', () => {
  it('should pass through valid relative paths', () => {
    expect(sanitizeHref('./readme.md')).toBe('./readme.md');
    expect(sanitizeHref('docs/guide.md')).toBe('docs/guide.md');
  });

  it('should pass through valid http/https URLs', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com');
    expect(sanitizeHref('http://example.com')).toBe('http://example.com');
  });

  it('should pass through anchor links', () => {
    expect(sanitizeHref('#section')).toBe('#section');
  });

  it('should return null for strings exceeding 2048 characters', () => {
    const longHref = 'a'.repeat(2049);
    expect(sanitizeHref(longHref)).toBeNull();
  });

  it('should return null for strings with control characters', () => {
    expect(sanitizeHref('file\x00.md')).toBeNull();
    expect(sanitizeHref('file\x1f.md')).toBeNull();
    expect(sanitizeHref('file\x7f.md')).toBeNull();
  });

  it('should return null for empty strings', () => {
    expect(sanitizeHref('')).toBeNull();
  });

  it('should allow strings at exactly 2048 characters', () => {
    const exactHref = 'a'.repeat(2048);
    expect(sanitizeHref(exactHref)).toBe(exactHref);
  });
});

// ============================================================================
// REHYPE_SANITIZE_SCHEMA Tests [DR4-001]
// ============================================================================

describe('REHYPE_SANITIZE_SCHEMA', () => {
  it('should be an object with attributes', () => {
    expect(REHYPE_SANITIZE_SCHEMA).toBeDefined();
    expect(REHYPE_SANITIZE_SCHEMA.attributes).toBeDefined();
  });

  it('should have a href attribute definition for anchor elements', () => {
    const aAttrs = REHYPE_SANITIZE_SCHEMA.attributes?.a;
    expect(aAttrs).toBeDefined();
    expect(Array.isArray(aAttrs)).toBe(true);
  });

  it('should allow http:// href', () => {
    const hrefDef = findHrefDef();
    expect(hrefDef).toBeDefined();
    expect(testHrefPattern(hrefDef, 'https://example.com')).toBe(true);
    expect(testHrefPattern(hrefDef, 'http://example.com')).toBe(true);
  });

  it('should allow mailto: href', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, 'mailto:test@example.com')).toBe(true);
  });

  it('should allow tel: href', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, 'tel:+1234567890')).toBe(true);
  });

  it('should allow # anchor href', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, '#section')).toBe(true);
  });

  it('should allow relative path href', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, './readme.md')).toBe(true);
    expect(testHrefPattern(hrefDef, '../docs/guide.md')).toBe(true);
    expect(testHrefPattern(hrefDef, 'file.txt')).toBe(true);
  });

  it('should reject javascript: href [DR4-001]', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, 'javascript:alert(1)')).toBe(false);
  });

  it('should reject data: href [DR4-001]', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, 'data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject vbscript: href [DR4-001]', () => {
    const hrefDef = findHrefDef();
    expect(testHrefPattern(hrefDef, 'vbscript:alert(1)')).toBe(false);
  });
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the href attribute definition from the schema.
 * rehype-sanitize uses ['href', <pattern>] format in attribute arrays.
 */
function findHrefDef(): [string, RegExp] | undefined {
  const aAttrs = REHYPE_SANITIZE_SCHEMA.attributes?.a;
  if (!Array.isArray(aAttrs)) return undefined;
  return aAttrs.find(
    (attr): attr is [string, RegExp] =>
      Array.isArray(attr) && attr[0] === 'href' && attr[1] instanceof RegExp,
  );
}

/**
 * Test if a href value matches the pattern in the schema definition.
 */
function testHrefPattern(
  hrefDef: [string, RegExp] | undefined,
  value: string,
): boolean {
  if (!hrefDef) return false;
  return hrefDef[1].test(value);
}
