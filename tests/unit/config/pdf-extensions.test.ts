/**
 * PDF Extensions Configuration Tests
 * Issue #673: PDF viewer implementation
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect } from 'vitest';
import {
  PDF_EXTENSIONS,
  PDF_MAX_SIZE_BYTES,
  PDF_MAGIC_BYTES,
  PDF_IFRAME_SANDBOX,
  PDF_MIME_TYPE,
  isPdfExtension,
  validatePdfMagicBytes,
  validatePdfContent,
} from '@/config/pdf-extensions';
import {
  createMinimalPdfBuffer,
  createPdfBufferOfSize,
  createBrokenPdfBuffer,
} from '@tests/helpers/pdf-fixtures';

describe('PDF_EXTENSIONS', () => {
  it('should include .pdf extension', () => {
    expect(PDF_EXTENSIONS).toContain('.pdf');
  });

  it('should have exactly 1 extension', () => {
    expect(PDF_EXTENSIONS).toHaveLength(1);
  });

  it('should be a readonly array', () => {
    expect(Array.isArray(PDF_EXTENSIONS)).toBe(true);
  });
});

describe('PDF_MAX_SIZE_BYTES', () => {
  it('should be 20MB (20 * 1024 * 1024)', () => {
    expect(PDF_MAX_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('PDF_MAGIC_BYTES', () => {
  it('should be the 5-byte %PDF- signature', () => {
    expect(PDF_MAGIC_BYTES).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(PDF_MAGIC_BYTES).toHaveLength(5);
  });
});

describe('PDF_IFRAME_SANDBOX', () => {
  it('should be allow-scripts (minimum for Firefox pdf.js)', () => {
    expect(PDF_IFRAME_SANDBOX).toBe('allow-scripts');
  });
});

describe('PDF_MIME_TYPE', () => {
  it('should be application/pdf', () => {
    expect(PDF_MIME_TYPE).toBe('application/pdf');
  });
});

describe('isPdfExtension', () => {
  it('should return true for .pdf', () => {
    expect(isPdfExtension('.pdf')).toBe(true);
  });

  it('should be case-insensitive (.PDF)', () => {
    expect(isPdfExtension('.PDF')).toBe(true);
  });

  it('should handle mixed case (.Pdf)', () => {
    expect(isPdfExtension('.Pdf')).toBe(true);
  });

  it('should return true for pdf without dot (normalizeExtension adds dot)', () => {
    expect(isPdfExtension('pdf')).toBe(true);
  });

  it('should return false for .txt', () => {
    expect(isPdfExtension('.txt')).toBe(false);
  });

  it('should return false for .md', () => {
    expect(isPdfExtension('.md')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isPdfExtension('')).toBe(false);
  });

  it('should return false for .pdfx (not a real PDF extension)', () => {
    expect(isPdfExtension('.pdfx')).toBe(false);
  });
});

describe('validatePdfMagicBytes', () => {
  it('should return true when buffer starts with %PDF-', () => {
    const buffer = createMinimalPdfBuffer();
    expect(validatePdfMagicBytes(buffer)).toBe(true);
  });

  it('should return false when buffer does not start with %PDF-', () => {
    const buffer = createBrokenPdfBuffer();
    expect(validatePdfMagicBytes(buffer)).toBe(false);
  });

  it('should return false for a too-short buffer (< 5 bytes)', () => {
    const buffer = Buffer.from([0x25, 0x50, 0x44]); // "%PD"
    expect(validatePdfMagicBytes(buffer)).toBe(false);
  });

  it('should return false for a buffer with partial match', () => {
    // "%PDFA" instead of "%PDF-"
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x41]);
    expect(validatePdfMagicBytes(buffer)).toBe(false);
  });

  it('should return true for Uint8Array input (not Buffer)', () => {
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(validatePdfMagicBytes(buffer)).toBe(true);
  });
});

describe('validatePdfContent', () => {
  describe('file size validation', () => {
    it('should reject buffers exceeding PDF_MAX_SIZE_BYTES', () => {
      const largeBuffer = createPdfBufferOfSize(PDF_MAX_SIZE_BYTES + 1);
      const result = validatePdfContent(largeBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('20MB');
    });

    it('should accept buffers exactly at PDF_MAX_SIZE_BYTES', () => {
      const maxBuffer = createPdfBufferOfSize(PDF_MAX_SIZE_BYTES);
      const result = validatePdfContent(maxBuffer);
      expect(result.valid).toBe(true);
    });
  });

  describe('magic bytes validation', () => {
    it('should accept valid PDF buffer', () => {
      const buffer = createMinimalPdfBuffer();
      const result = validatePdfContent(buffer);
      expect(result.valid).toBe(true);
    });

    it('should reject non-PDF buffer (magic bytes failure)', () => {
      const buffer = createBrokenPdfBuffer();
      const result = validatePdfContent(buffer);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('magic bytes');
    });

    it('should reject empty buffer', () => {
      const buffer = Buffer.alloc(0);
      const result = validatePdfContent(buffer);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('magic bytes');
    });
  });
});
