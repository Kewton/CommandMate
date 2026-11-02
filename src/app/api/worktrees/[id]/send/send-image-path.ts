/**
 * POST /api/worktrees/:id/send — `imagePath` validation (Issue #474; moved out
 * of the route by Issue #4055).
 */

import { NextResponse } from 'next/server';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
import path from 'path';

/** [S4-M2] URL schemes that are not allowed in imagePath (SSRF prevention) */
const DANGEROUS_SCHEMES = ['file://', 'http://', 'https://', 'ftp://', 'data:'];

/** [S4-M1] Control character regex for CLI injection prevention */
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Helper function to create a JSON error response
 * Issue #474: Centralized error response for imagePath validation
 */
function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

/**
 * Validate and resolve imagePath to an absolute path
 * Issue #474: Extracted from POST handler for SRP and readability
 *
 * Security validations:
 * - [S4-M2] URL scheme rejection (SSRF prevention)
 * - [S2-M2] Path traversal defense
 * - [S2-M1] Symlink traversal defense
 * - [S4-S4] Whitelist: must be within .commandmate/attachments/
 * - [S4-M1] Control character check for CLI injection prevention
 *
 * @param imagePath - Relative image path from request body
 * @param worktreePath - Absolute path of the worktree
 * @returns Resolved absolute path on success, or NextResponse error
 */
export function validateImagePath(
  imagePath: string,
  worktreePath: string
): string | NextResponse {
  // [S4-M2] URL scheme rejection (SSRF prevention)
  if (DANGEROUS_SCHEMES.some(scheme => imagePath.startsWith(scheme))) {
    return errorResponse('INVALID_PATH', 'URL schemes are not allowed in imagePath', 400);
  }

  // [S2-M2] Path traversal defense
  if (!isPathSafe(imagePath, worktreePath)) {
    return errorResponse('INVALID_PATH', 'Invalid image path', 400);
  }

  // [S2-M1] Symlink traversal defense
  if (!resolveAndValidateRealPath(imagePath, worktreePath)) {
    return errorResponse('INVALID_PATH', 'Invalid image path (symlink)', 400);
  }

  // [S4-S4] Whitelist: must be within .commandmate/attachments/
  const ALLOWED_IMAGE_DIR = path.join(worktreePath, '.commandmate', 'attachments');
  const resolvedPath = path.resolve(worktreePath, imagePath);
  if (!resolvedPath.startsWith(ALLOWED_IMAGE_DIR + path.sep) && resolvedPath !== ALLOWED_IMAGE_DIR) {
    return errorResponse('INVALID_PATH', 'imagePath must be within .commandmate/attachments/', 400);
  }

  // [S4-M1] Control character check for CLI injection prevention
  if (CONTROL_CHAR_REGEX.test(resolvedPath)) {
    return errorResponse('INVALID_PATH', 'Path contains control characters', 400);
  }

  return resolvedPath;
}

/**
 * The absolute path of the body's `imagePath` (undefined when it names none),
 * or the 400 {@link validateImagePath} answered (Issue #4055).
 */
export function resolveSendImagePath(
  imagePath: string | undefined,
  worktreePath: string,
): { ok: true; value: string | undefined } | { ok: false; response: NextResponse } {
  // Issue #474: Validate imagePath if provided (HTTP-layer validation stays here)
  let absoluteImagePath: string | undefined;
  if (imagePath) {
    const validationResult = validateImagePath(imagePath, worktreePath);
    if (validationResult instanceof NextResponse) {
      return { ok: false, response: validationResult };
    }
    absoluteImagePath = validationResult;
  }
  return { ok: true, value: absoluteImagePath };
}
