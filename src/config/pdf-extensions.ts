/**
 * PDF Extensions Configuration
 * Issue #673: PDF viewer implementation
 *
 * This module defines constants and validators for PDF file handling:
 * - Extension whitelist
 * - Size limit (20MB)
 * - Magic bytes (`%PDF-`) verification
 * - iframe sandbox attribute for Blob URL + iframe rendering
 *
 * Follows the same pattern as `src/config/image-extensions.ts`
 * and `src/config/video-extensions.ts`.
 */

import { normalizeExtension } from '@/config/image-extensions';

/**
 * List of supported PDF file extensions
 * All extensions must include the leading dot.
 */
export const PDF_EXTENSIONS: readonly string[] = ['.pdf'] as const;

/**
 * Maximum PDF file size in bytes (20MB).
 *
 * Rationale: matches image size limits; Base64-encoded payload stays
 * within ~27MB which is safe for Node/V8 memory usage.
 */
export const PDF_MAX_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * PDF file magic bytes (`%PDF-`).
 *
 * Every well-formed PDF starts with these 5 bytes followed by a version
 * indicator (e.g., `1.4`).
 */
export const PDF_MAGIC_BYTES: readonly number[] = [
  0x25, // %
  0x50, // P
  0x44, // D
  0x46, // F
  0x2d, // -
] as const;

/**
 * iframe sandbox attribute for PDF preview.
 *
 * Left `undefined` intentionally. Chrome's built-in PDF viewer renders
 * `application/pdf` by navigating the iframe to its internal MIME-handler
 * extension origin. Any `sandbox` value (even `allow-scripts
 * allow-same-origin`) causes Chrome to block that navigation and show
 * "このページは Chrome によってブロックされています" in the iframe.
 *
 * Omitting the attribute is acceptable here because:
 *   - The blob URL already inherits the creator document's origin — no new
 *     cross-origin access is granted by dropping the sandbox.
 *   - PDF bytes are not executed as page scripts; Chrome renders them via
 *     its internal PDF viewer extension in a privileged origin.
 *   - PDF-embedded JavaScript (AcroForms) runs inside the PDF viewer's
 *     own sandbox, not the page context.
 *   - Clickjacking is still mitigated by the host page's
 *     `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`.
 *
 * React renders `sandbox={undefined}` as no attribute, which is what we want.
 */
export const PDF_IFRAME_SANDBOX: string | undefined = undefined;

/**
 * MIME type for PDF content.
 */
export const PDF_MIME_TYPE = 'application/pdf';

/**
 * PDF content validation result.
 */
export interface PdfValidationResult {
  /** Whether the content passes all validation checks */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Check whether a file extension is a supported PDF format.
 *
 * @param ext - File extension with or without leading dot (case-insensitive)
 * @returns True if the extension is `.pdf`
 */
export function isPdfExtension(ext: string): boolean {
  if (!ext) return false;
  const normalized = normalizeExtension(ext);
  return PDF_EXTENSIONS.includes(normalized);
}

/**
 * Validate PDF magic bytes (first 5 bytes).
 *
 * @param buffer - Raw file content (Buffer or Uint8Array)
 * @returns True if the buffer starts with `%PDF-`
 */
export function validatePdfMagicBytes(buffer: Uint8Array): boolean {
  if (buffer.length < PDF_MAGIC_BYTES.length) {
    return false;
  }
  return PDF_MAGIC_BYTES.every((byte, index) => buffer[index] === byte);
}

/**
 * Comprehensive PDF content validation (size + magic bytes).
 *
 * @param buffer - Raw file content
 * @returns Validation result with an error message when invalid
 */
export function validatePdfContent(buffer: Uint8Array): PdfValidationResult {
  if (buffer.length > PDF_MAX_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size exceeds ${PDF_MAX_SIZE_BYTES / 1024 / 1024}MB limit`,
    };
  }

  if (!validatePdfMagicBytes(buffer)) {
    return {
      valid: false,
      error: 'Invalid PDF magic bytes',
    };
  }

  return { valid: true };
}
