/**
 * Database operations for external apps
 * Issue #42: Proxy routing for multiple frontend applications
 * Issue #136: Added worktree external app support (issue_no)
 *
 * Provides CRUD operations for external app configuration stored in SQLite.
 * All operations are synchronous as better-sqlite3 is synchronous.
 *
 * @module lib/external-apps/db
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type {
  ExternalApp,
  ExternalAppType,
  CreateExternalAppInput,
  UpdateExternalAppInput,
  WorktreeExternalApp,
  CreateWorktreeExternalAppInput,
} from '@/types/external-apps';

/**
 * Database error types for external apps operations
 */
export class ExternalAppDbError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'DUPLICATE' | 'DB_ERROR',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ExternalAppDbError';
  }
}

/**
 * Database row type for external_apps table
 * Issue #136: Added issue_no column
 */
export interface DbExternalAppRow {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  path_prefix: string;
  target_port: number;
  target_host: string;
  app_type: string;
  websocket_enabled: number;
  websocket_path_pattern: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  issue_no: number | null;
}

/**
 * Database insert format for external_apps table
 */
export interface DbExternalAppInsert {
  name: string;
  display_name: string;
  description: string | null;
  path_prefix: string;
  target_port: number;
  target_host: string;
  app_type: string;
  websocket_enabled: number;
  websocket_path_pattern: string | null;
}

/**
 * Convert DB row to ExternalApp object
 */
export function mapDbRowToExternalApp(row: DbExternalAppRow): ExternalApp {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description ?? undefined,
    pathPrefix: row.path_prefix,
    targetPort: row.target_port,
    targetHost: row.target_host,
    appType: row.app_type as ExternalAppType,
    websocketEnabled: row.websocket_enabled === 1,
    websocketPathPattern: row.websocket_path_pattern ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert CreateExternalAppInput to DB insert format
 */
export function mapExternalAppToDbRow(input: CreateExternalAppInput): DbExternalAppInsert {
  return {
    name: input.name,
    display_name: input.displayName,
    description: input.description ?? null,
    path_prefix: input.pathPrefix,
    target_port: input.targetPort,
    target_host: input.targetHost ?? 'localhost',
    app_type: input.appType,
    websocket_enabled: input.websocketEnabled ? 1 : 0,
    websocket_path_pattern: input.websocketPathPattern ?? null,
  };
}

/**
 * Create a new external app
 *
 * @param db - Database instance
 * @param input - Create input data
 * @returns The created ExternalApp
 * @throws ExternalAppDbError if name or pathPrefix already exists
 */
export function createExternalApp(
  db: Database.Database,
  input: CreateExternalAppInput
): ExternalApp {
  const id = randomUUID();
  const now = Date.now();
  const dbRow = mapExternalAppToDbRow(input);

  try {
    const stmt = db.prepare(`
      INSERT INTO external_apps (
        id, name, display_name, description, path_prefix,
        target_port, target_host, app_type,
        websocket_enabled, websocket_path_pattern,
        enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    stmt.run(
      id,
      dbRow.name,
      dbRow.display_name,
      dbRow.description,
      dbRow.path_prefix,
      dbRow.target_port,
      dbRow.target_host,
      dbRow.app_type,
      dbRow.websocket_enabled,
      dbRow.websocket_path_pattern,
      now,
      now
    );

    return {
      id,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      pathPrefix: input.pathPrefix,
      targetPort: input.targetPort,
      targetHost: input.targetHost ?? 'localhost',
      appType: input.appType,
      websocketEnabled: input.websocketEnabled ?? false,
      websocketPathPattern: input.websocketPathPattern,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    // Handle unique constraint violations
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      throw new ExternalAppDbError(
        `External app with name "${input.name}" or pathPrefix "${input.pathPrefix}" already exists`,
        'DUPLICATE',
        error
      );
    }
    // Re-throw other errors with context
    throw new ExternalAppDbError(
      `Failed to create external app: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get external app by ID
 *
 * @param db - Database instance
 * @param id - App UUID
 * @returns The ExternalApp if found, null otherwise
 */
export function getExternalAppById(
  db: Database.Database,
  id: string
): ExternalApp | null {
  try {
    const stmt = db.prepare(`
      SELECT id, name, display_name, description, path_prefix,
             target_port, target_host, app_type,
             websocket_enabled, websocket_path_pattern,
             enabled, created_at, updated_at
      FROM external_apps
      WHERE id = ?
    `);

    const row = stmt.get(id) as DbExternalAppRow | undefined;

    if (!row) {
      return null;
    }

    return mapDbRowToExternalApp(row);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to get external app by ID: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get external app by path prefix
 *
 * @param db - Database instance
 * @param pathPrefix - URL path prefix for the app
 * @returns The ExternalApp if found, null otherwise
 */
export function getExternalAppByPathPrefix(
  db: Database.Database,
  pathPrefix: string
): ExternalApp | null {
  try {
    const stmt = db.prepare(`
      SELECT id, name, display_name, description, path_prefix,
             target_port, target_host, app_type,
             websocket_enabled, websocket_path_pattern,
             enabled, created_at, updated_at
      FROM external_apps
      WHERE path_prefix = ?
    `);

    const row = stmt.get(pathPrefix) as DbExternalAppRow | undefined;

    if (!row) {
      return null;
    }

    return mapDbRowToExternalApp(row);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to get external app by path prefix: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get all external apps (including disabled)
 *
 * @param db - Database instance
 * @returns Array of all ExternalApps, sorted by name
 */
export function getAllExternalApps(db: Database.Database): ExternalApp[] {
  try {
    const stmt = db.prepare(`
      SELECT id, name, display_name, description, path_prefix,
             target_port, target_host, app_type,
             websocket_enabled, websocket_path_pattern,
             enabled, created_at, updated_at
      FROM external_apps
      ORDER BY name ASC
    `);

    const rows = stmt.all() as DbExternalAppRow[];

    return rows.map(mapDbRowToExternalApp);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to get all external apps: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}


/**
 * Update an existing external app
 *
 * @param db - Database instance
 * @param id - App UUID
 * @param input - Update input data (only provided fields will be updated)
 * @returns The updated ExternalApp
 * @throws ExternalAppDbError if app not found
 */
export function updateExternalApp(
  db: Database.Database,
  id: string,
  input: UpdateExternalAppInput
): ExternalApp {
  // First check if app exists
  const existing = getExternalAppById(db, id);
  if (!existing) {
    throw new ExternalAppDbError(
      `External app not found: ${id}`,
      'NOT_FOUND'
    );
  }

  try {
    const now = Date.now();
    const updates: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (input.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(input.displayName);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }

    if (input.targetPort !== undefined) {
      updates.push('target_port = ?');
      params.push(input.targetPort);
    }

    if (input.targetHost !== undefined) {
      updates.push('target_host = ?');
      params.push(input.targetHost);
    }

    if (input.websocketEnabled !== undefined) {
      updates.push('websocket_enabled = ?');
      params.push(input.websocketEnabled ? 1 : 0);
    }

    if (input.websocketPathPattern !== undefined) {
      updates.push('websocket_path_pattern = ?');
      params.push(input.websocketPathPattern);
    }

    if (input.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }

    params.push(id);

    const stmt = db.prepare(`
      UPDATE external_apps
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...params);

    // Return the updated app
    return getExternalAppById(db, id)!;
  } catch (error) {
    // Re-throw ExternalAppDbError as-is
    if (error instanceof ExternalAppDbError) {
      throw error;
    }
    throw new ExternalAppDbError(
      `Failed to update external app: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Delete an external app by ID
 *
 * @param db - Database instance
 * @param id - App UUID to delete
 */
export function deleteExternalApp(
  db: Database.Database,
  id: string
): void {
  try {
    const stmt = db.prepare(`
      DELETE FROM external_apps
      WHERE id = ?
    `);

    stmt.run(id);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to delete external app: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Options for filtering external apps by issue number
 * Issue #136: MF-IMP-002 - issue_no filter options
 */
export interface GetExternalAppsOptions {
  /**
   * Filter by issue number:
   * - undefined: Return all apps (no filter)
   * - null: Return only main apps (issue_no IS NULL)
   * - number: Return only apps for that specific issue
   */
  issueNo?: number | null;
}

/**
 * Get enabled external apps with optional issue filter
 * Issue #136: MF-IMP-002 - Added issue_no filter support
 *
 * @param db - Database instance
 * @param options - Filter options
 * @returns Array of enabled ExternalApps
 */
export function getEnabledExternalApps(
  db: Database.Database,
  options?: GetExternalAppsOptions
): ExternalApp[] {
  try {
    let sql = `
      SELECT id, name, display_name, description, path_prefix,
             target_port, target_host, app_type,
             websocket_enabled, websocket_path_pattern,
             enabled, created_at, updated_at, issue_no
      FROM external_apps
      WHERE enabled = 1
    `;

    const params: (number | null)[] = [];

    if (options?.issueNo === null) {
      // Main apps only (issue_no IS NULL)
      sql += ' AND issue_no IS NULL';
    } else if (options?.issueNo !== undefined) {
      // Specific issue
      sql += ' AND issue_no = ?';
      params.push(options.issueNo);
    }
    // If options?.issueNo is undefined, no filter is applied

    sql += ' ORDER BY name ASC';

    const stmt = db.prepare(sql);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as DbExternalAppRow[];

    return rows.map(mapDbRowToExternalApp);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to get enabled external apps: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Create a worktree external app
 * Issue #136: Creates external app with issue_no set
 *
 * @param db - Database instance
 * @param input - Create input data with issueNo
 * @returns The created WorktreeExternalApp
 */
export function createWorktreeExternalApp(
  db: Database.Database,
  input: CreateWorktreeExternalAppInput
): WorktreeExternalApp {
  const id = randomUUID();
  const now = Date.now();
  const dbRow = mapExternalAppToDbRow(input);

  try {
    const stmt = db.prepare(`
      INSERT INTO external_apps (
        id, name, display_name, description, path_prefix,
        target_port, target_host, app_type,
        websocket_enabled, websocket_path_pattern,
        enabled, created_at, updated_at, issue_no
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);

    stmt.run(
      id,
      dbRow.name,
      dbRow.display_name,
      dbRow.description,
      dbRow.path_prefix,
      dbRow.target_port,
      dbRow.target_host,
      dbRow.app_type,
      dbRow.websocket_enabled,
      dbRow.websocket_path_pattern,
      now,
      now,
      input.issueNo
    );

    return {
      id,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      pathPrefix: input.pathPrefix,
      targetPort: input.targetPort,
      targetHost: input.targetHost ?? 'localhost',
      appType: input.appType,
      websocketEnabled: input.websocketEnabled ?? false,
      websocketPathPattern: input.websocketPathPattern,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      issueNo: input.issueNo,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      throw new ExternalAppDbError(
        `External app with name "${input.name}" or pathPrefix "${input.pathPrefix}" already exists`,
        'DUPLICATE',
        error
      );
    }
    throw new ExternalAppDbError(
      `Failed to create worktree external app: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get external apps by issue number
 * Issue #136: Helper to get all apps for a specific worktree
 *
 * @param db - Database instance
 * @param issueNo - Issue number
 * @returns Array of ExternalApps for the issue
 */
export function getExternalAppsByIssueNo(
  db: Database.Database,
  issueNo: number
): ExternalApp[] {
  try {
    const stmt = db.prepare(`
      SELECT id, name, display_name, description, path_prefix,
             target_port, target_host, app_type,
             websocket_enabled, websocket_path_pattern,
             enabled, created_at, updated_at, issue_no
      FROM external_apps
      WHERE issue_no = ?
      ORDER BY name ASC
    `);

    const rows = stmt.all(issueNo) as DbExternalAppRow[];

    return rows.map(mapDbRowToExternalApp);
  } catch (error) {
    throw new ExternalAppDbError(
      `Failed to get external apps by issue: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DB_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get main external apps (non-worktree)
 * Issue #136: Helper to get apps without issue_no
 *
 * @param db - Database instance
 * @returns Array of main ExternalApps
 */
export function getMainExternalApps(db: Database.Database): ExternalApp[] {
  return getEnabledExternalApps(db, { issueNo: null });
}
