/**
 * Video Extensions Configuration Tests
 * Tests for video file extension validation
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Issue #302: mp4 file upload and playback support
 *
 * Follows the same test structure as image-extensions.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  VIDEO_EXTENSIONS,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_EXTENSION_VALIDATORS,
  isVideoExtension,
  getMimeTypeByVideoExtension,
  validateVideoMagicBytes,
  validateVideoContent,
  type VideoExtensionValidator,
  type VideoValidationResult,
} from '@/config/video-extensions';

describe('VIDEO_EXTENSIONS', () => {
  it('should include .mp4', () => {
    expect(VIDEO_EXTENSIONS).toContain('.mp4');
  });

  it('should have exactly 1 extension', () => {
    expect(VIDEO_EXTENSIONS).toHaveLength(1);
  });

  it('should be a readonly array', () => {
    expect(Array.isArray(VIDEO_EXTENSIONS)).toBe(true);
  });

  it('should NOT include unsupported video formats', () => {
    expect(VIDEO_EXTENSIONS).not.toContain('.webm');
    expect(VIDEO_EXTENSIONS).not.toContain('.avi');
    expect(VIDEO_EXTENSIONS).not.toContain('.mov');
    expect(VIDEO_EXTENSIONS).not.toContain('.mkv');
  });
});

describe('VIDEO_MAX_SIZE_BYTES', () => {
  it('should be 15MB', () => {
    expect(VIDEO_MAX_SIZE_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe('VIDEO_EXTENSION_VALIDATORS', () => {
  it('should have a validator for .mp4', () => {
    const mp4 = VIDEO_EXTENSION_VALIDATORS.find(v => v.extension === '.mp4');
    expect(mp4).toBeDefined();
  });

  it('should have correct MIME type for .mp4', () => {
    const mp4 = VIDEO_EXTENSION_VALIDATORS.find(v => v.extension === '.mp4');
    expect(mp4?.mimeType).toBe('video/mp4');
  });

  it('should have magic bytes for .mp4 (ftyp at offset 4)', () => {
    const mp4 = VIDEO_EXTENSION_VALIDATORS.find(v => v.extension === '.mp4');
    expect(mp4?.magicBytes).toEqual([0x66, 0x74, 0x79, 0x70]);
    expect(mp4?.magicBytesOffset).toBe(4);
  });
});

describe('isVideoExtension', () => {
  describe('valid extensions', () => {
    it('should return true for .mp4', () => {
      expect(isVideoExtension('.mp4')).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('should return true for .MP4 (uppercase)', () => {
      expect(isVideoExtension('.MP4')).toBe(true);
    });

    it('should return true for .Mp4 (mixed case)', () => {
      expect(isVideoExtension('.Mp4')).toBe(true);
    });
  });

  describe('dot normalization', () => {
    it('should handle extensions without leading dot', () => {
      expect(isVideoExtension('mp4')).toBe(true);
    });
  });

  describe('invalid extensions', () => {
    it('should return false for .webm', () => {
      expect(isVideoExtension('.webm')).toBe(false);
    });

    it('should return false for .avi', () => {
      expect(isVideoExtension('.avi')).toBe(false);
    });

    it('should return false for .mov', () => {
      expect(isVideoExtension('.mov')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isVideoExtension('')).toBe(false);
    });

    it('should return false for non-video extensions', () => {
      expect(isVideoExtension('.png')).toBe(false);
      expect(isVideoExtension('.txt')).toBe(false);
      expect(isVideoExtension('.js')).toBe(false);
    });
  });
});

describe('getMimeTypeByVideoExtension', () => {
  it('should return video/mp4 for .mp4', () => {
    expect(getMimeTypeByVideoExtension('.mp4')).toBe('video/mp4');
  });

  it('should handle extensions without leading dot', () => {
    expect(getMimeTypeByVideoExtension('mp4')).toBe('video/mp4');
  });

  it('should handle case insensitivity', () => {
    expect(getMimeTypeByVideoExtension('.MP4')).toBe('video/mp4');
  });

  it('should return undefined for unknown extensions', () => {
    expect(getMimeTypeByVideoExtension('.unknown')).toBeUndefined();
    expect(getMimeTypeByVideoExtension('.webm')).toBeUndefined();
    expect(getMimeTypeByVideoExtension('')).toBeUndefined();
  });
});

describe('validateVideoMagicBytes', () => {
  describe('MP4 validation', () => {
    it('should return true for valid MP4 magic bytes (ftyp at offset 4)', () => {
      // MP4 files have 'ftyp' at offset 4
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x1C, // box size (first 4 bytes)
        0x66, 0x74, 0x79, 0x70, // 'ftyp' at offset 4
        0x69, 0x73, 0x6F, 0x6D, // 'isom'
      ]);
      expect(validateVideoMagicBytes('.mp4', mp4Buffer)).toBe(true);
      expect(validateVideoMagicBytes('mp4', mp4Buffer)).toBe(true);
    });

    it('should return false for invalid MP4 magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(validateVideoMagicBytes('.mp4', invalidBuffer)).toBe(false);
    });

    it('should return false for buffer too short', () => {
      const shortBuffer = Buffer.from([0x00, 0x00, 0x00]);
      expect(validateVideoMagicBytes('.mp4', shortBuffer)).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase extensions', () => {
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x1C,
        0x66, 0x74, 0x79, 0x70,
      ]);
      expect(validateVideoMagicBytes('.MP4', mp4Buffer)).toBe(true);
    });
  });

  describe('unknown extensions', () => {
    it('should return false for unsupported extensions', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateVideoMagicBytes('.webm', buffer)).toBe(false);
      expect(validateVideoMagicBytes('.avi', buffer)).toBe(false);
    });
  });
});

describe('validateVideoContent', () => {
  describe('file size validation', () => {
    it('should reject files exceeding 15MB', () => {
      const largeBuffer = Buffer.alloc(15 * 1024 * 1024 + 1);
      // Set valid magic bytes
      largeBuffer[4] = 0x66;
      largeBuffer[5] = 0x74;
      largeBuffer[6] = 0x79;
      largeBuffer[7] = 0x70;

      const result = validateVideoContent('.mp4', largeBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('15MB');
    });

    it('should accept files at exactly 15MB with valid magic bytes', () => {
      const maxBuffer = Buffer.alloc(15 * 1024 * 1024);
      maxBuffer[4] = 0x66;
      maxBuffer[5] = 0x74;
      maxBuffer[6] = 0x79;
      maxBuffer[7] = 0x70;

      const result = validateVideoContent('.mp4', maxBuffer);
      expect(result.valid).toBe(true);
    });
  });

  describe('MP4 validation', () => {
    it('should accept valid MP4', () => {
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x1C,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
      ]);
      const result = validateVideoContent('.mp4', mp4Buffer);
      expect(result.valid).toBe(true);
    });

    it('should reject MP4 with invalid magic bytes', () => {
      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const result = validateVideoContent('.mp4', invalidBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid video magic bytes');
    });
  });

  describe('dot normalization', () => {
    it('should handle extensions without leading dot', () => {
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x1C,
        0x66, 0x74, 0x79, 0x70,
      ]);
      const result = validateVideoContent('mp4', mp4Buffer);
      expect(result.valid).toBe(true);
    });
  });
});

describe('Type exports', () => {
  it('should export VideoExtensionValidator interface', () => {
    const validator: VideoExtensionValidator = {
      extension: '.mp4',
      mimeType: 'video/mp4',
      magicBytes: [0x66, 0x74, 0x79, 0x70],
      magicBytesOffset: 4,
    };
    expect(validator).toBeDefined();
  });

  it('should export VideoValidationResult interface', () => {
    const result: VideoValidationResult = {
      valid: true,
    };
    expect(result).toBeDefined();

    const failResult: VideoValidationResult = {
      valid: false,
      error: 'Test error',
    };
    expect(failResult).toBeDefined();
  });
});
