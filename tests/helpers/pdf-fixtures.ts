/**
 * PDF Test Fixtures Helper
 * Issue #673: PDF viewer implementation
 *
 * Provides helper functions to generate PDF Buffer fixtures for unit tests
 * without needing actual PDF files on disk.
 */

/**
 * Standard PDF header magic bytes: `%PDF-`
 */
const PDF_HEADER_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/**
 * Trailing bytes to append after the header to produce a minimally
 * recognizable `%PDF-1.4` signature followed by a newline.
 */
const PDF_VERSION_SUFFIX = [0x31, 0x2e, 0x34, 0x0a] as const; // "1.4\n"

/**
 * Create a minimal valid PDF Buffer starting with the correct magic bytes.
 *
 * The content is not a fully conforming PDF, but it satisfies the
 * magic-byte validation performed by `validatePdfMagicBytes` / `validatePdfContent`.
 *
 * @returns Buffer representing `%PDF-1.4\n...` minimal PDF content
 */
export function createMinimalPdfBuffer(): Buffer {
  const header = Buffer.from([...PDF_HEADER_BYTES, ...PDF_VERSION_SUFFIX]);
  const body = Buffer.from('%%EOF\n', 'utf-8');
  return Buffer.concat([header, body]);
}

/**
 * Create a PDF Buffer of an arbitrary size (for size-limit testing).
 *
 * The buffer starts with the correct PDF magic bytes so that magic byte
 * validation passes, allowing tests to focus on size validation logic.
 *
 * @param bytes - Total buffer size in bytes (must be >= PDF_HEADER_BYTES.length)
 * @returns Buffer of requested size starting with `%PDF-` header
 */
export function createPdfBufferOfSize(bytes: number): Buffer {
  if (bytes < PDF_HEADER_BYTES.length) {
    throw new Error(`Size must be >= ${PDF_HEADER_BYTES.length} bytes`);
  }
  const buffer = Buffer.alloc(bytes, 0x20); // fill with spaces
  for (let i = 0; i < PDF_HEADER_BYTES.length; i += 1) {
    buffer[i] = PDF_HEADER_BYTES[i];
  }
  return buffer;
}

/**
 * Create a "broken" PDF Buffer whose magic bytes do NOT match the PDF signature.
 *
 * Used to verify that magic-byte validation rejects non-PDF content that
 * happens to have a `.pdf` extension.
 *
 * @returns Buffer without the `%PDF-` prefix
 */
export function createBrokenPdfBuffer(): Buffer {
  return Buffer.from('NOT_A_PDF_FILE\n', 'utf-8');
}
