/**
 * Report template database operations
 * CRUD operations for report_templates table
 *
 * Issue #618: Report template system
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Report template model
 */
export interface ReportTemplate {
  id: string;
  name: string;
  content: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database row type for report templates
 */
type ReportTemplateRow = {
  id: string;
  name: string;
  content: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

/**
 * Map database row to ReportTemplate model
 */
function mapTemplateRow(row: ReportTemplateRow): ReportTemplate {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get all templates, sorted by created_at ASC
 */
export function getAllTemplates(
  db: Database.Database
): ReportTemplate[] {
  const stmt = db.prepare(`
    SELECT id, name, content, sort_order, created_at, updated_at
    FROM report_templates
    ORDER BY created_at ASC
  `);

  const rows = stmt.all() as ReportTemplateRow[];
  return rows.map(mapTemplateRow);
}

/**
 * Get a template by ID
 *
 * @param db - Database instance
 * @param id - Template ID
 * @returns Template or null if not found
 */
export function getTemplateById(
  db: Database.Database,
  id: string
): ReportTemplate | null {
  const stmt = db.prepare(`
    SELECT id, name, content, sort_order, created_at, updated_at
    FROM report_templates
    WHERE id = ?
  `);

  const row = stmt.get(id) as ReportTemplateRow | undefined;
  return row ? mapTemplateRow(row) : null;
}

/**
 * Create a new template
 *
 * @param db - Database instance
 * @param options - Template options (name, content)
 * @returns Created template
 */
export function createTemplate(
  db: Database.Database,
  options: {
    name: string;
    content: string;
  }
): ReportTemplate {
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO report_templates (id, name, content, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `);

  stmt.run(id, options.name, options.content, now, now);

  return {
    id,
    name: options.name,
    content: options.content,
    sortOrder: 0,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Update an existing template
 *
 * @param db - Database instance
 * @param id - Template ID
 * @param updates - Fields to update (name and/or content)
 */
export function updateTemplate(
  db: Database.Database,
  id: string,
  updates: {
    name?: string;
    content?: string;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now];

  if (updates.name !== undefined) {
    assignments.push('name = ?');
    params.push(updates.name);
  }

  if (updates.content !== undefined) {
    assignments.push('content = ?');
    params.push(updates.content);
  }

  params.push(id);

  const stmt = db.prepare(`
    UPDATE report_templates
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Delete a template by ID
 *
 * @param db - Database instance
 * @param id - Template ID
 */
export function deleteTemplate(
  db: Database.Database,
  id: string
): void {
  const stmt = db.prepare(`
    DELETE FROM report_templates
    WHERE id = ?
  `);

  stmt.run(id);
}

/**
 * Get the count of all templates
 *
 * @param db - Database instance
 * @returns Number of templates
 */
export function getTemplateCount(
  db: Database.Database
): number {
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM report_templates'
  ).get() as { count: number };

  return result.count;
}
