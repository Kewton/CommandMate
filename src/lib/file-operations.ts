/**
 * File Operations Business Logic
 * [SF-001] Facade pattern for file operations
 * [SEC-SF-003] Rename path validation
 * [SEC-SF-004] Recursive delete safety
 * [SEC-SF-002] Error response without absolute paths
 *
 * This module provides a unified interface for file operations,
 * with security checks and proper error handling.
 */

import { readFile, writeFile, mkdir, rm, rename, stat, readdir } from 'fs/promises';
import { existsSync, realpathSync, statSync } from 'fs';
import { join, extname, dirname, basename, sep, resolve } from 'path';
import { isPathSafe } from './path-validator';
import { isEditableExtension } from '@/config/editable-extensions';
import { DELETE_SAFETY_CONFIG, isProtectedDirectory } from '@/config/file-operations';

/**
 * File operation result
 * [QUALITY-001] size property added for upload response (optional for backward compatibility)
 */
export interface FileOperationResult {
  success: boolean;
  path?: string;
  content?: string;
  size?: number;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Error codes for file operations
 * [CONS-001] Extended with upload-specific error codes
 */
export type FileOperationErrorCode =
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_PATH'
  | 'INVALID_NAME'
  | 'DIRECTORY_NOT_EMPTY'
  | 'FILE_EXISTS'
  | 'PROTECTED_DIRECTORY'
  | 'DELETE_LIMIT_EXCEEDED'
  | 'DISK_FULL'
  | 'INTERNAL_ERROR'
  // Upload-specific error codes
  | 'INVALID_EXTENSION'
  | 'INVALID_MIME_TYPE'
  | 'INVALID_MAGIC_BYTES'
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILENAME'
  | 'INVALID_FILE_CONTENT'
  // Move-specific error codes
  | 'MOVE_SAME_PATH'
  | 'MOVE_INTO_SELF';

/**
 * Error messages for each error code
 * [SEC-005] Upload error messages do not include specific details
 */
const ERROR_MESSAGES: Record<FileOperationErrorCode, string> = {
  FILE_NOT_FOUND: 'File not found',
  PERMISSION_DENIED: 'Permission denied',
  INVALID_PATH: 'Invalid path',
  INVALID_NAME: 'Invalid name',
  DIRECTORY_NOT_EMPTY: 'Directory is not empty',
  FILE_EXISTS: 'File already exists',
  PROTECTED_DIRECTORY: 'Protected directory cannot be deleted',
  DELETE_LIMIT_EXCEEDED: 'Delete limit exceeded',
  DISK_FULL: 'Disk is full',
  INTERNAL_ERROR: 'Internal error',
  // Upload-specific error messages [SEC-005]
  INVALID_EXTENSION: 'Unsupported file type',
  INVALID_MIME_TYPE: 'Invalid file format',
  INVALID_MAGIC_BYTES: 'Invalid file format',
  FILE_TOO_LARGE: 'File size exceeds limit',
  INVALID_FILENAME: 'Invalid filename',
  INVALID_FILE_CONTENT: 'Invalid file content',
  // Move-specific error messages
  MOVE_SAME_PATH: 'Source and destination are the same',
  MOVE_INTO_SELF: 'Cannot move a directory into itself',
};

/**
 * Create an error result
 * [SEC-SF-002] Does not include absolute paths
 * Exported for use in API routes
 *
 * @param code - Error code from FileOperationErrorCode
 * @param customMessage - Optional custom message to override the default
 * @returns FileOperationResult with success=false and error details
 */
export function createErrorResult(code: FileOperationErrorCode, customMessage?: string): FileOperationResult {
  return {
    success: false,
    error: {
      code,
      message: customMessage || ERROR_MESSAGES[code],
    },
  };
}

/**
 * Map a Node.js filesystem error to a FileOperationResult.
 * [DRY-003] Extracted from repeated error handling patterns in file operation functions.
 *
 * Handles common filesystem error codes:
 * - EACCES -> PERMISSION_DENIED
 * - ENOSPC -> DISK_FULL
 * - ENOTEMPTY -> DIRECTORY_NOT_EMPTY
 * - EEXIST -> FILE_EXISTS
 * - Everything else -> INTERNAL_ERROR
 *
 * @param error - The caught error (typically from fs/promises)
 * @returns FileOperationResult with the appropriate error code
 */
function mapFsError(error: unknown): FileOperationResult {
  const nodeError = error as NodeJS.ErrnoException;
  switch (nodeError.code) {
    case 'EACCES':
      return createErrorResult('PERMISSION_DENIED');
    case 'ENOSPC':
      return createErrorResult('DISK_FULL');
    case 'ENOTEMPTY':
      return createErrorResult('DIRECTORY_NOT_EMPTY');
    case 'EEXIST':
      return createErrorResult('FILE_EXISTS');
    default:
      return createErrorResult('INTERNAL_ERROR');
  }
}

/**
 * Check if a file is editable based on its extension
 *
 * @param filePath - File path to check
 * @returns True if the file is editable
 */
export function isEditableFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return isEditableExtension(ext);
}

/**
 * Characters forbidden by various operating systems
 * [SEC-004] Added for cross-platform compatibility and security
 */
const OS_FORBIDDEN_CHARS = /[<>:"|?*]/;

/**
 * Control characters (ASCII 0x00-0x1F)
 * [SEC-004] All control characters should be rejected
 */
const CONTROL_CHARS = /[\x00-\x1F]/;

/**
 * Validation options for isValidNewName
 */
export interface ValidateNameOptions {
  /** Enable additional checks for upload security [SEC-004] */
  forUpload?: boolean;
}

/**
 * Validate a new file/directory name
 * [SEC-SF-003] Prevents directory traversal via rename
 * [DRY-001] Unified filename validation for create and upload
 * [SEC-004] Enhanced validation for upload security
 *
 * @param newName - The new name to validate
 * @param options - Validation options
 * @returns Validation result
 */
export function isValidNewName(
  newName: string,
  options?: ValidateNameOptions
): { valid: boolean; error?: string } {
  // Check for empty name
  if (!newName || newName.trim() === '') {
    return { valid: false, error: 'Name cannot be empty' };
  }

  // Check for directory traversal first (before path separators)
  if (newName.includes('..')) {
    return { valid: false, error: 'Name cannot contain ".."' };
  }

  // Check for directory separators
  if (newName.includes('/') || newName.includes('\\')) {
    return { valid: false, error: 'Name cannot contain path separators' };
  }

  // Additional checks for upload
  if (options?.forUpload) {
    // [SEC-004] Check for all control characters (includes null bytes, newlines)
    if (CONTROL_CHARS.test(newName)) {
      return { valid: false, error: 'Name cannot contain control characters' };
    }

    // [SEC-004] Check for OS-specific forbidden characters
    if (OS_FORBIDDEN_CHARS.test(newName)) {
      return { valid: false, error: 'Name contains forbidden characters' };
    }

    // [SEC-004] Check for trailing spaces or dots (Windows compatibility)
    // Allow hidden files starting with dot (like .gitignore)
    if (newName.endsWith(' ') || newName.endsWith('.')) {
      return { valid: false, error: 'Name cannot end with space or dot' };
    }
  }

  return { valid: true };
}

/**
 * Read file content
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path to the file
 * @returns File content or error
 */
export async function readFileContent(
  worktreeRoot: string,
  relativePath: string
): Promise<FileOperationResult> {
  // Validate path
  if (!isPathSafe(relativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  const fullPath = join(worktreeRoot, relativePath);

  // Check if file exists
  if (!existsSync(fullPath)) {
    return createErrorResult('FILE_NOT_FOUND');
  }

  try {
    const content = await readFile(fullPath, 'utf-8');
    return {
      success: true,
      path: relativePath,
      content,
    };
  } catch (error) {
    return mapFsError(error);
  }
}

/**
 * Update file content
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path to the file
 * @param content - New content
 * @returns Success or error
 */
export async function updateFileContent(
  worktreeRoot: string,
  relativePath: string,
  content: string
): Promise<FileOperationResult> {
  // Validate path
  if (!isPathSafe(relativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  const fullPath = join(worktreeRoot, relativePath);

  // Check if file exists
  if (!existsSync(fullPath)) {
    return createErrorResult('FILE_NOT_FOUND');
  }

  try {
    await writeFile(fullPath, content, 'utf-8');
    return {
      success: true,
      path: relativePath,
    };
  } catch (error) {
    return mapFsError(error);
  }
}

/**
 * Create a new file or directory
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path for the new file/directory
 * @param type - Type to create ('file' or 'directory')
 * @param content - Initial content (for files only)
 * @returns Success or error
 */
export async function createFileOrDirectory(
  worktreeRoot: string,
  relativePath: string,
  type: 'file' | 'directory',
  content?: string
): Promise<FileOperationResult> {
  // Validate path
  if (!isPathSafe(relativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  const fullPath = join(worktreeRoot, relativePath);

  // Check if already exists
  if (existsSync(fullPath)) {
    return createErrorResult('FILE_EXISTS');
  }

  try {
    if (type === 'directory') {
      await mkdir(fullPath, { recursive: true });
    } else {
      // Ensure parent directory exists
      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }
      await writeFile(fullPath, content || '', 'utf-8');
    }

    return {
      success: true,
      path: relativePath,
    };
  } catch (error) {
    return mapFsError(error);
  }
}

/**
 * Count files in a directory recursively
 */
async function countFilesRecursive(dirPath: string, depth: number = 0): Promise<number> {
  if (depth > DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_DEPTH) {
    return DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES + 1; // Exceed limit to trigger error
  }

  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      count++;
      if (count > DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES) {
        return count;
      }
      if (entry.isDirectory()) {
        count += await countFilesRecursive(join(dirPath, entry.name), depth + 1);
        if (count > DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES) {
          return count;
        }
      }
    }
  } catch {
    // Ignore errors counting files
  }
  return count;
}

/**
 * Delete a file or directory
 * [SEC-SF-004] Protected directory check and delete limit
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path to delete
 * @param recursive - Whether to delete recursively
 * @returns Success or error
 */
export async function deleteFileOrDirectory(
  worktreeRoot: string,
  relativePath: string,
  recursive?: boolean
): Promise<FileOperationResult> {
  // Validate path
  if (!isPathSafe(relativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  // Check for protected directories
  if (isProtectedDirectory(relativePath)) {
    return createErrorResult('PROTECTED_DIRECTORY');
  }

  const fullPath = join(worktreeRoot, relativePath);

  // Check if exists
  if (!existsSync(fullPath)) {
    return createErrorResult('FILE_NOT_FOUND');
  }

  try {
    const fileStat = await stat(fullPath);

    if (fileStat.isDirectory()) {
      // Check if directory is empty
      const entries = await readdir(fullPath);
      if (entries.length > 0 && !recursive) {
        return createErrorResult('DIRECTORY_NOT_EMPTY');
      }

      // Check delete limit for recursive delete
      if (recursive) {
        const fileCount = await countFilesRecursive(fullPath);
        if (fileCount > DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES) {
          return createErrorResult(
            'DELETE_LIMIT_EXCEEDED',
            `Delete limit exceeded: ${fileCount} files (max: ${DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES})`
          );
        }
      }
    }

    // For empty directories, we can use rmdir behavior
    // For non-empty directories with recursive flag, use rm with recursive: true
    if (fileStat.isDirectory() && !recursive) {
      // Use rmdir for empty directories (will fail if not empty)
      const { rmdir } = await import('fs/promises');
      await rmdir(fullPath);
    } else {
      await rm(fullPath, { recursive: recursive || false, force: false });
    }

    return {
      success: true,
      path: relativePath,
    };
  } catch (error) {
    return mapFsError(error);
  }
}

/**
 * Common validation helper for file operations [MF-001]
 *
 * Validates source path safety (via isPathSafe) and existence.
 * [SF-S2-003] Only validates source path; destination validation is the caller's responsibility.
 *
 * Used by: renameFileOrDirectory, moveFileOrDirectory
 *
 * @param worktreeRoot - Root directory of the worktree (absolute path)
 * @param sourcePath - Relative path to the source file/directory
 * @returns Discriminated union:
 *   - `{ success: true, resolvedSource: string }` - Absolute path to the validated source
 *   - `{ success: false, error: FileOperationResult }` - Error result (INVALID_PATH or FILE_NOT_FOUND)
 *
 * @example
 * ```ts
 * const result = validateFileOperation('/path/to/worktree', 'src/file.ts');
 * if (!result.success) return result.error;
 * // result.resolvedSource is the absolute path
 * ```
 */
export function validateFileOperation(
  worktreeRoot: string,
  sourcePath: string
): { success: true; resolvedSource: string } | { success: false; error: FileOperationResult } {
  // 1. isPathSafe() for source path safety
  if (!isPathSafe(sourcePath, worktreeRoot)) {
    return { success: false, error: createErrorResult('INVALID_PATH') };
  }

  const fullPath = join(worktreeRoot, sourcePath);

  // 2. Source path existence check
  if (!existsSync(fullPath)) {
    return { success: false, error: createErrorResult('FILE_NOT_FOUND') };
  }

  // 3. Return resolved absolute path
  return { success: true, resolvedSource: fullPath };
}

/**
 * Move a file or directory to a different directory.
 *
 * Performs a 12-step validation and move sequence:
 * 1. Source path validation (via validateFileOperation)
 * 2. [SEC-005] Protected directory check (source)
 * 3. Destination path safety check
 * 4. Destination existence and type (must be directory)
 * 5. Protected directory check (destination)
 * 6. [SEC-006] Symlink validation (prevents escape via symlinks)
 * 7. Final destination path calculation
 * 8. MOVE_SAME_PATH check (resolves symlinks for accuracy)
 * 9. [SEC-007] MOVE_INTO_SELF check (with path separator to avoid false positives)
 * 10. [SEC-008] Final destination path isPathSafe() validation
 * 11. Protected directory check (final destination)
 * 12. [SEC-009] Pre-check existence + TOCTOU defense in catch
 *
 * @param worktreeRoot - Root directory of the worktree (absolute path)
 * @param sourcePath - Relative path of the file/directory to move
 * @param destinationDir - Relative path of the destination directory (empty string for root)
 * @returns FileOperationResult with the new relative path on success
 */
export async function moveFileOrDirectory(
  worktreeRoot: string,
  sourcePath: string,
  destinationDir: string
): Promise<FileOperationResult> {
  // 1. Validate source using common helper [MF-001]
  const sourceValidation = validateFileOperation(worktreeRoot, sourcePath);
  if (!sourceValidation.success) {
    return sourceValidation.error;
  }
  const resolvedSource = sourceValidation.resolvedSource;

  // 2. [SEC-005] Source path protected directory check
  if (isProtectedDirectory(sourcePath)) {
    return createErrorResult('PROTECTED_DIRECTORY');
  }

  // 3. Validate destination path safety
  // Allow empty string for root directory
  if (destinationDir !== '' && !isPathSafe(destinationDir, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  // 4. Validate destination directory exists and is a directory
  const destFullPath = destinationDir ? join(worktreeRoot, destinationDir) : worktreeRoot;
  if (!existsSync(destFullPath)) {
    return createErrorResult('INVALID_PATH');
  }

  try {
    const destStat = statSync(destFullPath);
    if (!destStat.isDirectory()) {
      return createErrorResult('INVALID_PATH');
    }
  } catch {
    return createErrorResult('INVALID_PATH');
  }

  // 5. Protected directory check for destination [SF-S2-005]
  if (destinationDir && isProtectedDirectory(destinationDir)) {
    return createErrorResult('PROTECTED_DIRECTORY');
  }

  // 6. [SEC-006] Symlink validation for destination directory
  try {
    const resolvedDest = realpathSync(destFullPath);
    const resolvedRoot = realpathSync(worktreeRoot);
    if (!resolvedDest.startsWith(resolvedRoot + sep) && resolvedDest !== resolvedRoot) {
      return createErrorResult('INVALID_PATH');
    }
  } catch {
    return createErrorResult('INVALID_PATH');
  }

  // 7. Calculate final destination path
  const sourceBaseName = basename(sourcePath);
  const newRelativePath = destinationDir
    ? join(destinationDir, sourceBaseName)
    : sourceBaseName;

  // 8. MOVE_SAME_PATH check
  // Use realpathSync to resolve any symlinks in tmp directories (e.g., macOS /var -> /private/var)
  let resolvedSourceReal: string;
  try {
    resolvedSourceReal = realpathSync(resolvedSource);
  } catch {
    resolvedSourceReal = resolve(resolvedSource);
  }
  const resolvedNewFull = resolve(realpathSync(worktreeRoot), newRelativePath);
  if (resolvedNewFull === resolvedSourceReal) {
    return createErrorResult('MOVE_SAME_PATH');
  }

  // 9. [SEC-007] MOVE_INTO_SELF check with path separator
  if (resolvedNewFull.startsWith(resolvedSourceReal + sep)) {
    return createErrorResult('MOVE_INTO_SELF');
  }

  // 10. [SEC-008] Final destination path isPathSafe() validation
  if (!isPathSafe(newRelativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  // 11. Protected directory check for final destination path [SF-S2-005]
  if (isProtectedDirectory(newRelativePath)) {
    return createErrorResult('PROTECTED_DIRECTORY');
  }

  // 12. [SEC-009] Pre-check: destination file/directory existence (UX)
  const newFullPath = join(worktreeRoot, newRelativePath);
  if (existsSync(newFullPath)) {
    return createErrorResult('FILE_EXISTS');
  }

  try {
    await rename(resolvedSource, newFullPath);

    return {
      success: true,
      path: newRelativePath,
    };
  } catch (error) {
    // [SEC-009] TOCTOU defense: mapFsError handles EEXIST and ENOTEMPTY -> FILE_EXISTS
    return mapFsError(error);
  }
}

/**
 * Rename a file or directory
 * [SEC-SF-003] New name validation
 * [MF-001] Uses validateFileOperation() for common validation
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path of the file/directory to rename
 * @param newName - New name (not path)
 * @returns Success or error
 */
export async function renameFileOrDirectory(
  worktreeRoot: string,
  relativePath: string,
  newName: string
): Promise<FileOperationResult> {
  // [MF-001] Use common validation helper for source path
  const sourceValidation = validateFileOperation(worktreeRoot, relativePath);
  if (!sourceValidation.success) {
    return sourceValidation.error;
  }

  // Validate new name
  const nameValidation = isValidNewName(newName);
  if (!nameValidation.valid) {
    return createErrorResult('INVALID_NAME', nameValidation.error);
  }

  const fullPath = sourceValidation.resolvedSource;

  // Calculate new path
  const parentDir = dirname(relativePath);
  const newRelativePath = parentDir === '.' ? newName : join(parentDir, newName);
  const newFullPath = join(worktreeRoot, newRelativePath);

  // Validate new path is still within worktree
  if (!isPathSafe(newRelativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  // Check if target already exists
  if (existsSync(newFullPath)) {
    return createErrorResult('FILE_EXISTS');
  }

  try {
    await rename(fullPath, newFullPath);

    return {
      success: true,
      path: newRelativePath,
    };
  } catch (error) {
    return mapFsError(error);
  }
}

/**
 * Write binary file to the filesystem
 * [SOLID-001] Follows the same pattern as createFileOrDirectory()
 * [DRY-002] Includes path validation as defense-in-depth
 *
 * @param worktreeRoot - Root directory of the worktree
 * @param relativePath - Relative path for the new file
 * @param buffer - Binary content to write
 * @returns Success or error with size information
 */
export async function writeBinaryFile(
  worktreeRoot: string,
  relativePath: string,
  buffer: Buffer
): Promise<FileOperationResult> {
  // Validate path (defense-in-depth)
  if (!isPathSafe(relativePath, worktreeRoot)) {
    return createErrorResult('INVALID_PATH');
  }

  const fullPath = join(worktreeRoot, relativePath);

  // Check if file already exists
  if (existsSync(fullPath)) {
    return createErrorResult('FILE_EXISTS');
  }

  try {
    // Ensure parent directory exists
    const parentDir = dirname(fullPath);
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }

    // Write binary file
    await writeFile(fullPath, buffer);

    return {
      success: true,
      path: relativePath,
      size: buffer.length,
    };
  } catch (error) {
    return mapFsError(error);
  }
}
