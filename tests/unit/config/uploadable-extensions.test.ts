/**
 * Uploadable Extensions Configuration Tests
 * [SEC-001] Magic bytes validation
 * [SEC-002] SVG excluded due to XSS risk
 * [SEC-006] YAML safety validation
 * [SEC-007] JSON validation
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, test } from 'vitest';
import {
  UPLOADABLE_EXTENSIONS,
  UPLOADABLE_EXTENSION_VALIDATORS,
  DEFAULT_MAX_FILE_SIZE,
  isUploadableExtension,
  validateMimeType,
  validateMagicBytes,
  getMaxFileSize,
  isYamlSafe,
  isJsonValid,
  type UploadableExtensionValidator,
  type MagicBytesDefinition,
} from '@/config/uploadable-extensions';

describe('UPLOADABLE_EXTENSIONS', () => {
  it('should be a readonly array', () => {
    expect(Array.isArray(UPLOADABLE_EXTENSIONS)).toBe(true);
  });

  it('should include image extensions', () => {
    expect(UPLOADABLE_EXTENSIONS).toContain('.png');
    expect(UPLOADABLE_EXTENSIONS).toContain('.jpg');
    expect(UPLOADABLE_EXTENSIONS).toContain('.jpeg');
    expect(UPLOADABLE_EXTENSIONS).toContain('.gif');
    expect(UPLOADABLE_EXTENSIONS).toContain('.webp');
  });

  it('should include text extensions', () => {
    expect(UPLOADABLE_EXTENSIONS).toContain('.txt');
    expect(UPLOADABLE_EXTENSIONS).toContain('.log');
    expect(UPLOADABLE_EXTENSIONS).toContain('.md');
    expect(UPLOADABLE_EXTENSIONS).toContain('.csv');
  });

  it('should include config extensions', () => {
    expect(UPLOADABLE_EXTENSIONS).toContain('.json');
    expect(UPLOADABLE_EXTENSIONS).toContain('.yaml');
    expect(UPLOADABLE_EXTENSIONS).toContain('.yml');
  });

  it('should include video extensions (Issue #302)', () => {
    expect(UPLOADABLE_EXTENSIONS).toContain('.mp4');
  });

  it('[SEC-002] should NOT include .svg (XSS risk)', () => {
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.svg');
  });

  it('should NOT include executable extensions', () => {
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.exe');
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.sh');
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.bat');
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.cmd');
    expect(UPLOADABLE_EXTENSIONS).not.toContain('.ps1');
  });
});

describe('UPLOADABLE_EXTENSION_VALIDATORS', () => {
  it('should have validators for all uploadable extensions', () => {
    for (const ext of UPLOADABLE_EXTENSIONS) {
      const validator = UPLOADABLE_EXTENSION_VALIDATORS.find(v => v.extension === ext);
      expect(validator, `Validator for ${ext} should exist`).toBeDefined();
    }
  });

  it('should have maxFileSize for all validators', () => {
    for (const validator of UPLOADABLE_EXTENSION_VALIDATORS) {
      expect(validator.maxFileSize).toBeGreaterThan(0);
    }
  });

  it('should have allowedMimeTypes for all validators', () => {
    for (const validator of UPLOADABLE_EXTENSION_VALIDATORS) {
      expect(Array.isArray(validator.allowedMimeTypes)).toBe(true);
      expect(validator.allowedMimeTypes.length).toBeGreaterThan(0);
    }
  });

  it('[SEC-001] should have magicBytes for binary image formats', () => {
    const binaryFormats = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const ext of binaryFormats) {
      const validator = UPLOADABLE_EXTENSION_VALIDATORS.find(v => v.extension === ext);
      expect(validator?.magicBytes, `magicBytes for ${ext} should exist`).toBeDefined();
      expect(validator?.magicBytes!.length).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_MAX_FILE_SIZE', () => {
  it('should be 5MB', () => {
    expect(DEFAULT_MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });
});

describe('isUploadableExtension', () => {
  describe('should accept uploadable extensions', () => {
    test.each(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.md', '.csv', '.json', '.yaml', '.yml'])(
      '%s is uploadable',
      (ext) => {
        expect(isUploadableExtension(ext)).toBe(true);
      }
    );
  });

  describe('should accept video extensions (Issue #302)', () => {
    it('.mp4 is uploadable', () => {
      expect(isUploadableExtension('.mp4')).toBe(true);
    });
  });

  describe('should be case-insensitive', () => {
    test.each(['.PNG', '.Jpg', '.JPEG', '.TXT', '.MD', '.MP4'])(
      '%s is uploadable (case-insensitive)',
      (ext) => {
        expect(isUploadableExtension(ext)).toBe(true);
      }
    );
  });

  describe('should reject non-uploadable extensions', () => {
    test.each(['.exe', '.sh', '.bat', '.cmd', '.ps1', '.dll', '.so', '.svg'])(
      '%s is rejected',
      (ext) => {
        expect(isUploadableExtension(ext)).toBe(false);
      }
    );
  });

  it('should handle edge cases', () => {
    expect(isUploadableExtension('')).toBe(false);
    expect(isUploadableExtension('png')).toBe(false); // no dot
  });
});

describe('validateMimeType', () => {
  describe('image MIME types', () => {
    it('should accept image/png for .png', () => {
      expect(validateMimeType('.png', 'image/png')).toBe(true);
    });

    it('should accept image/jpeg for .jpg', () => {
      expect(validateMimeType('.jpg', 'image/jpeg')).toBe(true);
    });

    it('should accept image/jpeg for .jpeg', () => {
      expect(validateMimeType('.jpeg', 'image/jpeg')).toBe(true);
    });

    it('should accept image/gif for .gif', () => {
      expect(validateMimeType('.gif', 'image/gif')).toBe(true);
    });

    it('should accept image/webp for .webp', () => {
      expect(validateMimeType('.webp', 'image/webp')).toBe(true);
    });
  });

  describe('text MIME types', () => {
    it('should accept text/plain for .txt', () => {
      expect(validateMimeType('.txt', 'text/plain')).toBe(true);
    });

    it('should accept text/plain for .log', () => {
      expect(validateMimeType('.log', 'text/plain')).toBe(true);
    });

    it('should accept text/markdown for .md', () => {
      expect(validateMimeType('.md', 'text/markdown')).toBe(true);
    });

    it('should accept text/plain for .md', () => {
      expect(validateMimeType('.md', 'text/plain')).toBe(true);
    });

    it('should accept text/csv for .csv', () => {
      expect(validateMimeType('.csv', 'text/csv')).toBe(true);
    });
  });

  describe('config MIME types', () => {
    it('should accept application/json for .json', () => {
      expect(validateMimeType('.json', 'application/json')).toBe(true);
    });

    it('should accept text/yaml for .yaml', () => {
      expect(validateMimeType('.yaml', 'text/yaml')).toBe(true);
    });

    it('should accept application/x-yaml for .yaml', () => {
      expect(validateMimeType('.yaml', 'application/x-yaml')).toBe(true);
    });

    it('should accept text/yaml for .yml', () => {
      expect(validateMimeType('.yml', 'text/yaml')).toBe(true);
    });
  });

  describe('video MIME types (Issue #302)', () => {
    it('should accept video/mp4 for .mp4', () => {
      expect(validateMimeType('.mp4', 'video/mp4')).toBe(true);
    });

    it('should reject video/webm for .mp4', () => {
      expect(validateMimeType('.mp4', 'video/webm')).toBe(false);
    });

    it('should reject text/plain for .mp4', () => {
      expect(validateMimeType('.mp4', 'text/plain')).toBe(false);
    });
  });

  describe('MIME type mismatch', () => {
    it('should reject text/plain for .png', () => {
      expect(validateMimeType('.png', 'text/plain')).toBe(false);
    });

    it('should reject image/png for .txt', () => {
      expect(validateMimeType('.txt', 'image/png')).toBe(false);
    });

    it('should reject application/octet-stream for .json', () => {
      expect(validateMimeType('.json', 'application/octet-stream')).toBe(false);
    });
  });

  describe('case insensitivity for extension', () => {
    it('should be case-insensitive for extension', () => {
      expect(validateMimeType('.PNG', 'image/png')).toBe(true);
      expect(validateMimeType('.Jpg', 'image/jpeg')).toBe(true);
    });
  });

  describe('unknown extensions', () => {
    it('should return false for unknown extensions', () => {
      expect(validateMimeType('.xyz', 'text/plain')).toBe(false);
    });
  });
});

describe('[SEC-001] validateMagicBytes', () => {
  describe('PNG validation', () => {
    it('should accept valid PNG magic bytes', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
      expect(validateMagicBytes('.png', pngBuffer)).toBe(true);
    });

    it('should reject invalid PNG magic bytes (text content)', () => {
      const textBuffer = Buffer.from('Hello World');
      expect(validateMagicBytes('.png', textBuffer)).toBe(false);
    });

    it('should reject buffer too small for PNG', () => {
      const smallBuffer = Buffer.from([0x89, 0x50]);
      expect(validateMagicBytes('.png', smallBuffer)).toBe(false);
    });
  });

  describe('JPEG validation', () => {
    it('should accept valid JPEG magic bytes', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      expect(validateMagicBytes('.jpg', jpegBuffer)).toBe(true);
    });

    it('should accept valid JPEG magic bytes for .jpeg', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10]);
      expect(validateMagicBytes('.jpeg', jpegBuffer)).toBe(true);
    });

    it('should reject invalid JPEG magic bytes', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
      expect(validateMagicBytes('.jpg', pngBuffer)).toBe(false);
    });
  });

  describe('GIF validation', () => {
    it('should accept GIF87a magic bytes', () => {
      const gif87aBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);
      expect(validateMagicBytes('.gif', gif87aBuffer)).toBe(true);
    });

    it('should accept GIF89a magic bytes', () => {
      const gif89aBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
      expect(validateMagicBytes('.gif', gif89aBuffer)).toBe(true);
    });

    it('should reject invalid GIF magic bytes', () => {
      const textBuffer = Buffer.from('NOT A GIF');
      expect(validateMagicBytes('.gif', textBuffer)).toBe(false);
    });
  });

  describe('WebP validation', () => {
    it('should accept valid WebP magic bytes (RIFF header)', () => {
      const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
      expect(validateMagicBytes('.webp', webpBuffer)).toBe(true);
    });

    it('should reject invalid WebP magic bytes', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF]);
      expect(validateMagicBytes('.webp', jpegBuffer)).toBe(false);
    });
  });

  describe('MP4 validation (Issue #302)', () => {
    it('should accept valid MP4 magic bytes (ftyp at offset 4)', () => {
      // MP4 files have 'ftyp' at offset 4
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x20, // box size (32 bytes)
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6F, 0x6D, // 'isom' brand
      ]);
      expect(validateMagicBytes('.mp4', mp4Buffer)).toBe(true);
    });

    it('should reject invalid MP4 magic bytes', () => {
      const invalidBuffer = Buffer.from([
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);
      expect(validateMagicBytes('.mp4', invalidBuffer)).toBe(false);
    });

    it('should reject buffer too small for MP4', () => {
      const smallBuffer = Buffer.from([0x00, 0x00, 0x00]);
      expect(validateMagicBytes('.mp4', smallBuffer)).toBe(false);
    });

    it('should reject text content disguised as MP4', () => {
      const textBuffer = Buffer.from('This is not a video file');
      expect(validateMagicBytes('.mp4', textBuffer)).toBe(false);
    });
  });

  describe('text files (no magic bytes required)', () => {
    it('should skip validation for .txt', () => {
      const textBuffer = Buffer.from('Hello World');
      expect(validateMagicBytes('.txt', textBuffer)).toBe(true);
    });

    it('should skip validation for .log', () => {
      const logBuffer = Buffer.from('Log entry 1');
      expect(validateMagicBytes('.log', logBuffer)).toBe(true);
    });

    it('should skip validation for .md', () => {
      const mdBuffer = Buffer.from('# Markdown');
      expect(validateMagicBytes('.md', mdBuffer)).toBe(true);
    });

    it('should skip validation for .csv', () => {
      const csvBuffer = Buffer.from('a,b,c');
      expect(validateMagicBytes('.csv', csvBuffer)).toBe(true);
    });

    it('should skip validation for .json', () => {
      const jsonBuffer = Buffer.from('{"key": "value"}');
      expect(validateMagicBytes('.json', jsonBuffer)).toBe(true);
    });

    it('should skip validation for .yaml', () => {
      const yamlBuffer = Buffer.from('key: value');
      expect(validateMagicBytes('.yaml', yamlBuffer)).toBe(true);
    });

    it('should skip validation for .yml', () => {
      const ymlBuffer = Buffer.from('key: value');
      expect(validateMagicBytes('.yml', ymlBuffer)).toBe(true);
    });
  });

  describe('unknown extensions', () => {
    it('should return true for unknown extensions (no magic bytes defined)', () => {
      const buffer = Buffer.from('content');
      expect(validateMagicBytes('.xyz', buffer)).toBe(true);
    });
  });
});

describe('getMaxFileSize', () => {
  it('should return default size for known extensions', () => {
    expect(getMaxFileSize('.png')).toBe(5 * 1024 * 1024);
    expect(getMaxFileSize('.txt')).toBe(5 * 1024 * 1024);
    expect(getMaxFileSize('.json')).toBe(5 * 1024 * 1024);
  });

  it('should return 15MB for .mp4 (Issue #302)', () => {
    expect(getMaxFileSize('.mp4')).toBe(15 * 1024 * 1024);
  });

  it('should be case-insensitive', () => {
    expect(getMaxFileSize('.PNG')).toBe(5 * 1024 * 1024);
    expect(getMaxFileSize('.Txt')).toBe(5 * 1024 * 1024);
  });

  it('should return default size for unknown extensions', () => {
    expect(getMaxFileSize('.xyz')).toBe(5 * 1024 * 1024);
  });
});

describe('[SEC-006] isYamlSafe', () => {
  describe('safe YAML content', () => {
    it('should accept simple key-value', () => {
      expect(isYamlSafe('key: value')).toBe(true);
    });

    it('should accept nested structure', () => {
      expect(isYamlSafe('root:\n  child: value\n  list:\n    - item1\n    - item2')).toBe(true);
    });

    it('should accept arrays', () => {
      expect(isYamlSafe('items:\n  - one\n  - two\n  - three')).toBe(true);
    });

    it('should accept multiline strings', () => {
      expect(isYamlSafe('description: |\n  This is a\n  multiline string')).toBe(true);
    });
  });

  describe('dangerous YAML tags', () => {
    it('should reject !ruby/object tag', () => {
      expect(isYamlSafe('--- !ruby/object:Gem::Requirement\nspecs:\n  - !ruby/object:Gem::Dependency')).toBe(false);
    });

    it('should reject !python/object tag', () => {
      expect(isYamlSafe('exploit: !python/object/apply:os.system\nargs: ["ls"]')).toBe(false);
    });

    it('should reject !!python tag', () => {
      expect(isYamlSafe('!!python/object/apply:os.system ["whoami"]')).toBe(false);
    });

    it('should reject !!ruby tag', () => {
      expect(isYamlSafe('!!ruby/object:Gem::Installer\ni: x')).toBe(false);
    });

    it('should be case-insensitive for dangerous tags', () => {
      expect(isYamlSafe('--- !Ruby/Object:Test')).toBe(false);
      expect(isYamlSafe('--- !PYTHON/object:Test')).toBe(false);
    });
  });
});

describe('[SEC-007] isJsonValid', () => {
  describe('valid JSON', () => {
    it('should accept empty object', () => {
      expect(isJsonValid('{}')).toBe(true);
    });

    it('should accept empty array', () => {
      expect(isJsonValid('[]')).toBe(true);
    });

    it('should accept simple object', () => {
      expect(isJsonValid('{"key": "value"}')).toBe(true);
    });

    it('should accept nested object', () => {
      expect(isJsonValid('{"root": {"child": "value"}}')).toBe(true);
    });

    it('should accept array of objects', () => {
      expect(isJsonValid('[{"id": 1}, {"id": 2}]')).toBe(true);
    });

    it('should accept various data types', () => {
      expect(isJsonValid('{"string": "text", "number": 42, "bool": true, "null": null}')).toBe(true);
    });
  });

  describe('invalid JSON', () => {
    it('should reject unquoted keys', () => {
      expect(isJsonValid('{key: "value"}')).toBe(false);
    });

    it('should reject single quotes', () => {
      expect(isJsonValid("{'key': 'value'}")).toBe(false);
    });

    it('should reject trailing comma', () => {
      expect(isJsonValid('{"key": "value",}')).toBe(false);
    });

    it('should reject incomplete JSON', () => {
      expect(isJsonValid('{"key":')).toBe(false);
    });

    it('should reject plain text', () => {
      expect(isJsonValid('not json at all')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isJsonValid('')).toBe(false);
    });
  });
});

describe('Type exports', () => {
  it('should export UploadableExtensionValidator interface', () => {
    const validator: UploadableExtensionValidator = {
      extension: '.test',
      maxFileSize: 1000,
      allowedMimeTypes: ['text/plain'],
    };
    expect(validator).toBeDefined();
  });

  it('should export MagicBytesDefinition interface', () => {
    const magicBytes: MagicBytesDefinition = {
      bytes: [0x89, 0x50, 0x4E, 0x47],
      offset: 0,
    };
    expect(magicBytes).toBeDefined();
  });
});
