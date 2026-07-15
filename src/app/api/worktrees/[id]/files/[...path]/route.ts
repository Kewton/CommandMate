/**
 * API Route: /api/worktrees/:id/files/:path
 * File operations for worktree files
 *
 * Methods:
 * - GET: Read file content (existing)
 * - PUT: Update file content
 * - POST: Create new file or directory
 * - DELETE: Delete file or directory
 * - PATCH: Rename file or directory
 *
 * [SF-001] Business logic delegated to file-operations.ts
 * [SF-002] Path validation using isPathSafe()
 * [SEC-SF-002] Error responses without absolute paths
 * [REFACTOR] DRY: Centralized error code to HTTP status mapping
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { normalize, join } from 'path';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
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
import { createLogger } from '@/lib/logger';
import { buildAttachmentContentDisposition } from '@/lib/http/content-disposition';

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
 * Apply size pre-guards for editable text GETs. Returns the first matching
 * 413 response (HTML > 5MB, or non-HTML editable > 2MB) or `null` when the
 * file is within bounds. Centralizes the precedence rule described inline at
 * the call site.
 *
 * [Issue #490] HTML 5MB. [Issue #723] Non-HTML editable 2MB.
 */
function enforceEditableSizeGuards(ext: string, sizeBytes: number): NextResponse | null {
  if (isHtmlExtension(ext)) {
    if (sizeBytes > HTML_MAX_SIZE_BYTES) {
      return createErrorResponse(
        'FILE_TOO_LARGE',
        `HTML file exceeds ${HTML_MAX_SIZE_BYTES} bytes limit`,
      );
    }
    return null;
  }
  if (isEditableExtension(ext) && sizeBytes > TEXT_MAX_SIZE_BYTES) {
    return createErrorResponse(
      'FILE_TOO_LARGE',
      `Editable file exceeds ${TEXT_MAX_SIZE_BYTES} bytes limit (${(TEXT_MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB)`,
    );
  }
  return null;
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
    const { id, path } = await params;
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
    const fileStat = await stat(fullPath);

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
      });
    }

    // Editable-text size guards. Order matters:
    //   1. [Issue #490] HTML 5MB ceiling — HTML has its own dedicated limit.
    //   2. [Issue #723] Non-HTML editable text 2MB ceiling — `.md` / `.yaml` /
    //      `.yml`, evaluated AFTER the HTML branch so HTML keeps its own ceiling.
    // Non-editable plain text remains uncapped at this layer.
    const sizeGuardError = enforceEditableSizeGuards(ext, fileStat.size);
    if (sizeGuardError) return sizeGuardError;

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
 * PUT /api/worktrees/:id/files/:path
 * Update file content
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id, path } = await params;
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
    const { id, path } = await params;
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
    const { id, path } = await params;
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
    const { id, path } = await params;
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
