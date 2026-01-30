/**
 * API Route: /api/worktrees/:id/upload/:path
 * File upload endpoint for worktree files
 *
 * Methods:
 * - POST: Upload a file (multipart/form-data)
 *
 * Security:
 * - [SEC-001] Magic bytes validation
 * - [SEC-002] SVG excluded
 * - [SEC-004] Filename validation
 * - [SEC-005] Error messages without specific details
 * - [SEC-006] YAML safety validation
 * - [SEC-007] JSON syntax validation
 * - Path traversal prevention via isPathSafe()
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { normalize, extname } from 'path';
import { isPathSafe } from '@/lib/path-validator';
import {
  writeBinaryFile,
  isValidNewName,
  createErrorResult,
} from '@/lib/file-operations';
import {
  isUploadableExtension,
  validateMimeType,
  validateMagicBytes,
  getMaxFileSize,
  isYamlSafe,
  isJsonValid,
} from '@/config/uploadable-extensions';

/**
 * [DRY] Centralized mapping of error codes to HTTP status codes
 * [CONS-001] Upload-specific error codes included
 */
const ERROR_CODE_TO_HTTP_STATUS: Record<string, number> = {
  FILE_NOT_FOUND: 404,
  WORKTREE_NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  INVALID_PATH: 400,
  INVALID_REQUEST: 400,
  FILE_EXISTS: 409,
  DISK_FULL: 507,
  INTERNAL_ERROR: 500,
  // Upload-specific error codes
  INVALID_EXTENSION: 400,
  INVALID_MIME_TYPE: 400,
  INVALID_MAGIC_BYTES: 400,
  FILE_TOO_LARGE: 413,
  INVALID_FILENAME: 400,
  INVALID_FILE_CONTENT: 400,
};

/**
 * Helper function to create error response with appropriate HTTP status
 */
function createUploadErrorResponse(
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
 * POST /api/worktrees/:id/upload/:path
 * Upload a file to the specified directory
 *
 * Request: multipart/form-data with 'file' field
 * Response: { success: true, path, filename, size } or error
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    // Get worktree
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return createUploadErrorResponse('WORKTREE_NOT_FOUND', 'Worktree not found');
    }

    // Validate target directory path
    const targetDir = params.path.join('/');
    const normalizedDir = normalize(targetDir);

    if (!isPathSafe(normalizedDir, worktree.path)) {
      return createUploadErrorResponse('INVALID_PATH', 'Invalid file path');
    }

    // Parse multipart form data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return createUploadErrorResponse('INVALID_REQUEST', 'Invalid form data', 400);
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return createUploadErrorResponse('INVALID_REQUEST', 'File is required', 400);
    }

    const filename = file.name;
    const mimeType = file.type;
    const fileSize = file.size;

    // 1. Extension validation (whitelist)
    const ext = extname(filename).toLowerCase();
    if (!isUploadableExtension(ext)) {
      const errorResult = createErrorResult('INVALID_EXTENSION');
      return createUploadErrorResponse(
        errorResult.error!.code,
        errorResult.error!.message
      );
    }

    // 2. MIME type validation
    if (!validateMimeType(ext, mimeType)) {
      const errorResult = createErrorResult('INVALID_MIME_TYPE');
      return createUploadErrorResponse(
        errorResult.error!.code,
        errorResult.error!.message
      );
    }

    // 3. Get file content as buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 4. Magic bytes validation [SEC-001]
    if (!validateMagicBytes(ext, buffer)) {
      const errorResult = createErrorResult('INVALID_MAGIC_BYTES');
      return createUploadErrorResponse(
        errorResult.error!.code,
        errorResult.error!.message
      );
    }

    // 5. File size validation
    const maxSize = getMaxFileSize(ext);
    if (fileSize > maxSize) {
      const errorResult = createErrorResult('FILE_TOO_LARGE');
      return createUploadErrorResponse(
        errorResult.error!.code,
        errorResult.error!.message
      );
    }

    // 6. Filename validation [SEC-004]
    const nameValidation = isValidNewName(filename, { forUpload: true });
    if (!nameValidation.valid) {
      const errorResult = createErrorResult('INVALID_FILENAME');
      return createUploadErrorResponse(
        errorResult.error!.code,
        errorResult.error!.message
      );
    }

    // 7. Structured file content validation [SEC-006, SEC-007]
    if (ext === '.yaml' || ext === '.yml') {
      const content = buffer.toString('utf-8');
      if (!isYamlSafe(content)) {
        const errorResult = createErrorResult('INVALID_FILE_CONTENT');
        return createUploadErrorResponse(
          errorResult.error!.code,
          errorResult.error!.message
        );
      }
    }

    if (ext === '.json') {
      const content = buffer.toString('utf-8');
      if (!isJsonValid(content)) {
        const errorResult = createErrorResult('INVALID_FILE_CONTENT');
        return createUploadErrorResponse(
          errorResult.error!.code,
          errorResult.error!.message
        );
      }
    }

    // 8. Build the full relative path
    const relativePath = normalizedDir ? `${normalizedDir}/${filename}` : filename;

    // 9. Write file
    const writeResult = await writeBinaryFile(worktree.path, relativePath, buffer);

    if (!writeResult.success) {
      return createUploadErrorResponse(
        writeResult.error?.code || 'INTERNAL_ERROR',
        writeResult.error?.message || 'Failed to upload file'
      );
    }

    // 10. Return success response
    // [CONS-002] filename is added at API route level, not from writeBinaryFile
    return NextResponse.json(
      {
        success: true,
        path: writeResult.path,
        filename: filename,
        size: writeResult.size,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error('Error uploading file:', error);
    return createUploadErrorResponse('INTERNAL_ERROR', 'Failed to upload file');
  }
}
