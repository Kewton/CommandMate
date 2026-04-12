/**
 * Editable Extensions Configuration Tests
 * [SF-003] Configuration for editable file extensions
 * [SEC-SF-001] Content validation (binary detection)
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, vi } from 'vitest';
import {
  EDITABLE_EXTENSIONS,
  EXTENSION_VALIDATORS,
  validateContent,
  isEditableExtension,
} from '@/config/editable-extensions';

describe('EDITABLE_EXTENSIONS', () => {
  it('should include .md extension', () => {
    expect(EDITABLE_EXTENSIONS).toContain('.md');
  });

  it('should be a readonly array', () => {
    // TypeScript will enforce readonly at compile time
    // At runtime, we can check that it's an array
    expect(Array.isArray(EDITABLE_EXTENSIONS)).toBe(true);
  });

  it('should include .md, .html, .htm, .yaml, .yml', () => {
    expect(EDITABLE_EXTENSIONS).toHaveLength(5);
    expect(EDITABLE_EXTENSIONS).toContain('.md');
    expect(EDITABLE_EXTENSIONS).toContain('.html');
    expect(EDITABLE_EXTENSIONS).toContain('.htm');
    expect(EDITABLE_EXTENSIONS).toContain('.yaml');
    expect(EDITABLE_EXTENSIONS).toContain('.yml');
  });
});

describe('EXTENSION_VALIDATORS', () => {
  it('should have a validator for .md extension', () => {
    const mdValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.md');
    expect(mdValidator).toBeDefined();
  });

  it('should have a max file size of 1MB for .md', () => {
    const mdValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.md');
    expect(mdValidator?.maxFileSize).toBe(1024 * 1024);
  });

  it('should have a validator for .html extension - Issue #490', () => {
    const htmlValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.html');
    expect(htmlValidator).toBeDefined();
    expect(htmlValidator?.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it('should have a validator for .htm extension - Issue #490', () => {
    const htmValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.htm');
    expect(htmValidator).toBeDefined();
    expect(htmValidator?.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it('should have a validator for .yaml extension - Issue #646', () => {
    const yamlValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.yaml');
    expect(yamlValidator).toBeDefined();
    expect(yamlValidator?.maxFileSize).toBe(1024 * 1024);
    expect(yamlValidator?.additionalValidation).toBeDefined();
  });

  it('should have a validator for .yml extension - Issue #646', () => {
    const ymlValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.yml');
    expect(ymlValidator).toBeDefined();
    expect(ymlValidator?.maxFileSize).toBe(1024 * 1024);
    expect(ymlValidator?.additionalValidation).toBeDefined();
  });
});

describe('isEditableExtension', () => {
  it('should return true for .md extension', () => {
    expect(isEditableExtension('.md')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isEditableExtension('.MD')).toBe(true);
    expect(isEditableExtension('.Md')).toBe(true);
  });

  it('should return true for .html - Issue #490', () => {
    expect(isEditableExtension('.html')).toBe(true);
  });

  it('should return true for .htm - Issue #490', () => {
    expect(isEditableExtension('.htm')).toBe(true);
  });

  it('should return true for .yaml - Issue #646', () => {
    expect(isEditableExtension('.yaml')).toBe(true);
  });

  it('should return true for .yml - Issue #646', () => {
    expect(isEditableExtension('.yml')).toBe(true);
  });

  it('should return true for .YAML (case-insensitive) - Issue #646', () => {
    expect(isEditableExtension('.YAML')).toBe(true);
    expect(isEditableExtension('.Yml')).toBe(true);
  });

  it('should return false for non-editable extensions', () => {
    expect(isEditableExtension('.txt')).toBe(false);
    expect(isEditableExtension('.js')).toBe(false);
    expect(isEditableExtension('.ts')).toBe(false);
    expect(isEditableExtension('.json')).toBe(false);
  });

  it('should handle edge cases', () => {
    expect(isEditableExtension('')).toBe(false);
    expect(isEditableExtension('md')).toBe(false); // no dot
  });

  it('should return false for html without dot (DR3-004: intentional asymmetry with isHtmlExtension)', () => {
    expect(isEditableExtension('html')).toBe(false);
  });
});

describe('validateContent', () => {
  describe('valid content', () => {
    it('should accept valid markdown content', () => {
      const result = validateContent('.md', '# Hello World\n\nThis is content.');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept empty content', () => {
      const result = validateContent('.md', '');
      expect(result.valid).toBe(true);
    });

    it('should accept content with newlines', () => {
      const result = validateContent('.md', 'Line 1\nLine 2\nLine 3');
      expect(result.valid).toBe(true);
    });

    it('should accept content with tabs', () => {
      const result = validateContent('.md', 'Column1\tColumn2\tColumn3');
      expect(result.valid).toBe(true);
    });
  });

  describe('unsupported extensions', () => {
    it('should reject unsupported extensions', () => {
      const result = validateContent('.txt', 'content');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unsupported extension');
    });
  });

  describe('file size validation', () => {
    it('should reject content exceeding max file size', () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1 byte
      const result = validateContent('.md', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should accept content at max file size', () => {
      const maxContent = 'x'.repeat(1024 * 1024); // exactly 1MB
      const result = validateContent('.md', maxContent);
      expect(result.valid).toBe(true);
    });
  });

  describe('[SEC-SF-001] binary content detection', () => {
    it('should reject content with NULL bytes', () => {
      const result = validateContent('.md', 'Hello\x00World');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });

    it('should reject content with multiple NULL bytes', () => {
      const result = validateContent('.md', '\x00\x00\x00');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });
  });

  describe('[SEC-SF-001] control character warning', () => {
    it('should warn but accept content with control characters', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Control character 0x01 (SOH)
      const result = validateContent('.md', 'Hello\x01World');

      expect(result.valid).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith('Content contains control characters');

      consoleSpy.mockRestore();
    });

    it('should not warn for normal whitespace characters', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Tab (0x09), Newline (0x0A), Carriage return (0x0D) are allowed
      const result = validateContent('.md', 'Hello\t\n\rWorld');

      expect(result.valid).toBe(true);
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('HTML content validation - Issue #490', () => {
    it('should accept valid HTML content for .html', () => {
      const result = validateContent('.html', '<html><body><h1>Hello</h1></body></html>');
      expect(result.valid).toBe(true);
    });

    it('should accept valid HTML content for .htm', () => {
      const result = validateContent('.htm', '<html><body><p>World</p></body></html>');
      expect(result.valid).toBe(true);
    });

    it('should reject HTML content exceeding 5MB for .html', () => {
      const largeContent = 'x'.repeat(5 * 1024 * 1024 + 1); // 5MB + 1 byte
      const result = validateContent('.html', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should accept HTML content at exactly 5MB for .html', () => {
      const maxContent = 'x'.repeat(5 * 1024 * 1024); // exactly 5MB
      const result = validateContent('.html', maxContent);
      expect(result.valid).toBe(true);
    });

    it('should reject HTML content exceeding 5MB for .htm', () => {
      const largeContent = 'x'.repeat(5 * 1024 * 1024 + 1);
      const result = validateContent('.htm', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should reject HTML content with NULL bytes (binary detection) - DR2-005', () => {
      const result = validateContent('.html', '<html>\x00</html>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });

    it('should reject .htm content with NULL bytes (binary detection) - DR2-005', () => {
      const result = validateContent('.htm', '<html>\x00</html>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });

    it('should accept empty HTML content', () => {
      const result = validateContent('.html', '');
      expect(result.valid).toBe(true);
    });
  });

  describe('YAML content validation - Issue #646', () => {
    it('should accept valid YAML content for .yaml', () => {
      const result = validateContent('.yaml', 'name: test\nversion: 1.0');
      expect(result.valid).toBe(true);
    });

    it('should accept valid YAML content for .yml', () => {
      const result = validateContent('.yml', 'key: value\nlist:\n  - item1\n  - item2');
      expect(result.valid).toBe(true);
    });

    it('should accept empty YAML content', () => {
      const result = validateContent('.yaml', '');
      expect(result.valid).toBe(true);
    });

    it('should reject YAML content exceeding 1MB for .yaml', () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const result = validateContent('.yaml', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should reject YAML content exceeding 1MB for .yml', () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const result = validateContent('.yml', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should reject YAML with dangerous !ruby/object tag', () => {
      const result = validateContent('.yaml', 'exploit: !ruby/object:Gem::Requirement\n  - test');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Dangerous YAML tags detected');
    });

    it('should reject YAML with dangerous !!python tag', () => {
      const result = validateContent('.yml', 'exploit: !!python/object/apply:os.system\n  - echo pwned');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Dangerous YAML tags detected');
    });

    it('should return specific error message string for dangerous YAML tags', () => {
      const result = validateContent('.yaml', '!ruby/object:Exploit {}');
      expect(result.valid).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).not.toBe('Content validation failed');
      expect(result.error).toContain('Dangerous YAML tags detected');
    });

    it('should reject YAML content with NULL bytes (binary detection)', () => {
      const result = validateContent('.yaml', 'key: value\x00');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase extensions', () => {
      const result = validateContent('.MD', '# Content');
      expect(result.valid).toBe(true);
    });

    it('should handle mixed case extensions', () => {
      const result = validateContent('.Md', '# Content');
      expect(result.valid).toBe(true);
    });
  });
});
