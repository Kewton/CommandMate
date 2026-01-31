/**
 * Binary Extensions Configuration
 * [Issue #21] File tree search functionality
 * [DP-004] Extracted as config file for extensibility
 * [IMPACT-SF-004] Integrates with image-extensions.ts for consistency
 *
 * This module defines which file extensions are binary and should be
 * excluded from text-based content searching.
 */

import { IMAGE_EXTENSIONS } from './image-extensions';

/**
 * List of binary file extensions
 * Includes image extensions and other binary formats
 *
 * Note: Image extensions are imported from image-extensions.ts
 * to maintain consistency across the codebase.
 */
export const BINARY_EXTENSIONS = [
  // Image extensions (imported for consistency)
  ...IMAGE_EXTENSIONS,
  // Executable files
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  // Archive files
  '.zip',
  '.tar',
  '.gz',
  '.tar.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  // Document formats (binary)
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Font files
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Media files
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wav',
  '.flac',
  '.ogg',
  // Database files
  '.sqlite',
  '.db',
  // Object files
  '.o',
  '.obj',
  '.a',
  '.lib',
  // Other binary formats
  '.class',
  '.jar',
  '.war',
  '.pyc',
  '.pyo',
  '.wasm',
] as const;

/**
 * Type for binary extension values
 */
export type BinaryExtension = (typeof BINARY_EXTENSIONS)[number];

/**
 * Check if a file extension is a binary format
 *
 * @param ext - File extension with or without leading dot
 * @returns True if the extension is a binary format
 *
 * @example
 * ```typescript
 * isBinaryExtension('.png');  // true
 * isBinaryExtension('pdf');   // true
 * isBinaryExtension('.ts');   // false
 * ```
 */
export function isBinaryExtension(ext: string): boolean {
  if (!ext) return false;
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase();
  return BINARY_EXTENSIONS.includes(normalizedExt as BinaryExtension);
}

/**
 * Check if file content appears to be binary
 * Uses NULL byte detection as a fallback for files without recognized extensions
 *
 * @param content - File content as Buffer
 * @returns True if content appears to be binary
 */
export function isBinaryContent(content: Buffer): boolean {
  // Check for NULL byte (common in binary files)
  return content.includes(0x00);
}
