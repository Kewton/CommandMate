/**
 * API Route: /api/worktrees/:id/files/:path
 * File operations for worktree files
 *
 * Methods:
 * - GET: Read file content (existing)
 * - HEAD: Existence probe — status only, no body ([Issue #2274])
 * - PUT: Update file content
 * - POST: Create new file or directory
 * - DELETE: Delete file or directory
 * - PATCH: Rename file or directory
 *
 * [SF-001] Business logic delegated to file-operations.ts
 * [SF-002] Path validation using isPathSafe()
 * [SEC-SF-002] Error responses without absolute paths
 * [REFACTOR] DRY: Centralized error code to HTTP status mapping
 * [Issue #2014] Deny-tier paths (.env* / *.pem / *.key / .git) are refused on
 *   EVERY method by getWorktreeAndValidatePath — see sensitive-file-guard.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { normalize, join } from 'path';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
import { findSensitivePathSegment } from '@/lib/security/sensitive-file-guard';
import {
  readFileContent,
  updateFileContent,
  createFileOrDirectory,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  moveFileOrDirectory,
  isEditableFile,
  readFileLineRange,
} from '@/lib/file-operations';
import { validateContent, isEditableExtension, TEXT_MAX_SIZE_BYTES } from '@/config/editable-extensions';
import {
  isImageExtension,
  validateImageContent,
  getMimeTypeByExtension,
} from '@/config/image-extensions';
import {
  isVideoExtension,
  getMimeTypeByVideoExtension,
  validateVideoContent,
} from '@/config/video-extensions';
import { isHtmlExtension, HTML_MAX_SIZE_BYTES } from '@/config/html-extensions';
import {
  isPdfExtension,
  validatePdfContent,
  PDF_MIME_TYPE,
} from '@/config/pdf-extensions';
import { extname } from 'path';
import { readFile, stat } from 'fs/promises';
import type { Stats } from 'fs';
import { createLogger } from '@/lib/logger';
import { buildAttachmentContentDisposition } from '@/lib/http/content-disposition';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import type { FileReadOnlyReason } from '@/types/models';

const logger = createLogger('api/files');

/**
 * [DRY] Centralized mapping of error codes to HTTP status codes
 * Eliminates duplicate statusMap definitions across handlers
 * [CONS-001] Extended with upload-specific error codes
 */
const ERROR_CODE_TO_HTTP_STATUS: Record<string, number> = {
  FILE_NOT_FOUND: 404,
  WORKTREE_NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  NOT_EDITABLE: 403,
  PROTECTED_DIRECTORY: 403,
  INVALID_PATH: 400,
  INVALID_REQUEST: 400,
  INVALID_NAME: 400,
  INVALID_CONTENT: 400,
  DIRECTORY_NOT_EMPTY: 400,
  DELETE_LIMIT_EXCEEDED: 400,
  FILE_EXISTS: 409,
  DISK_FULL: 507,
  INTERNAL_ERROR: 500,
  // Upload-specific error codes [CONS-001]
  INVALID_EXTENSION: 400,
  INVALID_MIME_TYPE: 400,
  INVALID_MAGIC_BYTES: 400,
  FILE_TOO_LARGE: 413,
  INVALID_FILENAME: 400,
  INVALID_FILE_CONTENT: 400,
  // Move-specific error codes
  MOVE_SAME_PATH: 400,
  MOVE_INTO_SELF: 400,
  // PDF-specific error codes (Issue #673)
  PDF_SIZE_EXCEEDED: 413,
  // [Issue #2014] Path matches a deny-tier pattern (.env / *.pem / *.key / .git)
  SENSITIVE_PATH: 403,
};

/**
 * [DRY] Helper function to create error response with appropriate HTTP status
 */
function createErrorResponse(
  code: string,
  message: string,
  defaultStatus: number = 500
): NextResponse {
  const status = ERROR_CODE_TO_HTTP_STATUS[code] ?? defaultStatus;
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status }
  );
}

/**
 * [Issue #723] Result of parsing `startLine` / `endLine` query parameters.
 *
 * - `{ mode: 'full' }`: neither param present — normal full-content path.
 * - `{ mode: 'range', startLine, endLine }`: both numeric values; caller delegates
 *   to {@link readFileLineRange}, which performs its own range validation.
 * - `{ mode: 'invalid' }`: one or both params present but not numeric.
 */
type LineRangeParseResult =
  | { mode: 'full' }
  | { mode: 'range'; startLine: number; endLine: number }
  | { mode: 'invalid' };

function parseLineRangeParams(searchParams: URLSearchParams): LineRangeParseResult {
  const startLineParam = searchParams.get('startLine');
  const endLineParam = searchParams.get('endLine');
  if (startLineParam === null && endLineParam === null) {
    return { mode: 'full' };
  }
  const startLine = Number(startLineParam);
  const endLine = Number(endLineParam);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return { mode: 'invalid' };
  }
  return { mode: 'range', startLine, endLine };
}

/**
 * Render a byte count as megabytes for the read-only notice shown to the user.
 * One decimal place, so a 2.0MB ceiling and the 2.4MB file that exceeded it do
 * not both print as "2MB" and read as a contradiction.
 */
function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Decide whether an editable-extension GET must be served READ-ONLY because the
 * file is over its editing ceiling. Returns the reason to attach to the
 * response, or `null` when the file is within bounds.
 *
 * [Issue #2505] This used to be `enforceEditableSizeGuards()`, which returned a
 * 413 and so made an oversize `.md` unreadable as well as unsaveable. One size
 * number was doing two unrelated jobs: "too big to send to a textarea editor"
 * and "too big to look at". Only the first is true. Viewing is now always
 * allowed and the ceiling governs WRITES alone — PUT still rejects oversize
 * content through `validateContent()`'s `maxFileSize`, unchanged.
 *
 * This mattered immediately rather than theoretically: making an extension
 * editable (Issue #2506 does exactly that for `.txt`) used to silently take
 * away the ability to read large files with that extension, because the guard
 * keys off `isEditableExtension()`. Non-editable extensions were, and remain,
 * uncapped here.
 *
 * Precedence is unchanged: [Issue #490] HTML gets its own 5MB ceiling and is
 * checked first; [Issue #723] every other editable extension gets 2MB.
 */
function evaluateEditableSizeLimit(ext: string, sizeBytes: number): FileReadOnlyReason | null {
  const limitBytes = isHtmlExtension(ext)
    ? HTML_MAX_SIZE_BYTES
    : isEditableExtension(ext)
      ? TEXT_MAX_SIZE_BYTES
      : null;

  if (limitBytes === null || sizeBytes <= limitBytes) return null;

  return {
    code: 'FILE_TOO_LARGE',
    message:
      `Opened read-only: this file is ${formatMegabytes(sizeBytes)}, over the ` +
      `${formatMegabytes(limitBytes)} limit for editing. You can view it but not save changes.`,
    limitBytes,
    sizeBytes,
  };
}

/**
 * Helper function to get worktree and validate path
 */
async function getWorktreeAndValidatePath(
  worktreeId: string,
  pathSegments: string[]
): Promise<
  | { worktree: { path: string }; relativePath: string }
  | { error: NextResponse }
> {
  const db = getDbInstance();
  const worktree = getWorktreeById(db, worktreeId);

  if (!worktree) {
    return {
      error: createErrorResponse('WORKTREE_NOT_FOUND', 'Worktree not found'),
    };
  }

  const requestedPath = pathSegments.join('/');
  const normalizedPath = normalize(requestedPath);

  // [SF-002] Use isPathSafe for path validation
  if (!isPathSafe(normalizedPath, worktree.path)) {
    return {
      error: createErrorResponse('INVALID_PATH', 'Invalid file path'),
    };
  }

  // [SEC-394] Symlink traversal validation
  if (!resolveAndValidateRealPath(normalizedPath, worktree.path)) {
    return {
      error: createErrorResponse('INVALID_PATH', 'Invalid path'),
    };
  }

  // [Issue #2014] Deny-tier patterns are refused here, i.e. for GET, PUT, POST,
  // DELETE and PATCH alike. A GET-only check was measurably useless: PATCH
  // {action:'rename'} moved `.env` to `leaked.md` and the next GET returned the
  // body. The check runs on the raw segments AND on the normalised path, because
  // only the normalised path is what reaches `fs` (`a/../.env`), while only the
  // raw segments still carry any percent-encoding.
  const sensitiveSegment =
    findSensitivePathSegment(pathSegments) ?? findSensitivePathSegment(normalizedPath);
  if (sensitiveSegment) {
    // The offending segment is deliberately NOT echoed back: the response body
    // is a place secrets have leaked from before, and the client already knows
    // what it asked for.
    return {
      error: createErrorResponse(
        'SENSITIVE_PATH',
        'This path is protected and cannot be accessed through the file API',
      ),
    };
  }

  return { worktree, relativePath: normalizedPath };
}

/**
 * GET /api/worktrees/:id/files/:path
 * Read file content (text or image)
 *
 * Image file handling:
 * 1. Check if extension is in IMAGE_EXTENSIONS
 * 2. Validate file size (5MB limit)
 * 3. Validate magic bytes (for binary formats)
 * 4. Validate SVG content (XSS prevention)
 * 5. Return Base64 data URI with isImage: true
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;
    const extension = relativePath.split('.').pop() || '';
    const ext = extname(relativePath).toLowerCase();

    // [Issue #1024] Raw attachment download branch.
    // Placed AFTER getWorktreeAndValidatePath (isPathSafe [SF-002] +
    // resolveAndValidateRealPath [SEC-394]) and BEFORE the type-specific
    // (image/video/PDF/text) branches, so path validation is never bypassed.
    // Strict gate: only `?download=1` (exact) triggers attachment delivery; any
    // other value / absence leaves existing GET behavior unchanged.
    // Serves the RAW bytes (never the base64 JSON path), bypassing preview size
    // limits. octet-stream + attachment + X-Content-Type-Options: nosniff
    // (next.config.js) prevent inline execution of SVG/HTML.
    if (request.nextUrl.searchParams.get('download') === '1') {
      // Reuse the validated real path: worktree.path is trusted (DB) and
      // relativePath is normalized + validated. Never re-join untrusted input.
      const downloadPath = join(worktree.path, relativePath);
      try {
        const fileBuffer = await readFile(downloadPath);
        return new NextResponse(fileBuffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': buildAttachmentContentDisposition(relativePath),
            'Cache-Control': 'no-store, private',
          },
        });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse('FILE_NOT_FOUND', 'File not found');
        }
        throw err;
      }
    }

    // Check if this is an image file
    if (isImageExtension(ext)) {
      // Read file as binary for image processing
      const absolutePath = join(worktree.path, relativePath);

      try {
        // Read file as binary (will throw ENOENT if not found)
        const fileBuffer = await readFile(absolutePath);

        // Validate image content (size, magic bytes, SVG security)
        const validation = validateImageContent(ext, fileBuffer);
        if (!validation.valid) {
          // Map validation errors to appropriate error codes
          if (validation.error?.includes('5MB')) {
            return createErrorResponse('FILE_TOO_LARGE', validation.error);
          }
          if (validation.error?.includes('magic bytes')) {
            return createErrorResponse('INVALID_MAGIC_BYTES', validation.error);
          }
          // SVG security errors
          return createErrorResponse('INVALID_FILE_CONTENT', validation.error || 'Invalid image content');
        }

        // [DRY] Get MIME type using centralized helper
        const mimeType = getMimeTypeByExtension(ext);

        // Convert to Base64 data URI
        const base64 = fileBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64}`;

        return NextResponse.json({
          success: true,
          path: relativePath,
          content: dataUri,
          extension,
          worktreePath: worktree.path,
          isImage: true,
          mimeType,
        });
      } catch (err: unknown) {
        // File not found or read error
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse('FILE_NOT_FOUND', 'File not found');
        }
        throw err;
      }
    }

    // Check if this is a video file (Issue #302)
    if (isVideoExtension(ext)) {
      const absolutePath = join(worktree.path, relativePath);

      try {
        // [DRY] Check file size before reading full content (memory efficiency)
        const fileStat = await stat(absolutePath);
        const maxSizeBytes = 100 * 1024 * 1024; // VIDEO_MAX_SIZE_BYTES
        if (fileStat.size > maxSizeBytes) {
          return createErrorResponse('FILE_TOO_LARGE', `File size exceeds ${maxSizeBytes / 1024 / 1024}MB limit`);
        }

        // Read file as binary
        const fileBuffer = await readFile(absolutePath);

        // Validate video content (size, magic bytes)
        const validation = validateVideoContent(ext, fileBuffer);
        if (!validation.valid) {
          if (validation.error?.includes('MB')) {
            return createErrorResponse('FILE_TOO_LARGE', validation.error);
          }
          if (validation.error?.includes('magic bytes')) {
            return createErrorResponse('INVALID_MAGIC_BYTES', validation.error);
          }
          return createErrorResponse('INVALID_FILE_CONTENT', validation.error || 'Invalid video content');
        }

        // [DRY] Get MIME type using centralized helper
        const mimeType = getMimeTypeByVideoExtension(ext) || 'video/mp4';

        // Convert to Base64 data URI
        const base64 = fileBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64}`;

        return NextResponse.json({
          success: true,
          path: relativePath,
          content: dataUri,
          extension,
          worktreePath: worktree.path,
          isVideo: true,
          mimeType,
        });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse('FILE_NOT_FOUND', 'File not found');
        }
        throw err;
      }
    }

    // Check if this is a PDF file (Issue #673)
    if (isPdfExtension(ext)) {
      const absolutePath = join(worktree.path, relativePath);

      try {
        const fileBuffer = await readFile(absolutePath);

        const validation = validatePdfContent(fileBuffer);
        if (!validation.valid) {
          if (validation.error?.includes('MB')) {
            return createErrorResponse('PDF_SIZE_EXCEEDED', validation.error);
          }
          return createErrorResponse(
            'INVALID_MAGIC_BYTES',
            validation.error || 'Invalid PDF magic bytes',
          );
        }

        const base64 = fileBuffer.toString('base64');
        const dataUri = `data:${PDF_MIME_TYPE};base64,${base64}`;

        return NextResponse.json({
          success: true,
          path: relativePath,
          content: dataUri,
          extension,
          worktreePath: worktree.path,
          isPdf: true,
          mimeType: PDF_MIME_TYPE,
        });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse('FILE_NOT_FOUND', 'File not found');
        }
        throw err;
      }
    }

    // Non-image file: use existing text file reading logic
    // [Issue #469] Last-Modified / If-Modified-Since conditional request support
    const fullPath = join(worktree.path, relativePath);
    // [Issue #2349] A missing file is 404 here too. This `stat` used to sit
    // outside every `try`, so ENOENT fell through to the outer catch and became
    // 500 INTERNAL_ERROR — the only one of the four GET branches that did.
    // Same shape as the download / image / video branches: ENOENT only; EACCES
    // and the rest still propagate and stay 500.
    let fileStat: Stats;
    try {
      fileStat = await stat(fullPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse('FILE_NOT_FOUND', 'File not found');
      }
      throw err;
    }

    // [Issue #2505] Read-only evaluation happens once, before the line-range
    // branch, so a partial slice and a full read of the same oversize file agree
    // about being read-only. Previously the size ceiling was only consulted on
    // the full-content path, which meant a line-range request for a 3MB `.md`
    // succeeded while a full request for it was refused with 413.
    //
    // Order matters:
    //   1. [Issue #490] HTML 5MB ceiling — HTML has its own dedicated limit.
    //   2. [Issue #723] Non-HTML editable text 2MB ceiling — `.md` / `.yaml` /
    //      `.yml`, evaluated AFTER HTML so HTML keeps its own ceiling.
    // Non-editable plain text remains uncapped at this layer.
    const readOnlyReason = evaluateEditableSizeLimit(ext, fileStat.size);
    const readOnlyFields = readOnlyReason
      ? { readOnly: true as const, readOnlyReason }
      : {};

    // [Issue #723] Line-range mode detection — when present, skip the
    // If-Modified-Since/304 fast-path and always return 200 with a partial
    // payload (sub-ranges of the same mtime are independently requestable).
    const { searchParams } = new URL(request.url);
    const lineRangeParams = parseLineRangeParams(searchParams);

    if (lineRangeParams.mode === 'invalid') {
      return createErrorResponse('INVALID_REQUEST', 'startLine and endLine must be numeric');
    }

    if (lineRangeParams.mode === 'range') {
      const rangeResult = await readFileLineRange(
        worktree.path,
        relativePath,
        lineRangeParams.startLine,
        lineRangeParams.endLine,
      );

      if (!rangeResult.success) {
        return createErrorResponse(
          rangeResult.error?.code || 'INTERNAL_ERROR',
          rangeResult.error?.message || 'Failed to read file range',
        );
      }

      return NextResponse.json({
        success: true,
        path: relativePath,
        content: rangeResult.content,
        extension,
        worktreePath: worktree.path,
        totalLines: rangeResult.totalLines,
        totalBytes: rangeResult.totalBytes,
        encoding: rangeResult.encoding,
        range: rangeResult.range,
        ...readOnlyFields,
      });
    }

    const lastModified = fileStat.mtime.toUTCString();

    // Check If-Modified-Since header for 304 response
    const ifModifiedSince = request.headers.get('If-Modified-Since');
    if (ifModifiedSince) {
      const clientDate = new Date(ifModifiedSince);
      // [SEC-F7] isNaN check: invalid date strings fallback to 200 (full body)
      if (!isNaN(clientDate.getTime()) && fileStat.mtime <= clientDate) {
        return new Response(null, {
          status: 304,
          headers: {
            'Last-Modified': lastModified,
            'Cache-Control': 'no-store, private',
          },
        });
      }
    }

    const fileResult = await readFileContent(worktree.path, relativePath);

    if (!fileResult.success) {
      return createErrorResponse(
        fileResult.error?.code || 'INTERNAL_ERROR',
        fileResult.error?.message || 'Failed to read file'
      );
    }

    // [Issue #490] Add isHtml flag for HTML files
    const isHtml = isHtmlExtension(ext);

    return NextResponse.json({
      success: true,
      path: relativePath,
      content: fileResult.content,
      extension,
      worktreePath: worktree.path,
      ...(isHtml && { isHtml: true }),
      totalBytes: fileStat.size,
      ...readOnlyFields,
    }, {
      headers: {
        'Last-Modified': lastModified,
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (error: unknown) {
    logger.error('error-reading-file:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse('INTERNAL_ERROR', 'Failed to read file');
  }
}

/**
 * HEAD /api/worktrees/:id/files/:path
 * Answer whether a regular file exists at this path — status only, no body.
 *
 * [Issue #2274] A file path in a chat reply became a button without anyone
 * asking whether the file was there, so clicking `/docs/uat/report.md` (a path
 * belonging to a DIFFERENT repository, which the linkifier had sliced out of the
 * middle of a relative path) opened an empty tab that could only fail. The chat
 * surface now probes with this method first and shows a toast instead when the
 * answer is no.
 *
 * Why a dedicated handler rather than leaning on Next's implicit HEAD, which
 * runs GET and drops the body: GET base64-encodes images, videos and PDFs and
 * reads whole files off disk to produce a body that would then be thrown away.
 * This asks `stat` and nothing else.
 *
 * The guarantees a caller may rely on:
 *
 *  - path validation is IDENTICAL to every other method here, because it is the
 *    same {@link getWorktreeAndValidatePath} call: outside the worktree is 400,
 *    a deny-tier path ([Issue #2014] `.env*` / `*.pem` / `*.key` / `.git`) is
 *    403, and neither answer says whether anything is there;
 *  - 200 means a REGULAR FILE. A directory answers 404, because the resource
 *    this route addresses is a file and GET on a directory fails too; the probe
 *    exists to predict whether opening will work, so it must not say yes where
 *    opening says no;
 *  - the response has no body and no `Last-Modified`. It is not a cheaper GET
 *    and callers must not treat it as a freshness check.
 */
export async function HEAD(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      // The validation helper builds JSON error bodies for the other methods; a
      // HEAD response carries no body, so only the status survives.
      return new NextResponse(null, { status: result.error.status });
    }

    const { worktree, relativePath } = result;

    try {
      const fileStat = await stat(join(worktree.path, relativePath));
      if (!fileStat.isFile()) {
        return new NextResponse(null, { status: 404 });
      }
      return new NextResponse(null, {
        status: 200,
        headers: { 'Cache-Control': 'no-store, private' },
      });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTDIR is the answer for `a.txt/b.txt`, where a path SEGMENT is a file.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
        return new NextResponse(null, { status: 404 });
      }
      throw err;
    }
  } catch (error: unknown) {
    logger.error('error-probing-file:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new NextResponse(null, { status: 500 });
  }
}

/**
 * PUT /api/worktrees/:id/files/:path
 * Update file content
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;

    // Check if file is editable
    if (!isEditableFile(relativePath)) {
      return createErrorResponse('NOT_EDITABLE', 'File type is not editable');
    }

    const body = await request.json();
    const { content } = body;

    if (content === undefined) {
      return createErrorResponse('INVALID_REQUEST', 'Content is required');
    }

    // [SEC-SF-001] Validate content
    const ext = extname(relativePath).toLowerCase();
    const contentValidation = validateContent(ext, content);
    if (!contentValidation.valid) {
      return createErrorResponse('INVALID_CONTENT', contentValidation.error || 'Invalid content');
    }

    const updateResult = await updateFileContent(worktree.path, relativePath, content);

    if (!updateResult.success) {
      return createErrorResponse(
        updateResult.error?.code || 'INTERNAL_ERROR',
        updateResult.error?.message || 'Failed to update file'
      );
    }

    return NextResponse.json({
      success: true,
      path: relativePath,
    });
  } catch (error: unknown) {
    logger.error('error-updating-file:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse('INTERNAL_ERROR', 'Failed to update file');
  }
}

/**
 * POST /api/worktrees/:id/files/:path
 * Create new file or directory
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;

    const body = await request.json();
    const { type, content } = body;

    if (!type || !['file', 'directory'].includes(type)) {
      return createErrorResponse('INVALID_REQUEST', 'Type must be "file" or "directory"');
    }

    // For files, validate content if provided
    if (type === 'file' && content !== undefined) {
      const ext = extname(relativePath).toLowerCase();
      if (isEditableExtension(ext)) {
        const contentValidation = validateContent(ext, content);
        if (!contentValidation.valid) {
          return createErrorResponse('INVALID_CONTENT', contentValidation.error || 'Invalid content');
        }
      }
    }

    const createResult = await createFileOrDirectory(worktree.path, relativePath, type, content);

    if (!createResult.success) {
      return createErrorResponse(
        createResult.error?.code || 'INTERNAL_ERROR',
        createResult.error?.message || 'Failed to create file/directory'
      );
    }

    return NextResponse.json(
      { success: true, path: relativePath },
      { status: 201 }
    );
  } catch (error: unknown) {
    logger.error('error-creating-filedirectory:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse('INTERNAL_ERROR', 'Failed to create file/directory');
  }
}

/**
 * DELETE /api/worktrees/:id/files/:path
 * Delete file or directory
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;

    // Check for recursive parameter
    const { searchParams } = new URL(request.url);
    const recursive = searchParams.get('recursive') === 'true';

    const deleteResult = await deleteFileOrDirectory(worktree.path, relativePath, recursive);

    if (!deleteResult.success) {
      return createErrorResponse(
        deleteResult.error?.code || 'INTERNAL_ERROR',
        deleteResult.error?.message || 'Failed to delete file/directory'
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error('error-deleting-filedirectory:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse('INTERNAL_ERROR', 'Failed to delete file/directory');
  }
}

/**
 * PATCH /api/worktrees/:id/files/:path
 * Rename file or directory (action: rename)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id: requestedWorktreeId, path } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const result = await getWorktreeAndValidatePath(id, path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;

    const body = await request.json();
    const { action, newName, destination } = body;

    switch (action) {
      case 'rename': {
        if (!newName || typeof newName !== 'string') {
          return createErrorResponse('INVALID_REQUEST', 'newName is required');
        }

        // [Issue #2014] The destination is guarded too, so the API can never
        // CREATE a path it then refuses to manage: renaming `notes.md` to
        // `.env` would otherwise strand the file (unreadable, undeletable).
        if (findSensitivePathSegment([newName])) {
          return createErrorResponse(
            'SENSITIVE_PATH',
            'This path is protected and cannot be accessed through the file API',
          );
        }

        const renameResult = await renameFileOrDirectory(worktree.path, relativePath, newName);

        if (!renameResult.success) {
          return createErrorResponse(
            renameResult.error?.code || 'INTERNAL_ERROR',
            renameResult.error?.message || 'Failed to rename file/directory'
          );
        }

        return NextResponse.json({
          success: true,
          path: renameResult.path,
        });
      }

      case 'move': {
        // [MF-S3-002] Validate destination parameter
        if (!destination || typeof destination !== 'string') {
          return createErrorResponse('INVALID_REQUEST', 'destination is required and must be a string');
        }

        // [Issue #2014] Same rule for the move destination directory.
        if (findSensitivePathSegment(destination)) {
          return createErrorResponse(
            'SENSITIVE_PATH',
            'This path is protected and cannot be accessed through the file API',
          );
        }

        const moveResult = await moveFileOrDirectory(worktree.path, relativePath, destination);

        if (!moveResult.success) {
          return createErrorResponse(
            moveResult.error?.code || 'INTERNAL_ERROR',
            moveResult.error?.message || 'Failed to move file/directory'
          );
        }

        return NextResponse.json({
          success: true,
          path: moveResult.path,
        });
      }

      default:
        // [SF-S2-002] Updated error message with supported actions
        return createErrorResponse('INVALID_REQUEST', 'Unknown action. Supported: "rename", "move"');
    }
  } catch (error: unknown) {
    logger.error('error-renaming-filedirectory:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse('INTERNAL_ERROR', 'Failed to rename file/directory');
  }
}
