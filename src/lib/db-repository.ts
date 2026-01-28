/**
 * Repository and Clone Job Database Operations
 * Issue #71: Clone URL registration feature
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { CloneJobStatus } from '@/types/clone';

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
