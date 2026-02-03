/**
 * DB Migration Path
 * Issue #135: DB path resolution logic fix
 *
 * Handles migration of database files from legacy locations to new paths.
 * Implements security measures for path validation and symlink resolution.
 *
 * @module db-migration-path
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { isSystemDirectory } from '../config/system-directories';

/**
 * Migration result interface
 */
export interface MigrationResult {
  /** Whether migration was performed */
  migrated: boolean;
  /** Source path of legacy DB (if migrated) */
  sourcePath?: string;
  /** Target path for the DB */
  targetPath: string;
  /** Backup path (if migration was performed) */
  backupPath?: string;
}

/**
 * Resolve and validate a path for security
 *
 * SEC-002: Uses realpathSync to resolve symlinks and prevent TOCTOU attacks
 *
 * @param filePath - The file path to resolve and validate
 * @param description - Description of the path for logging
 * @returns The resolved path if valid and exists, null otherwise
 */
export function resolveAndValidatePath(
  filePath: string,
  description: string
): string | null {
  try {
    // Check if file exists first
    if (!fs.existsSync(filePath)) {
      return null;
    }

    // SEC-002: Resolve symlinks using realpathSync
    const resolvedPath = fs.realpathSync(filePath);

    // Check if path is in a system directory
    if (isSystemDirectory(resolvedPath)) {
      console.warn(
        `[Security] ${description} points to system directory, skipping: ${resolvedPath}`
      );
      return null;
    }

    return resolvedPath;
  } catch {
    // Failed to resolve path (broken symlink, etc.)
    console.warn(`[Security] Failed to resolve ${description}: ${filePath}`);
    return null;
  }
}

/**
 * Get list of legacy database paths to check for migration
 *
 * SEC-005: DATABASE_PATH is validated before being added to the list
 *
 * @returns Array of paths to check for legacy databases
 */
export function getLegacyDbPaths(): string[] {
  const paths: string[] = [];

  // CWD relative paths (old defaults)
  paths.push(path.join(process.cwd(), 'data', 'db.sqlite'));
  paths.push(path.join(process.cwd(), 'data', 'cm.db'));

  // Home directory path (old global install location)
  paths.push(path.join(homedir(), '.commandmate', 'data', 'db.sqlite'));

  // SEC-005: Validate DATABASE_PATH before adding
  const envDbPath = process.env.DATABASE_PATH;
  if (envDbPath) {
    try {
      const resolvedPath = path.resolve(envDbPath);
      if (!isSystemDirectory(resolvedPath)) {
        paths.push(envDbPath);
      } else {
        console.warn(
          `[Security] Skipping DATABASE_PATH in system directory: ${resolvedPath}`
        );
      }
    } catch {
      console.warn(`[Security] Invalid DATABASE_PATH: ${envDbPath}`);
    }
  }

  return paths;
}

/**
 * Migrate database to new path if legacy DB exists
 *
 * This function:
 * 1. Checks if target already has a database
 * 2. Searches for legacy database locations
 * 3. Creates a backup of the legacy database
 * 4. Copies the database to the new location
 *
 * Security features:
 * - SEC-002: Symlink resolution via realpathSync
 * - SEC-003: Directory creation with mode 0o700
 * - SEC-005: DATABASE_PATH validation
 * - SEC-006: Backup file permissions set to 0o600
 *
 * @param targetPath - The target database path
 * @returns MigrationResult with details of the migration
 * @throws Error if target path is in a system directory
 */
export function migrateDbIfNeeded(targetPath: string): MigrationResult {
  // Validate target path - reject system directories
  const resolvedTargetPath = path.resolve(targetPath);
  if (isSystemDirectory(resolvedTargetPath)) {
    throw new Error(
      `Security error: Target path cannot be in system directory: ${resolvedTargetPath}`
    );
  }

  // Check if target already exists
  if (fs.existsSync(targetPath)) {
    const existingResolved = resolveAndValidatePath(targetPath, 'target path');
    if (existingResolved) {
      return { migrated: false, targetPath: existingResolved };
    }
  }

  // Search for legacy databases
  const legacyPaths = getLegacyDbPaths();
  for (const legacyPath of legacyPaths) {
    // SEC-002: Validate each legacy path
    const resolvedLegacyPath = resolveAndValidatePath(legacyPath, 'legacy path');
    if (!resolvedLegacyPath) {
      continue;
    }

    // Create backup (SEC-006)
    const backupPath = `${resolvedLegacyPath}.bak`;
    fs.copyFileSync(resolvedLegacyPath, backupPath);
    fs.chmodSync(backupPath, 0o600);

    // Create target directory if needed (SEC-003)
    const targetDir = path.dirname(resolvedTargetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    // Copy database to new location
    fs.copyFileSync(resolvedLegacyPath, resolvedTargetPath);

    console.log(
      `[Migration] Database migrated from ${resolvedLegacyPath} to ${resolvedTargetPath}`
    );
    console.log(`[Migration] Backup created at ${backupPath}`);

    return {
      migrated: true,
      sourcePath: resolvedLegacyPath,
      targetPath: resolvedTargetPath,
      backupPath,
    };
  }

  // No legacy database found
  return { migrated: false, targetPath: resolvedTargetPath };
}
