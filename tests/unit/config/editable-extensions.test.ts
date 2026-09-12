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

  it('should include .md, .html, .htm, .yaml, .yml, .txt', () => {
    expect(EDITABLE_EXTENSIONS).toHaveLength(6);
    expect(EDITABLE_EXTENSIONS).toContain('.md');
    expect(EDITABLE_EXTENSIONS).toContain('.html');
    expect(EDITABLE_EXTENSIONS).toContain('.htm');
    expect(EDITABLE_EXTENSIONS).toContain('.yaml');
    expect(EDITABLE_EXTENSIONS).toContain('.yml');
    // [Issue #2506] `.txt` joined the list. The length is asserted alongside the
    // members so that a SILENT addition fails here: this array is a write
    // allow-list, and every entry added to it widens what PUT will overwrite.
    expect(EDITABLE_EXTENSIONS).toContain('.txt');
  });

  it('keeps .md first so it stays the default in the new-file dropdown - Issue #2506', () => {
    // `NewFileDialog` renders this array in order and seeds `selectedExt` with
    // '.md'; appending rather than inserting is what keeps that pairing true.
    expect(EDITABLE_EXTENSIONS[0]).toBe('.md');
    expect(EDITABLE_EXTENSIONS[EDITABLE_EXTENSIONS.length - 1]).toBe('.txt');
  });

  it('every listed extension has a validator - Issue #2506', () => {
    // The two lists are consulted at different moments (the list gates the
    // route, the validators gate the body), so a member with no validator is a
    // file the UI opens for editing and the API then refuses to save.
    for (const ext of EDITABLE_EXTENSIONS) {
      expect(EXTENSION_VALIDATORS.find(v => v.extension === ext)).toBeDefined();
    }
  });
});

describe('EXTENSION_VALIDATORS', () => {
  it('should have a validator for .md extension', () => {
    const mdValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.md');
    expect(mdValidator).toBeDefined();
  });

  it('should have a max file size of 2MB for .md (Issue #723)', () => {
    const mdValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.md');
    expect(mdValidator?.maxFileSize).toBe(2 * 1024 * 1024);
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

  it('should have a validator for .yaml extension - Issue #646 (2MB after Issue #723)', () => {
    const yamlValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.yaml');
    expect(yamlValidator).toBeDefined();
    expect(yamlValidator?.maxFileSize).toBe(2 * 1024 * 1024);
    expect(yamlValidator?.additionalValidation).toBeDefined();
  });

  it('should have a validator for .yml extension - Issue #646 (2MB after Issue #723)', () => {
    const ymlValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.yml');
    expect(ymlValidator).toBeDefined();
    expect(ymlValidator?.maxFileSize).toBe(2 * 1024 * 1024);
    expect(ymlValidator?.additionalValidation).toBeDefined();
  });

  it('should have a validator for .txt extension with the 2MB text ceiling - Issue #2506', () => {
    const txtValidator = EXTENSION_VALIDATORS.find(v => v.extension === '.txt');
    expect(txtValidator).toBeDefined();
    expect(txtValidator?.maxFileSize).toBe(2 * 1024 * 1024);
    // Plain text has no structure to vet, so there is deliberately no
    // `additionalValidation`; the shared NULL-byte check still runs.
    expect(txtValidator?.additionalValidation).toBeUndefined();
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

  it('should return true for .txt - Issue #2506', () => {
    expect(isEditableExtension('.txt')).toBe(true);
  });

  it('should return true for .TXT (case-insensitive) - Issue #2506', () => {
    expect(isEditableExtension('.TXT')).toBe(true);
    expect(isEditableExtension('.Txt')).toBe(true);
  });

  it('should return false for non-editable extensions', () => {
    expect(isEditableExtension('.js')).toBe(false);
    expect(isEditableExtension('.ts')).toBe(false);
    expect(isEditableExtension('.json')).toBe(false);
    // [Issue #2506] `.text` is NOT an alias for `.txt`; only the exact member
    // is editable, so widening the list does not widen it by fuzzy match.
    expect(isEditableExtension('.text')).toBe(false);
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
      // [Issue #2506] This used to probe `.txt`; `.txt` is editable now, so the
      // case moved to an extension that is still outside the list.
      const result = validateContent('.json', 'content');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unsupported extension');
    });
  });

  describe('file size validation', () => {
    it('should reject content exceeding max file size (2MB, Issue #723)', () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1); // 2MB + 1 byte
      const result = validateContent('.md', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should accept content at max file size (exactly 2MB, Issue #723)', () => {
      const maxContent = 'x'.repeat(2 * 1024 * 1024); // exactly 2MB
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

    it('should reject YAML content exceeding 2MB for .yaml (Issue #723)', () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1);
      const result = validateContent('.yaml', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should reject YAML content exceeding 2MB for .yml (Issue #723)', () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1);
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

  describe('plain-text content validation - Issue #2506', () => {
    it('should accept plain text content for .txt', () => {
      const result = validateContent('.txt', 'just some notes\nsecond line');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept empty .txt content', () => {
      expect(validateContent('.txt', '').valid).toBe(true);
    });

    it('should accept .txt content that would be a dangerous YAML tag', () => {
      // `.txt` has no `additionalValidation`, and that is deliberate: the YAML
      // tag scanner exists because a `.yaml` file gets PARSED somewhere. Plain
      // text never is, so the same bytes are just bytes here.
      const result = validateContent('.txt', 'exploit: !ruby/object:Gem::Requirement');
      expect(result.valid).toBe(true);
    });

    it('should reject .txt content with NULL bytes (shared binary check)', () => {
      const result = validateContent('.txt', 'notes\x00');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });

    it('should reject .txt content exceeding 2MB', () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1);
      const result = validateContent('.txt', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should accept .txt content at exactly 2MB', () => {
      expect(validateContent('.txt', 'x'.repeat(2 * 1024 * 1024)).valid).toBe(true);
    });

    it('should handle uppercase .TXT', () => {
      expect(validateContent('.TXT', 'hello').valid).toBe(true);
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
