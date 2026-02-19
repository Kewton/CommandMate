/**
 * Uploadable Extension Validator Configuration
 * [CONSISTENCY-001] Pattern aligned with editable-extensions.ts
 * [SEC-001] Includes magic bytes validation
 * [SEC-002] SVG excluded due to XSS risk
 *
 * This module defines which file extensions can be uploaded.
 */

/**
 * Magic bytes definition for file type validation
 * [SEC-001] Required for server-side content verification
 */
export interface MagicBytesDefinition {
  /** Magic bytes as hex array */
  bytes: number[];
  /** Offset from file start (default: 0) */
  offset?: number;
}

/**
 * Uploadable extension validator configuration
 * Follows the same pattern as ExtensionValidator in editable-extensions.ts
 * [CONS-003] maxFileSize is required (unlike optional in ExtensionValidator)
 * [SEC-001] magicBytes added for content verification
 */
export interface UploadableExtensionValidator {
  /** File extension (e.g., '.png', '.csv') */
  extension: string;
  /** Maximum file size in bytes (required for uploads) */
  maxFileSize: number;
  /** Allowed MIME types for this extension */
  allowedMimeTypes: string[];
  /** Magic bytes for file type validation (optional for text files) */
  magicBytes?: MagicBytesDefinition[];
}

/**
 * Default maximum file size (5MB)
 */
export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Validators for each supported uploadable extension
 * [CONS-007] Naming follows {PURPOSE}_EXTENSION_VALIDATORS pattern
 * [SEC-001] Magic bytes defined for binary files
 * [SEC-002] SVG removed from list due to XSS risk
 */
export const UPLOADABLE_EXTENSION_VALIDATORS: UploadableExtensionValidator[] = [
  // Images (binary - magic bytes validation required)
  {
    extension: '.png',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['image/png'],
    magicBytes: [{ bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }], // PNG signature
  },
  {
    extension: '.jpg',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['image/jpeg'],
    magicBytes: [{ bytes: [0xFF, 0xD8, 0xFF] }], // JPEG signature
  },
  {
    extension: '.jpeg',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['image/jpeg'],
    magicBytes: [{ bytes: [0xFF, 0xD8, 0xFF] }], // JPEG signature
  },
  {
    extension: '.gif',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['image/gif'],
    magicBytes: [
      { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
      { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
    ],
  },
  {
    extension: '.webp',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['image/webp'],
    magicBytes: [{ bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }], // RIFF header (WebP starts with RIFF)
  },
  // [SEC-002] SVG removed: XSS risk due to embedded JavaScript capability
  // { extension: '.svg', maxFileSize: DEFAULT_MAX_FILE_SIZE, allowedMimeTypes: ['image/svg+xml'] },

  // Video (binary - magic bytes validation required)
  // [Issue #302] MP4 support with 15MB limit and ftyp magic bytes at offset 4
  {
    extension: '.mp4',
    maxFileSize: 15 * 1024 * 1024, // 15MB
    allowedMimeTypes: ['video/mp4'],
    magicBytes: [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }], // 'ftyp' at offset 4 (ISOBMFF)
  },

  // Text (no magic bytes validation - content validation is separate)
  {
    extension: '.txt',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/plain'],
  },
  {
    extension: '.log',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/plain'],
  },
  {
    extension: '.md',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/markdown', 'text/plain'],
  },
  {
    extension: '.csv',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/csv'],
  },

  // Config (structured text - syntax validation added)
  {
    extension: '.json',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['application/json'],
  },
  {
    extension: '.yaml',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/yaml', 'application/x-yaml'],
  },
  {
    extension: '.yml',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    allowedMimeTypes: ['text/yaml', 'application/x-yaml'],
  },
];

/**
 * List of uploadable extensions (derived from validators)
 */
export const UPLOADABLE_EXTENSIONS: readonly string[] = UPLOADABLE_EXTENSION_VALIDATORS.map(
  (v) => v.extension
) as readonly string[];

/**
 * Check if a file extension is uploadable
 *
 * @param extension - File extension including the dot (e.g., '.png')
 * @returns True if the extension is uploadable
 */
export function isUploadableExtension(extension: string): boolean {
  if (!extension) return false;
  const normalizedExt = extension.toLowerCase();
  return UPLOADABLE_EXTENSIONS.includes(normalizedExt);
}

/**
 * Get validator for a given extension
 * [DRY-001] Centralized validator lookup to avoid repetition
 *
 * @param extension - File extension (e.g., '.png')
 * @returns The validator for the extension, or undefined if not found
 */
function getValidator(extension: string): UploadableExtensionValidator | undefined {
  const normalizedExt = extension.toLowerCase();
  return UPLOADABLE_EXTENSION_VALIDATORS.find((v) => v.extension === normalizedExt);
}

/**
 * Validate MIME type for a given extension
 *
 * @param extension - File extension (e.g., '.png')
 * @param mimeType - MIME type to validate
 * @returns True if the MIME type is allowed for this extension
 */
export function validateMimeType(extension: string, mimeType: string): boolean {
  const validator = getValidator(extension);
  return validator?.allowedMimeTypes.includes(mimeType) ?? false;
}

/**
 * Validate magic bytes for a given extension
 * [SEC-001] Server-side content verification
 *
 * @param extension - File extension (e.g., '.png')
 * @param buffer - File content as Buffer
 * @returns True if magic bytes match, or if no magic bytes defined for this extension
 */
export function validateMagicBytes(extension: string, buffer: Buffer): boolean {
  const validator = getValidator(extension);

  // No magic bytes defined (text files) - skip validation
  if (!validator?.magicBytes || validator.magicBytes.length === 0) {
    return true;
  }

  // Check if any of the defined magic bytes match
  return validator.magicBytes.some((magic) => {
    const offset = magic.offset ?? 0;
    if (buffer.length < offset + magic.bytes.length) {
      return false;
    }
    return magic.bytes.every((byte, index) => buffer[offset + index] === byte);
  });
}

/**
 * Get maximum file size for a given extension
 *
 * @param extension - File extension (e.g., '.png')
 * @returns Maximum file size in bytes, or DEFAULT_MAX_FILE_SIZE if not found
 */
export function getMaxFileSize(extension: string): number {
  const validator = getValidator(extension);
  return validator?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
}

/**
 * Validate YAML content for dangerous tags
 * [SEC-006] Prevent YAML deserialization attacks
 *
 * @param content - YAML content as string
 * @returns True if YAML is safe (no dangerous tags)
 */
export function isYamlSafe(content: string): boolean {
  // Block dangerous YAML tags that could lead to code execution
  const dangerousTags = [
    /!ruby\/object/i,
    /!python\/object/i,
    /!!python/i,
    /!!ruby/i,
    /!<tag:yaml\.org,2002:python/i,
    /!<tag:yaml\.org,2002:ruby/i,
  ];

  return !dangerousTags.some((pattern) => pattern.test(content));
}

/**
 * Validate JSON syntax
 * [SEC-007] Ensure JSON is valid before accepting
 *
 * @param content - JSON content as string
 * @returns True if JSON is syntactically valid
 */
export function isJsonValid(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}
