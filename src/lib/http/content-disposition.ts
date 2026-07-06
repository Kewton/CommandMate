/**
 * Content-Disposition helpers (Issue #1024)
 *
 * Builds a safe `Content-Disposition: attachment` header value for file
 * downloads. Prevents HTTP header injection (CR/LF/control chars) and supports
 * non-ASCII (e.g. Japanese) filenames per RFC 6266 / RFC 5987.
 *
 * @module lib/http/content-disposition
 */

import { basename } from 'path';

/** Control characters (C0 + DEL) that must never reach a response header. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/g;

/** Any character outside the printable ASCII range (0x20-0x7e). */
// eslint-disable-next-line no-control-regex
const NON_ASCII_PRINTABLE_REGEX = /[^\x20-\x7e]/g;

/**
 * Percent-encode a string for the RFC 5987 `filename*` value (UTF-8''...).
 *
 * `encodeURIComponent` leaves `! ~ * ' ( )` unescaped; of these `* ' ( )` are
 * NOT part of the RFC 5987 `attr-char` set, so they are additionally
 * percent-encoded here. Over-encoding of `attr-char` symbols is harmless.
 *
 * @param value - Raw (already control-stripped) filename
 * @returns RFC 5987 percent-encoded value
 */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Reduce an untrusted filename to its basename with all control characters
 * (including CR/LF) removed. Shared first step for both header parameters.
 */
function baseNoControl(rawFilename: string): string {
  const base = basename(String(rawFilename).replace(/\\/g, '/'));
  return base.replace(CONTROL_CHARS_REGEX, '');
}

/**
 * Sanitize a raw filename into a safe ASCII fallback for the quoted
 * `filename="..."` parameter.
 *
 * Steps:
 * 1. basename only — strips any directory components / path separators.
 * 2. Removes CR/LF and other control characters (header-injection defense).
 * 3. Strips non-ASCII characters (ASCII fallback only).
 * 4. Neutralizes `"` and `\` (would otherwise break/escape the quoted-string).
 *
 * @param rawFilename - The untrusted filename (may include path segments)
 * @returns A non-empty ASCII-safe filename (falls back to `download`)
 */
export function sanitizeAsciiFilename(rawFilename: string): string {
  const ascii = baseNoControl(rawFilename)
    .replace(NON_ASCII_PRINTABLE_REGEX, '')
    .replace(/["\\]/g, '_')
    .trim();
  return ascii || 'download';
}

/**
 * Sanitize a raw filename for the RFC 5987 `filename*` parameter (UTF-8).
 * Applies basename + control-char stripping, then percent-encodes.
 *
 * @param rawFilename - The untrusted filename (may include path segments)
 * @returns Percent-encoded UTF-8 filename (falls back to `download`)
 */
export function sanitizeUtf8Filename(rawFilename: string): string {
  return encodeRFC5987(baseNoControl(rawFilename).trim()) || 'download';
}

/**
 * Build a complete, injection-safe `Content-Disposition` header value that
 * forces an attachment download and preserves the original (possibly
 * non-ASCII) filename.
 *
 * Format (RFC 6266):
 *   `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`
 *
 * @param rawFilename - The untrusted filename (may include path segments)
 * @returns Header value safe to place in `Content-Disposition`
 */
export function buildAttachmentContentDisposition(rawFilename: string): string {
  const ascii = sanitizeAsciiFilename(rawFilename);
  const utf8 = sanitizeUtf8Filename(rawFilename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
