/**
 * Unit tests for ATTACHABLE_IMAGE_EXTENSIONS and ATTACHABLE_IMAGE_ACCEPT constants
 * Issue #474: Validates SVG exclusion and accept attribute format
 */

import { describe, it, expect } from 'vitest';
import {
  ATTACHABLE_IMAGE_EXTENSIONS,
  ATTACHABLE_IMAGE_ACCEPT,
  IMAGE_EXTENSIONS,
} from '@/config/image-extensions';

describe('ATTACHABLE_IMAGE_EXTENSIONS', () => {
  it('should not include .svg (XSS prevention)', () => {
    expect(ATTACHABLE_IMAGE_EXTENSIONS).not.toContain('.svg');
  });

  it('should include all non-SVG image extensions from IMAGE_EXTENSIONS', () => {
    const expected = IMAGE_EXTENSIONS.filter((ext) => ext !== '.svg');
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toEqual(expected);
  });

  it('should include .png, .jpg, .jpeg, .gif, .webp', () => {
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toContain('.png');
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toContain('.jpg');
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toContain('.jpeg');
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toContain('.gif');
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toContain('.webp');
  });

  it('should have exactly 5 extensions', () => {
    expect(ATTACHABLE_IMAGE_EXTENSIONS).toHaveLength(5);
  });
});

describe('ATTACHABLE_IMAGE_ACCEPT', () => {
  it('should be a comma-separated string of MIME types', () => {
    expect(typeof ATTACHABLE_IMAGE_ACCEPT).toBe('string');
    expect(ATTACHABLE_IMAGE_ACCEPT).toContain(',');
  });

  it('should contain expected MIME types', () => {
    expect(ATTACHABLE_IMAGE_ACCEPT).toContain('image/png');
    expect(ATTACHABLE_IMAGE_ACCEPT).toContain('image/jpeg');
    expect(ATTACHABLE_IMAGE_ACCEPT).toContain('image/gif');
    expect(ATTACHABLE_IMAGE_ACCEPT).toContain('image/webp');
  });

  it('should not contain SVG MIME type', () => {
    expect(ATTACHABLE_IMAGE_ACCEPT).not.toContain('image/svg+xml');
  });
});
