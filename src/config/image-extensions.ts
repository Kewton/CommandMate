/**
 * Image Extensions Configuration
 * [SF-001] Configuration for image file extensions
 * [Stage 3 SF-001] isImageExtension() function for extension validation
 *
 * This module defines which file extensions are recognized as images
 * and provides security validation for image files.
 *
 * Security features:
 * - Extension whitelist
 * - Magic bytes validation for binary formats
 * - SVG XSS prevention (script tags, event handlers, dangerous URIs, foreignObject)
 */

/**
 * List of supported image file extensions
 * All extensions must include the leading dot
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
] as const;

/**
 * Maximum image file size in bytes (5MB)
 * [SF-001] Named with _BYTES suffix for clarity, matching existing patterns
 */
export const IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Image extension validator configuration
 * [SF-004] Separate from ExtensionValidator for image-specific properties
 */
export interface ImageExtensionValidator {
  /** File extension including the dot (e.g., '.png') */
  extension: string;
  /** MIME type for the image format */
  mimeType: string;
  /** Magic bytes at the start of the file (undefined for text-based formats like SVG) */
  magicBytes?: number[];
  /** Offset from start of file to check magic bytes (default: 0) */
  magicBytesOffset?: number;
}

/**
 * Validators for each supported image extension
 * Includes magic bytes for binary format verification
 */
export const IMAGE_EXTENSION_VALIDATORS: ImageExtensionValidator[] = [
  {
    extension: '.png',
    mimeType: 'image/png',
    magicBytes: [0x89, 0x50, 0x4E, 0x47],
  },
  {
    extension: '.jpg',
    mimeType: 'image/jpeg',
    magicBytes: [0xFF, 0xD8, 0xFF],
  },
  {
    extension: '.jpeg',
    mimeType: 'image/jpeg',
    magicBytes: [0xFF, 0xD8, 0xFF],
  },
  {
    extension: '.gif',
    mimeType: 'image/gif',
    magicBytes: [0x47, 0x49, 0x46, 0x38],
  },
  {
    extension: '.webp',
    mimeType: 'image/webp',
    magicBytes: [0x52, 0x49, 0x46, 0x46],
  },
  {
    extension: '.svg',
    mimeType: 'image/svg+xml',
    // SVG is text-based, no magic bytes
  },
];

/**
 * Image content validation result
 * [SF-002] Consistent with ContentValidationResult pattern
 */
export interface ImageValidationResult {
  /** Whether the content is valid */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Check if a file extension is a supported image format
 * [SF-003] Handles dot normalization for API compatibility
 *
 * @param ext - File extension with or without leading dot
 * @returns True if the extension is a supported image format
 */
export function isImageExtension(ext: string): boolean {
  if (!ext) return false;
  // Normalize: add dot if missing, convert to lowercase
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase();
  return IMAGE_EXTENSIONS.includes(normalizedExt);
}

/**
 * Validate image file magic bytes
 * [SF-003] Handles dot normalization
 *
 * @param extension - File extension with or without leading dot
 * @param buffer - File content buffer
 * @returns True if magic bytes match the expected format
 */
export function validateImageMagicBytes(
  extension: string,
  buffer: Buffer
): boolean {
  // Normalize extension
  const normalizedExt = extension.startsWith('.')
    ? extension.toLowerCase()
    : '.' + extension.toLowerCase();

  const validator = IMAGE_EXTENSION_VALIDATORS.find(
    v => v.extension === normalizedExt
  );

  if (!validator?.magicBytes) {
    // SVG is text-based, no magic bytes to validate
    return normalizedExt === '.svg';
  }

  const offset = validator.magicBytesOffset || 0;

  // Check if buffer is long enough
  if (buffer.length < offset + validator.magicBytes.length) {
    return false;
  }

  return validator.magicBytes.every(
    (byte, index) => buffer[offset + index] === byte
  );
}

/**
 * Validate WebP magic bytes completely
 * [SEC-SF-004] Checks both RIFF header and WEBP signature
 *
 * @param buffer - File content buffer
 * @returns True if both RIFF header and WEBP signature are present
 */
export function validateWebPMagicBytes(buffer: Buffer): boolean {
  // RIFF header check (offset 0-3)
  const riffHeader = [0x52, 0x49, 0x46, 0x46];
  const hasRiff = riffHeader.every((byte, i) => buffer[i] === byte);

  if (!hasRiff) {
    return false;
  }

  // WEBP signature check (offset 8-11)
  if (buffer.length < 12) {
    return false;
  }

  const webpSignature = [0x57, 0x45, 0x42, 0x50];
  return webpSignature.every((byte, i) => buffer[8 + i] === byte);
}

/**
 * Validate SVG content for security
 * [SEC-MF-001] Event handler detection
 * [SEC-MF-002] Dangerous URI scheme detection
 * [SEC-MF-003] foreignObject element detection
 *
 * This function serves two purposes:
 * 1. SVG format validation: Ensures the content is valid SVG
 * 2. Security validation: Detects XSS attack vectors
 *
 * @param content - SVG file content as string
 * @returns Validation result with error message if invalid
 */
export function validateSvgContent(content: string): ImageValidationResult {
  // [Format validation] Check for SVG tag or XML declaration
  if (!content.includes('<svg') && !content.startsWith('<?xml')) {
    return { valid: false, error: 'Invalid SVG format' };
  }

  // [Security 1] Script tag detection (XSS prevention)
  if (/<script[\s>]/i.test(content)) {
    return { valid: false, error: 'SVG contains script tags' };
  }

  // [Security 2] Event handler attribute detection (SEC-MF-001)
  // Matches: onload, onclick, onmouseover, onerror, onfocus, etc.
  // Example attack: <svg onload="alert('XSS')">
  if (/\s+on\w+\s*=/i.test(content)) {
    return { valid: false, error: 'SVG contains event handler attributes' };
  }

  // [Security 3] Dangerous URI scheme detection (SEC-MF-002)
  // Matches: href="javascript:...", xlink:href="data:...", href="vbscript:..."
  // Example attack: <a xlink:href="javascript:alert('XSS')">
  if (/(?:xlink:)?href\s*=\s*["']?\s*(?:javascript|data|vbscript):/i.test(content)) {
    return { valid: false, error: 'SVG contains dangerous URI scheme' };
  }

  // [Security 4] foreignObject element detection (SEC-MF-003)
  // foreignObject can embed arbitrary HTML including scripts
  // Example attack: <foreignObject><body><script>...</script></body></foreignObject>
  if (/<foreignObject[\s>]/i.test(content)) {
    return { valid: false, error: 'SVG contains foreignObject element' };
  }

  return { valid: true };
}

/**
 * Validate image content comprehensively
 * [SF-002] Combines size, magic bytes, and SVG security validation
 *
 * @param extension - File extension with or without leading dot
 * @param buffer - File content buffer
 * @returns Validation result with error message if invalid
 */
export function validateImageContent(
  extension: string,
  buffer: Buffer
): ImageValidationResult {
  // File size validation
  if (buffer.length > IMAGE_MAX_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size exceeds ${IMAGE_MAX_SIZE_BYTES / 1024 / 1024}MB limit`,
    };
  }

  // Normalize extension
  const normalizedExt = extension.startsWith('.')
    ? extension.toLowerCase()
    : '.' + extension.toLowerCase();

  // SVG requires special validation (text-based, XSS concerns)
  if (normalizedExt === '.svg') {
    const content = buffer.toString('utf-8');
    return validateSvgContent(content);
  }

  // Binary formats require magic bytes validation
  if (!validateImageMagicBytes(extension, buffer)) {
    return { valid: false, error: 'Invalid image magic bytes' };
  }

  return { valid: true };
}
