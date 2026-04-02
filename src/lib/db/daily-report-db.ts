/**
 * Daily report database operations
 * CRUD operations for daily_reports table
 *
 * Issue #607: Daily summary feature
 * Follows same patterns as memo-db.ts, timer-db.ts
 */

import Database from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

/** Database row type (snake_case) */
interface DailyReportRow {
  date: string;
  content: string;
  generated_by_tool: string;
  model: string | null;
  created_at: number;
  updated_at: number;
}

/** Daily report model (camelCase for API/client use) */
export interface DailyReport {
  date: string;
  content: string;
  generatedByTool: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Parameters for saving a daily report */
export interface SaveDailyReportParams {
  date: string;
  content: string;
  generatedByTool: string;
  model?: string | null;
}

// =============================================================================
// Row Mapping
// =============================================================================

/** Map database row to DailyReport model */
function mapRow(row: DailyReportRow): DailyReport {
  return {
    date: row.date,
    content: row.content,
    generatedByTool: row.generated_by_tool,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// =============================================================================
// SQL Constants
// =============================================================================

/** SELECT column list for daily_reports queries */
const REPORT_COLUMNS = 'date, content, generated_by_tool, model, created_at, updated_at';

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Get a daily report by date
 *
 * @param db - Database instance
 * @param date - Date string in YYYY-MM-DD format
 * @returns DailyReport or null if not found
 */
export function getDailyReport(
  db: Database.Database,
  date: string
): DailyReport | null {
  const stmt = db.prepare(`
    SELECT ${REPORT_COLUMNS}
    FROM daily_reports
    WHERE date = ?
  `);

  const row = stmt.get(date) as DailyReportRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Save a daily report (UPSERT: insert or replace)
 *
 * @param db - Database instance
 * @param params - Report data to save
 * @returns Saved DailyReport
 */
export function saveDailyReport(
  db: Database.Database,
  params: SaveDailyReportParams
): DailyReport {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_reports (date, content, generated_by_tool, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.date,
    params.content,
    params.generatedByTool,
    params.model ?? null,
    now,
    now
  );

  return getDailyReport(db, params.date)!;
}

/**
 * Update the content of an existing daily report
 *
 * @param db - Database instance
 * @param date - Date string in YYYY-MM-DD format
 * @param content - New report content
 * @throws Error if report not found
 */
export function updateDailyReportContent(
  db: Database.Database,
  date: string,
  content: string
): void {
  const now = Date.now();

  const stmt = db.prepare(`
    UPDATE daily_reports
    SET content = ?, updated_at = ?
    WHERE date = ?
  `);

  const result = stmt.run(content, now, date);

  if (result.changes === 0) {
    throw new Error(`Daily report not found for date: ${date}`);
  }
}
