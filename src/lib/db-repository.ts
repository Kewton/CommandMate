/**
 * Repository and Clone Job Database Operations
 * Issue #71: Clone URL registration feature
 * Issue #190: Repository exclusion on sync
 */

import { randomUUID } from 'crypto';
import path from 'path';
import Database from 'better-sqlite3';
import type { CloneJobStatus } from '@/types/clone';
import { isSystemDirectory } from '@/config/system-directories';

/**
 * Repository model
 */
export interface Repository {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  cloneUrl?: string;
  normalizedCloneUrl?: string;
  cloneSource: 'local' | 'https' | 'ssh';
  isEnvManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Clone job model (DB representation)
 */
export interface CloneJobDB {
  id: string;
  cloneUrl: string;
  normalizedCloneUrl: string;
  targetPath: string;
  repositoryId?: string;
  status: CloneJobStatus;
  pid?: number;
  progress: number;
  errorCategory?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

/**
 * Repository row from database
 */
interface RepositoryRow {
  id: string;
  name: string;
  path: string;
  enabled: number;
  clone_url: string | null;
  normalized_clone_url: string | null;
  clone_source: string;
  is_env_managed: number;
  created_at: number;
  updated_at: number;
}

/**
 * Clone job row from database
 */
interface CloneJobRow {
  id: string;
  clone_url: string;
  normalized_clone_url: string;
  target_path: string;
  repository_id: string | null;
  status: string;
  pid: number | null;
  progress: number;
  error_category: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

/**
 * Map repository row to Repository model
 */
function mapRepositoryRow(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    enabled: row.enabled === 1,
    cloneUrl: row.clone_url || undefined,
    normalizedCloneUrl: row.normalized_clone_url || undefined,
    cloneSource: row.clone_source as 'local' | 'https' | 'ssh',
    isEnvManaged: row.is_env_managed === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Map clone job row to CloneJobDB model
 */
function mapCloneJobRow(row: CloneJobRow): CloneJobDB {
  return {
    id: row.id,
    cloneUrl: row.clone_url,
    normalizedCloneUrl: row.normalized_clone_url,
    targetPath: row.target_path,
    repositoryId: row.repository_id || undefined,
    status: row.status as CloneJobStatus,
    pid: row.pid || undefined,
    progress: row.progress,
    errorCategory: row.error_category || undefined,
    errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
  };
}

// ============================================================
// Repository Operations
// ============================================================

/**
 * Create a new repository
 */
export function createRepository(
  db: Database.Database,
  data: {
    name: string;
    path: string;
    cloneUrl?: string;
    normalizedCloneUrl?: string;
    cloneSource: 'local' | 'https' | 'ssh';
    isEnvManaged?: boolean;
    enabled?: boolean;
  }
): Repository {
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO repositories (
      id, name, path, enabled, clone_url, normalized_clone_url,
      clone_source, is_env_managed, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    data.name,
    data.path,
    data.enabled !== false ? 1 : 0,
    data.cloneUrl || null,
    data.normalizedCloneUrl || null,
    data.cloneSource,
    data.isEnvManaged ? 1 : 0,
    now,
    now
  );

  return {
    id,
    name: data.name,
    path: data.path,
    enabled: data.enabled !== false,
    cloneUrl: data.cloneUrl,
    normalizedCloneUrl: data.normalizedCloneUrl,
    cloneSource: data.cloneSource,
    isEnvManaged: data.isEnvManaged || false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Get repository by normalized clone URL
 */
export function getRepositoryByNormalizedUrl(
  db: Database.Database,
  normalizedCloneUrl: string
): Repository | null {
  const stmt = db.prepare(`
    SELECT * FROM repositories
    WHERE normalized_clone_url = ?
  `);

  const row = stmt.get(normalizedCloneUrl) as RepositoryRow | undefined;
  return row ? mapRepositoryRow(row) : null;
}

/**
 * Get repository by ID
 */
export function getRepositoryById(
  db: Database.Database,
  id: string
): Repository | null {
  const stmt = db.prepare(`
    SELECT * FROM repositories
    WHERE id = ?
  `);

  const row = stmt.get(id) as RepositoryRow | undefined;
  return row ? mapRepositoryRow(row) : null;
}

/**
 * Get repository by path
 */
export function getRepositoryByPath(
  db: Database.Database,
  path: string
): Repository | null {
  const stmt = db.prepare(`
    SELECT * FROM repositories
    WHERE path = ?
  `);

  const row = stmt.get(path) as RepositoryRow | undefined;
  return row ? mapRepositoryRow(row) : null;
}

/**
 * Update repository
 */
export function updateRepository(
  db: Database.Database,
  id: string,
  updates: {
    name?: string;
    enabled?: boolean;
    cloneUrl?: string;
    normalizedCloneUrl?: string;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (updates.name !== undefined) {
    assignments.push('name = ?');
    params.push(updates.name);
  }

  if (updates.enabled !== undefined) {
    assignments.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }

  if (updates.cloneUrl !== undefined) {
    assignments.push('clone_url = ?');
    params.push(updates.cloneUrl || null);
  }

  if (updates.normalizedCloneUrl !== undefined) {
    assignments.push('normalized_clone_url = ?');
    params.push(updates.normalizedCloneUrl || null);
  }

  params.push(id);

  const stmt = db.prepare(`
    UPDATE repositories
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Get all repositories
 */
export function getAllRepositories(
  db: Database.Database
): Repository[] {
  const stmt = db.prepare(`
    SELECT * FROM repositories
    ORDER BY name ASC
  `);

  const rows = stmt.all() as RepositoryRow[];
  return rows.map(mapRepositoryRow);
}

// ============================================================
// Repository Exclusion Operations (Issue #190)
// ============================================================

/**
 * Maximum number of disabled repositories allowed.
 * Prevents unlimited record accumulation from malicious or buggy DELETE requests.
 * SEC-SF-004
 */
export const MAX_DISABLED_REPOSITORIES = 1000;

/**
 * Resolve and normalize a repository path.
 * All path normalization is centralized here to prevent inconsistencies.
 *
 * NOTE: path.resolve() removes trailing slashes and resolves relative paths
 * but does NOT resolve symlinks. For symlink resolution, use fs.realpathSync().
 * See design policy Section 7 for the symlink handling policy.
 *
 * SF-001: DRY - centralized path normalization
 */
export function resolveRepositoryPath(repoPath: string): string {
  return path.resolve(repoPath);
}

/**
 * Validation result for repository path.
 * If error is set, the path is invalid and the error message should be returned to the client.
 */
export interface RepositoryPathValidationResult {
  valid: boolean;
  error?: string;
  resolvedPath?: string;
}

/**
 * Validate and resolve a repository path for API requests.
 * Centralizes all validation checks to avoid duplication across route handlers.
 *
 * Checks performed:
 * 1. Presence and type check (must be non-empty string)
 * 2. Null byte check (path traversal prevention, SEC-MF-001)
 * 3. System directory check (prevents operations on /etc, /usr, etc.)
 *
 * DRY: Used by DELETE /api/repositories and PUT /api/repositories/restore
 */
export function validateRepositoryPath(repositoryPath: unknown): RepositoryPathValidationResult {
  if (!repositoryPath || typeof repositoryPath !== 'string') {
    return { valid: false, error: 'repositoryPath is required' };
  }

  if (repositoryPath.includes('\0')) {
    return { valid: false, error: 'Invalid repository path' };
  }

  const resolvedPath = resolveRepositoryPath(repositoryPath);

  if (isSystemDirectory(resolvedPath)) {
    return { valid: false, error: 'Invalid repository path' };
  }

  return { valid: true, resolvedPath };
}

/**
 * Register environment variable repositories to the repositories table.
 * Idempotent: already registered repositories are skipped (regardless of enabled status).
 *
 * NOTE (MF-C01): createRepository() treats enabled as follows:
 *   - true  -> SQLite 1 (enabled)
 *   - false -> SQLite 0 (disabled)
 *   - undefined -> SQLite 1 (enabled, due to `data.enabled !== false ? 1 : 0` logic)
 * We explicitly pass enabled: true to avoid relying on the implicit default.
 *
 * MF-001: SRP - registration logic separated from sync route
 */
export function ensureEnvRepositoriesRegistered(
  db: Database.Database,
  repositoryPaths: string[]
): void {
  for (const repoPath of repositoryPaths) {
    const resolvedPath = resolveRepositoryPath(repoPath);
    const existing = getRepositoryByPath(db, resolvedPath);
    if (!existing) {
      createRepository(db, {
        name: path.basename(resolvedPath),
        path: resolvedPath,
        cloneSource: 'local',
        isEnvManaged: true,
        enabled: true,  // Explicit: do not rely on undefined -> 1 default
      });
    }
  }
}

/**
 * Filter out excluded repository paths.
 * Exclusion logic is encapsulated here, so changes to exclusion criteria
 * (e.g., pattern-based exclusion, temporary exclusion) only affect this function.
 *
 * NOTE (SEC-SF-002): Array.includes() performs case-sensitive string comparison.
 * On macOS (case-insensitive filesystem), paths with different casing would not match.
 * resolveRepositoryPath() normalization on both sides mitigates most cases.
 * On Linux (case-sensitive filesystem), the behavior is consistent.
 *
 * SF-003: OCP - exclusion logic encapsulated
 */
export function filterExcludedPaths(
  db: Database.Database,
  repositoryPaths: string[]
): string[] {
  const excludedPaths = getExcludedRepositoryPaths(db);
  return repositoryPaths.filter(p =>
    !excludedPaths.includes(resolveRepositoryPath(p))
  );
}

/**
 * Disable a repository by setting enabled=0.
 * If the repository is not registered, create it with enabled=0.
 * All internal logic (lookup + update/create) is encapsulated.
 *
 * NOTE (MF-C01): Explicitly passes enabled: false to createRepository().
 * The internal mapping `data.enabled !== false ? 1 : 0` will correctly
 * store 0 in SQLite. Do NOT pass undefined for enabled.
 *
 * NOTE (SEC-SF-004): When creating a new record, checks the count of
 * disabled repositories against MAX_DISABLED_REPOSITORIES to prevent
 * unlimited record accumulation from malicious or buggy DELETE requests.
 *
 * SF-002: SRP - disable logic encapsulated
 */
export function disableRepository(db: Database.Database, repositoryPath: string): void {
  const resolvedPath = resolveRepositoryPath(repositoryPath);
  const repo = getRepositoryByPath(db, resolvedPath);
  if (repo) {
    updateRepository(db, repo.id, { enabled: false });
  } else {
    // SEC-SF-004: Check disabled repository count limit before creating new record
    const disabledCount = db.prepare(
      'SELECT COUNT(*) as count FROM repositories WHERE enabled = 0'
    ).get() as { count: number };
    if (disabledCount.count >= MAX_DISABLED_REPOSITORIES) {
      throw new Error('Disabled repository limit exceeded');
    }
    createRepository(db, {
      name: path.basename(resolvedPath),
      path: resolvedPath,
      cloneSource: 'local',
      isEnvManaged: false,
      enabled: false,  // Explicit: do not rely on undefined -> 1 default
    });
  }
}

/**
 * Get paths of excluded (enabled=0) repositories
 */
export function getExcludedRepositoryPaths(db: Database.Database): string[] {
  const stmt = db.prepare('SELECT path FROM repositories WHERE enabled = 0');
  const rows = stmt.all() as { path: string }[];
  return rows.map(r => r.path);
}

/**
 * Get excluded repositories with full details
 */
export function getExcludedRepositories(db: Database.Database): Repository[] {
  const stmt = db.prepare('SELECT * FROM repositories WHERE enabled = 0 ORDER BY name ASC');
  const rows = stmt.all() as RepositoryRow[];
  return rows.map(mapRepositoryRow);
}

/**
 * Restore an excluded repository by setting enabled=1
 *
 * @returns Restored Repository object, or null if not found
 */
export function restoreRepository(db: Database.Database, repoPath: string): Repository | null {
  const resolvedPath = resolveRepositoryPath(repoPath);
  const repo = getRepositoryByPath(db, resolvedPath);
  if (!repo) return null;
  updateRepository(db, repo.id, { enabled: true });
  return { ...repo, enabled: true };
}

// ============================================================
// Clone Job Operations
// ============================================================

/**
 * Create a new clone job
 */
export function createCloneJob(
  db: Database.Database,
  data: {
    cloneUrl: string;
    normalizedCloneUrl: string;
    targetPath: string;
  }
): CloneJobDB {
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO clone_jobs (
      id, clone_url, normalized_clone_url, target_path,
      status, progress, created_at
    )
    VALUES (?, ?, ?, ?, 'pending', 0, ?)
  `);

  stmt.run(id, data.cloneUrl, data.normalizedCloneUrl, data.targetPath, now);

  return {
    id,
    cloneUrl: data.cloneUrl,
    normalizedCloneUrl: data.normalizedCloneUrl,
    targetPath: data.targetPath,
    status: 'pending',
    progress: 0,
    createdAt: new Date(now),
  };
}

/**
 * Get clone job by ID
 */
export function getCloneJob(
  db: Database.Database,
  id: string
): CloneJobDB | null {
  const stmt = db.prepare(`
    SELECT * FROM clone_jobs
    WHERE id = ?
  `);

  const row = stmt.get(id) as CloneJobRow | undefined;
  return row ? mapCloneJobRow(row) : null;
}

/**
 * Update clone job
 */
export function updateCloneJob(
  db: Database.Database,
  id: string,
  updates: {
    status?: CloneJobStatus;
    pid?: number;
    progress?: number;
    repositoryId?: string;
    errorCategory?: string;
    errorCode?: string;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
  }
): void {
  const assignments: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    assignments.push('status = ?');
    params.push(updates.status);
  }

  if (updates.pid !== undefined) {
    assignments.push('pid = ?');
    params.push(updates.pid);
  }

  if (updates.progress !== undefined) {
    assignments.push('progress = ?');
    params.push(updates.progress);
  }

  if (updates.repositoryId !== undefined) {
    assignments.push('repository_id = ?');
    params.push(updates.repositoryId);
  }

  if (updates.errorCategory !== undefined) {
    assignments.push('error_category = ?');
    params.push(updates.errorCategory);
  }

  if (updates.errorCode !== undefined) {
    assignments.push('error_code = ?');
    params.push(updates.errorCode);
  }

  if (updates.errorMessage !== undefined) {
    assignments.push('error_message = ?');
    params.push(updates.errorMessage);
  }

  if (updates.startedAt !== undefined) {
    assignments.push('started_at = ?');
    params.push(updates.startedAt.getTime());
  }

  if (updates.completedAt !== undefined) {
    assignments.push('completed_at = ?');
    params.push(updates.completedAt.getTime());
  }

  if (assignments.length === 0) {
    return;
  }

  params.push(id);

  const stmt = db.prepare(`
    UPDATE clone_jobs
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Get active clone job by normalized URL
 * Active jobs are those with status 'pending' or 'running'
 */
export function getActiveCloneJobByUrl(
  db: Database.Database,
  normalizedCloneUrl: string
): CloneJobDB | null {
  const stmt = db.prepare(`
    SELECT * FROM clone_jobs
    WHERE normalized_clone_url = ?
      AND status IN ('pending', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const row = stmt.get(normalizedCloneUrl) as CloneJobRow | undefined;
  return row ? mapCloneJobRow(row) : null;
}

/**
 * Get clone jobs by status
 */
export function getCloneJobsByStatus(
  db: Database.Database,
  status: CloneJobStatus
): CloneJobDB[] {
  const stmt = db.prepare(`
    SELECT * FROM clone_jobs
    WHERE status = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(status) as CloneJobRow[];
  return rows.map(mapCloneJobRow);
}
