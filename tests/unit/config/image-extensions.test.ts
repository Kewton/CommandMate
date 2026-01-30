/**
 * Image Extensions Configuration Tests
 * Tests for image file extension validation and security checks
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Security requirements tested:
 * - Extension whitelist validation
 * - Magic bytes validation for PNG, JPEG, GIF, WebP
 * - WebP complete validation (RIFF header + WEBP signature)
 * - SVG XSS prevention (script tags, event handlers, javascript: schemes, foreignObject)
 */

import { describe, it, expect } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  IMAGE_MAX_SIZE_BYTES,
  IMAGE_EXTENSION_VALIDATORS,
  isImageExtension,
  validateImageMagicBytes,
  validateWebPMagicBytes,
  validateSvgContent,
  validateImageContent,
  type ImageExtensionValidator,
  type ImageValidationResult,
} from '@/config/image-extensions';

describe('IMAGE_EXTENSIONS', () => {
  it('should include all supported image extensions', () => {
    expect(IMAGE_EXTENSIONS).toContain('.png');
    expect(IMAGE_EXTENSIONS).toContain('.jpg');
    expect(IMAGE_EXTENSIONS).toContain('.jpeg');
    expect(IMAGE_EXTENSIONS).toContain('.gif');
    expect(IMAGE_EXTENSIONS).toContain('.webp');
    expect(IMAGE_EXTENSIONS).toContain('.svg');
  });

  it('should have exactly 6 extensions', () => {
    expect(IMAGE_EXTENSIONS).toHaveLength(6);
  });

  it('should be a readonly array', () => {
    expect(Array.isArray(IMAGE_EXTENSIONS)).toBe(true);
  });
});

describe('IMAGE_MAX_SIZE_BYTES', () => {
  it('should be 5MB', () => {
    expect(IMAGE_MAX_SIZE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('IMAGE_EXTENSION_VALIDATORS', () => {
  it('should have validators for all supported extensions', () => {
    const extensions = IMAGE_EXTENSION_VALIDATORS.map(v => v.extension);
    expect(extensions).toContain('.png');
    expect(extensions).toContain('.jpg');
    expect(extensions).toContain('.jpeg');
    expect(extensions).toContain('.gif');
    expect(extensions).toContain('.webp');
    expect(extensions).toContain('.svg');
  });

  it('should have correct MIME types', () => {
    const png = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.png');
    expect(png?.mimeType).toBe('image/png');

    const jpg = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.jpg');
    expect(jpg?.mimeType).toBe('image/jpeg');

    const jpeg = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.jpeg');
    expect(jpeg?.mimeType).toBe('image/jpeg');

    const gif = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.gif');
    expect(gif?.mimeType).toBe('image/gif');

    const webp = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.webp');
    expect(webp?.mimeType).toBe('image/webp');

    const svg = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.svg');
    expect(svg?.mimeType).toBe('image/svg+xml');
  });

  it('should have magic bytes for binary formats', () => {
    const png = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.png');
    expect(png?.magicBytes).toEqual([0x89, 0x50, 0x4E, 0x47]);

    const jpg = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.jpg');
    expect(jpg?.magicBytes).toEqual([0xFF, 0xD8, 0xFF]);

    const gif = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.gif');
    expect(gif?.magicBytes).toEqual([0x47, 0x49, 0x46, 0x38]);

    const webp = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.webp');
    expect(webp?.magicBytes).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  it('should not have magic bytes for SVG (text-based)', () => {
    const svg = IMAGE_EXTENSION_VALIDATORS.find(v => v.extension === '.svg');
    expect(svg?.magicBytes).toBeUndefined();
  });
});

describe('isImageExtension', () => {
  describe('valid extensions', () => {
    it('should return true for .png', () => {
      expect(isImageExtension('.png')).toBe(true);
    });

    it('should return true for .jpg', () => {
      expect(isImageExtension('.jpg')).toBe(true);
    });

    it('should return true for .jpeg', () => {
      expect(isImageExtension('.jpeg')).toBe(true);
    });

    it('should return true for .gif', () => {
      expect(isImageExtension('.gif')).toBe(true);
    });

    it('should return true for .webp', () => {
      expect(isImageExtension('.webp')).toBe(true);
    });

    it('should return true for .svg', () => {
      expect(isImageExtension('.svg')).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase extensions', () => {
      expect(isImageExtension('.PNG')).toBe(true);
      expect(isImageExtension('.JPG')).toBe(true);
      expect(isImageExtension('.JPEG')).toBe(true);
      expect(isImageExtension('.GIF')).toBe(true);
      expect(isImageExtension('.WEBP')).toBe(true);
      expect(isImageExtension('.SVG')).toBe(true);
    });

    it('should handle mixed case extensions', () => {
      expect(isImageExtension('.Png')).toBe(true);
      expect(isImageExtension('.JpG')).toBe(true);
    });
  });

  describe('dot normalization (SF-003)', () => {
    it('should handle extensions without leading dot', () => {
      expect(isImageExtension('png')).toBe(true);
      expect(isImageExtension('jpg')).toBe(true);
      expect(isImageExtension('jpeg')).toBe(true);
      expect(isImageExtension('gif')).toBe(true);
      expect(isImageExtension('webp')).toBe(true);
      expect(isImageExtension('svg')).toBe(true);
    });
  });

  describe('invalid extensions', () => {
    it('should return false for non-image extensions', () => {
      expect(isImageExtension('.md')).toBe(false);
      expect(isImageExtension('.txt')).toBe(false);
      expect(isImageExtension('.js')).toBe(false);
      expect(isImageExtension('.ts')).toBe(false);
      expect(isImageExtension('.pdf')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isImageExtension('')).toBe(false);
    });
  });
});

describe('validateImageMagicBytes', () => {
  describe('PNG validation', () => {
    it('should return true for valid PNG magic bytes', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(validateImageMagicBytes('.png', pngBuffer)).toBe(true);
      expect(validateImageMagicBytes('png', pngBuffer)).toBe(true);
    });

    it('should return false for invalid PNG magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes('.png', invalidBuffer)).toBe(false);
    });
  });

  describe('JPEG validation', () => {
    it('should return true for valid JPEG magic bytes', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      expect(validateImageMagicBytes('.jpg', jpegBuffer)).toBe(true);
      expect(validateImageMagicBytes('.jpeg', jpegBuffer)).toBe(true);
      expect(validateImageMagicBytes('jpg', jpegBuffer)).toBe(true);
    });

    it('should return false for invalid JPEG magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes('.jpg', invalidBuffer)).toBe(false);
    });
  });

  describe('GIF validation', () => {
    it('should return true for valid GIF89a magic bytes', () => {
      const gif89aBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(validateImageMagicBytes('.gif', gif89aBuffer)).toBe(true);
    });

    it('should return true for valid GIF87a magic bytes', () => {
      const gif87aBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
      expect(validateImageMagicBytes('.gif', gif87aBuffer)).toBe(true);
    });

    it('should return false for invalid GIF magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes('.gif', invalidBuffer)).toBe(false);
    });
  });

  describe('WebP validation', () => {
    it('should return true for valid WebP RIFF header', () => {
      // RIFF header only (basic validation)
      const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes('.webp', webpBuffer)).toBe(true);
    });

    it('should return false for invalid WebP magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes('.webp', invalidBuffer)).toBe(false);
    });
  });

  describe('SVG validation', () => {
    it('should return true for SVG (text-based, no magic bytes)', () => {
      const svgBuffer = Buffer.from('<svg>test</svg>');
      expect(validateImageMagicBytes('.svg', svgBuffer)).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase extensions', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
      expect(validateImageMagicBytes('.PNG', pngBuffer)).toBe(true);
    });
  });
});

describe('validateWebPMagicBytes (SEC-SF-004)', () => {
  it('should return true for complete WebP signature', () => {
    // RIFF at offset 0-3, file size at 4-7, WEBP at offset 8-11
    const validWebP = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size (placeholder)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(validateWebPMagicBytes(validWebP)).toBe(true);
  });

  it('should return false for RIFF without WEBP signature', () => {
    const riffOnlyBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size
      0x41, 0x56, 0x49, 0x20, // AVI (not WEBP)
    ]);
    expect(validateWebPMagicBytes(riffOnlyBuffer)).toBe(false);
  });

  it('should return false for buffer too short', () => {
    const shortBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    expect(validateWebPMagicBytes(shortBuffer)).toBe(false);
  });

  it('should return false for non-RIFF buffer', () => {
    const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(validateWebPMagicBytes(invalidBuffer)).toBe(false);
  });
});

describe('validateSvgContent', () => {
  describe('valid SVG', () => {
    it('should accept valid SVG with svg tag', () => {
      const result = validateSvgContent('<svg><circle cx="50" cy="50" r="40"/></svg>');
      expect(result.valid).toBe(true);
    });

    it('should accept SVG with XML declaration', () => {
      const result = validateSvgContent('<?xml version="1.0"?><svg><rect/></svg>');
      expect(result.valid).toBe(true);
    });

    it('should accept SVG with namespace', () => {
      const result = validateSvgContent('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>');
      expect(result.valid).toBe(true);
    });

    it('should accept SVG with safe href attribute', () => {
      const result = validateSvgContent('<svg><a href="https://example.com"><text>Link</text></a></svg>');
      expect(result.valid).toBe(true);
    });

    it('should accept SVG with xlink:href to external URL', () => {
      const result = validateSvgContent('<svg><image xlink:href="https://example.com/image.png"/></svg>');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid SVG format', () => {
    it('should reject content without svg tag', () => {
      const result = validateSvgContent('<div>Not an SVG</div>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid SVG format');
    });

    it('should reject empty content', () => {
      const result = validateSvgContent('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid SVG format');
    });

    it('should reject plain text', () => {
      const result = validateSvgContent('This is just text');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid SVG format');
    });
  });

  describe('XSS prevention - script tags', () => {
    it('should reject SVG with script tag', () => {
      const result = validateSvgContent('<svg><script>alert("XSS")</script></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains script tags');
    });

    it('should reject SVG with script tag (case insensitive)', () => {
      const result = validateSvgContent('<svg><SCRIPT>alert("XSS")</SCRIPT></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains script tags');
    });

    it('should reject SVG with script tag with attributes', () => {
      const result = validateSvgContent('<svg><script type="text/javascript">alert("XSS")</script></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains script tags');
    });
  });

  describe('XSS prevention - event handlers (SEC-MF-001)', () => {
    it('should reject SVG with onload handler', () => {
      const result = validateSvgContent('<svg onload="alert(\'XSS\')"><circle/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with onclick handler', () => {
      const result = validateSvgContent('<svg><rect onclick="alert(\'XSS\')"/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with onmouseover handler', () => {
      const result = validateSvgContent('<svg><circle onmouseover="alert(\'XSS\')"/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with onerror handler', () => {
      const result = validateSvgContent('<svg><image onerror="alert(\'XSS\')"/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with onfocus handler', () => {
      const result = validateSvgContent('<svg><text onfocus="alert(\'XSS\')"/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with event handler (case insensitive)', () => {
      const result = validateSvgContent('<svg ONLOAD="alert(\'XSS\')"><circle/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });

    it('should reject SVG with event handler with spaces', () => {
      const result = validateSvgContent('<svg onload = "alert(\'XSS\')"><circle/></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });
  });

  describe('XSS prevention - dangerous URI schemes (SEC-MF-002)', () => {
    it('should reject SVG with javascript: href', () => {
      const result = validateSvgContent('<svg><a href="javascript:alert(\'XSS\')"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });

    it('should reject SVG with javascript: xlink:href', () => {
      const result = validateSvgContent('<svg><a xlink:href="javascript:alert(\'XSS\')"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });

    it('should reject SVG with data: href', () => {
      // Using encoded data URI without script tag to test data: scheme detection specifically
      const result = validateSvgContent('<svg><a href="data:text/html,malicious"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });

    it('should reject SVG with vbscript: href', () => {
      const result = validateSvgContent('<svg><a href="vbscript:msgbox(\'XSS\')"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });

    it('should reject dangerous URI (case insensitive)', () => {
      const result = validateSvgContent('<svg><a href="JAVASCRIPT:alert(\'XSS\')"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });

    it('should reject dangerous URI with spaces', () => {
      const result = validateSvgContent('<svg><a href=" javascript:alert(\'XSS\')"><text>Click</text></a></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains dangerous URI scheme');
    });
  });

  describe('XSS prevention - foreignObject (SEC-MF-003)', () => {
    it('should reject SVG with foreignObject element', () => {
      // Using foreignObject without script tag to test foreignObject detection specifically
      const result = validateSvgContent('<svg><foreignObject><body><div>HTML content</div></body></foreignObject></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains foreignObject element');
    });

    it('should reject SVG with foreignObject (case insensitive)', () => {
      const result = validateSvgContent('<svg><FOREIGNOBJECT><div>Content</div></FOREIGNOBJECT></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains foreignObject element');
    });

    it('should reject SVG with foreignObject with attributes', () => {
      const result = validateSvgContent('<svg><foreignObject width="100" height="100"><div>Content</div></foreignObject></svg>');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains foreignObject element');
    });
  });
});

describe('validateImageContent', () => {
  describe('file size validation', () => {
    it('should reject files exceeding 5MB', () => {
      const largeBuffer = Buffer.alloc(5 * 1024 * 1024 + 1);
      largeBuffer[0] = 0x89;
      largeBuffer[1] = 0x50;
      largeBuffer[2] = 0x4E;
      largeBuffer[3] = 0x47;

      const result = validateImageContent('.png', largeBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('5MB');
    });

    it('should accept files at exactly 5MB', () => {
      const maxBuffer = Buffer.alloc(5 * 1024 * 1024);
      maxBuffer[0] = 0x89;
      maxBuffer[1] = 0x50;
      maxBuffer[2] = 0x4E;
      maxBuffer[3] = 0x47;

      const result = validateImageContent('.png', maxBuffer);
      expect(result.valid).toBe(true);
    });
  });

  describe('PNG validation', () => {
    it('should accept valid PNG', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = validateImageContent('.png', pngBuffer);
      expect(result.valid).toBe(true);
    });

    it('should reject PNG with invalid magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const result = validateImageContent('.png', invalidBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid image magic bytes');
    });
  });

  describe('JPEG validation', () => {
    it('should accept valid JPEG', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      const result = validateImageContent('.jpg', jpegBuffer);
      expect(result.valid).toBe(true);
    });

    it('should reject JPEG with invalid magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const result = validateImageContent('.jpg', invalidBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid image magic bytes');
    });
  });

  describe('SVG validation', () => {
    it('should accept valid SVG', () => {
      const svgBuffer = Buffer.from('<svg><circle/></svg>');
      const result = validateImageContent('.svg', svgBuffer);
      expect(result.valid).toBe(true);
    });

    it('should reject SVG with script tag', () => {
      const maliciousSvg = Buffer.from('<svg><script>alert("XSS")</script></svg>');
      const result = validateImageContent('.svg', maliciousSvg);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains script tags');
    });

    it('should reject SVG with event handler', () => {
      const maliciousSvg = Buffer.from('<svg onload="alert(\'XSS\')"></svg>');
      const result = validateImageContent('.svg', maliciousSvg);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('SVG contains event handler attributes');
    });
  });

  describe('dot normalization', () => {
    it('should handle extensions without leading dot', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
      const result = validateImageContent('png', pngBuffer);
      expect(result.valid).toBe(true);
    });
  });
});
