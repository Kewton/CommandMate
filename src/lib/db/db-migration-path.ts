/**
 * DB Migration Path
 * Issue #135: DB path resolution logic fix
 *
 * Handles migration of database files from legacy locations to new paths.
 * Implements security measures for path validation and symlink resolution.
 *
 * @module db-migration-path
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { isSystemDirectory } from '@/config/system-directories';
import { createLogger } from '@/lib/logger';

const logger = createLogger('db-migration-path');

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
      logger.warn(
        `[Security] ${description} points to system directory, skipping: ${resolvedPath}`
      );
      return null;
    }

    return resolvedPath;
  } catch {
    // Failed to resolve path (broken symlink, etc.)
    logger.warn(`[Security] Failed to resolve ${description}: ${filePath}`);
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
        logger.warn(
          `[Security] Skipping DATABASE_PATH in system directory: ${resolvedPath}`
        );
      }
    } catch {
      logger.warn(`[Security] Invalid DATABASE_PATH: ${envDbPath}`);
    }
  }

  return paths;
}

/**
 * Whether committed updates of `dbPath` may still live only in its `-wal` file.
 *
 * An empty or absent `-wal` means the main file is the whole database.
 */
function hasPendingWal(dbPath: string): boolean {
  try {
    return fs.statSync(`${dbPath}-wal`).size > 0;
  } catch {
    return false;
  }
}

/**
 * Write a self-contained copy of the database at `sourcePath` to `destPath`
 * (Issue #3993).
 *
 * Same tool as the pre-migration backup (`migrations/pre-migration-backup.ts`,
 * Issue #3985): `VACUUM INTO` reads inside one read transaction, so updates
 * still in `-wal` are included, and the result is a rollback-journal file that
 * needs no sidecar. Copying the main file alone dropped them. The source is
 * opened read-only; the copy is written to a temporary name and renamed into
 * place, because `VACUUM INTO` refuses a non-empty destination.
 */
function snapshotDatabase(sourcePath: string, destPath: string): void {
  const tempPath = `${destPath}.${crypto.randomBytes(4).toString('hex')}.partial`;
  try {
    // VACUUM INTO accepts an empty existing file; creating it first fixes the mode.
    fs.closeSync(fs.openSync(tempPath, 'wx', 0o600));
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      source.prepare('VACUUM INTO ?').run(tempPath);
    } finally {
      source.close();
    }
    fs.renameSync(tempPath, destPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Copy a legacy database: a consistent snapshot when it has a non-empty `-wal`,
 * the file itself otherwise (unchanged from before Issue #3993).
 */
function copyLegacyDatabase(sourcePath: string, destPath: string): void {
  if (hasPendingWal(sourcePath)) {
    snapshotDatabase(sourcePath, destPath);
  } else {
    fs.copyFileSync(sourcePath, destPath);
  }
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
 * A legacy database with a non-empty `-wal` is copied as a `VACUUM INTO`
 * snapshot (both the backup and the new location), so updates not yet written
 * back to the main file are kept (Issue #3993).
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
    copyLegacyDatabase(resolvedLegacyPath, backupPath);
    fs.chmodSync(backupPath, 0o600);

    // Create target directory if needed (SEC-003)
    const targetDir = path.dirname(resolvedTargetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    // Copy database to new location
    copyLegacyDatabase(resolvedLegacyPath, resolvedTargetPath);

    logger.info(
      `[Migration] Database migrated from ${resolvedLegacyPath} to ${resolvedTargetPath}`
    );
    logger.info(`[Migration] Backup created at ${backupPath}`);

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
