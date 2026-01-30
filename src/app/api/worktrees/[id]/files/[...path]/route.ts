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
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { normalize } from 'path';
import { isPathSafe } from '@/lib/path-validator';
import {
  readFileContent,
  updateFileContent,
  createFileOrDirectory,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  isEditableFile,
} from '@/lib/file-operations';
import { validateContent, isEditableExtension } from '@/config/editable-extensions';
import { extname } from 'path';

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

  return { worktree, relativePath: normalizedPath };
}

/**
 * GET /api/worktrees/:id/files/:path
 * Read file content
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const result = await getWorktreeAndValidatePath(params.id, params.path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;
    const fileResult = await readFileContent(worktree.path, relativePath);

    if (!fileResult.success) {
      return createErrorResponse(
        fileResult.error?.code || 'INTERNAL_ERROR',
        fileResult.error?.message || 'Failed to read file'
      );
    }

    const extension = relativePath.split('.').pop() || '';

    return NextResponse.json({
      success: true,
      path: relativePath,
      content: fileResult.content,
      extension,
      worktreePath: worktree.path,
    });
  } catch (error: unknown) {
    console.error('Error reading file:', error);
    return createErrorResponse('INTERNAL_ERROR', 'Failed to read file');
  }
}

/**
 * PUT /api/worktrees/:id/files/:path
 * Update file content
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const result = await getWorktreeAndValidatePath(params.id, params.path);
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
    console.error('Error updating file:', error);
    return createErrorResponse('INTERNAL_ERROR', 'Failed to update file');
  }
}

/**
 * POST /api/worktrees/:id/files/:path
 * Create new file or directory
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const result = await getWorktreeAndValidatePath(params.id, params.path);
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
    console.error('Error creating file/directory:', error);
    return createErrorResponse('INTERNAL_ERROR', 'Failed to create file/directory');
  }
}

/**
 * DELETE /api/worktrees/:id/files/:path
 * Delete file or directory
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const result = await getWorktreeAndValidatePath(params.id, params.path);
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
    console.error('Error deleting file/directory:', error);
    return createErrorResponse('INTERNAL_ERROR', 'Failed to delete file/directory');
  }
}

/**
 * PATCH /api/worktrees/:id/files/:path
 * Rename file or directory (action: rename)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const result = await getWorktreeAndValidatePath(params.id, params.path);
    if ('error' in result) {
      return result.error;
    }

    const { worktree, relativePath } = result;

    const body = await request.json();
    const { action, newName } = body;

    if (action !== 'rename') {
      return createErrorResponse('INVALID_REQUEST', 'Unknown action. Supported: "rename"');
    }

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
  } catch (error: unknown) {
    console.error('Error renaming file/directory:', error);
    return createErrorResponse('INTERNAL_ERROR', 'Failed to rename file/directory');
  }
}
