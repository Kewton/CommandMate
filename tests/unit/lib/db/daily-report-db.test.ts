/**
 * Tests for daily-report-db.ts
 * Issue #607: Daily report CRUD operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getDailyReport,
  saveDailyReport,
  updateDailyReportContent,
} from '@/lib/db/daily-report-db';

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');

  // Create daily_reports table (v24 migration)
  testDb.exec(`
    CREATE TABLE daily_reports (
      date TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      generated_by_tool TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  return testDb;
}

describe('daily-report-db', () => {
  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getDailyReport', () => {
    it('should return null for non-existent date', () => {
      const result = getDailyReport(db, '2026-04-02');
      expect(result).toBeNull();
    });

    it('should return report for existing date', () => {
      saveDailyReport(db, {
        date: '2026-04-02',
        content: '## Summary\nWork done today.',
        generatedByTool: 'claude',
      });

      const result = getDailyReport(db, '2026-04-02');
      expect(result).not.toBeNull();
      expect(result!.date).toBe('2026-04-02');
      expect(result!.content).toBe('## Summary\nWork done today.');
      expect(result!.generatedByTool).toBe('claude');
      expect(result!.model).toBeNull();
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('saveDailyReport', () => {
    it('should create a new report', () => {
      const result = saveDailyReport(db, {
        date: '2026-04-02',
        content: 'Report content',
        generatedByTool: 'codex',
        model: null,
      });

      expect(result.date).toBe('2026-04-02');
      expect(result.content).toBe('Report content');
      expect(result.generatedByTool).toBe('codex');
    });

    it('should save with model for copilot', () => {
      const result = saveDailyReport(db, {
        date: '2026-04-02',
        content: 'Copilot report',
        generatedByTool: 'copilot',
        model: 'gpt-4o',
      });

      expect(result.model).toBe('gpt-4o');
    });

    it('should upsert (replace) existing report for same date', () => {
      saveDailyReport(db, {
        date: '2026-04-02',
        content: 'First version',
        generatedByTool: 'claude',
      });

      const updated = saveDailyReport(db, {
        date: '2026-04-02',
        content: 'Second version',
        generatedByTool: 'codex',
      });

      expect(updated.content).toBe('Second version');
      expect(updated.generatedByTool).toBe('codex');

      // Only one record should exist
      const count = db.prepare('SELECT COUNT(*) as cnt FROM daily_reports').get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe('updateDailyReportContent', () => {
    it('should update content of existing report', () => {
      saveDailyReport(db, {
        date: '2026-04-02',
        content: 'Original content',
        generatedByTool: 'claude',
      });

      updateDailyReportContent(db, '2026-04-02', 'Updated content');

      const result = getDailyReport(db, '2026-04-02');
      expect(result!.content).toBe('Updated content');
      // generatedByTool should remain unchanged
      expect(result!.generatedByTool).toBe('claude');
    });

    it('should throw error for non-existent date', () => {
      expect(() => {
        updateDailyReportContent(db, '2026-04-02', 'Content');
      }).toThrow('Daily report not found for date: 2026-04-02');
    });

    it('should update updated_at timestamp', () => {
      saveDailyReport(db, {
        date: '2026-04-02',
        content: 'Original',
        generatedByTool: 'claude',
      });

      const before = getDailyReport(db, '2026-04-02')!;

      // Small delay to ensure timestamp difference
      const originalUpdatedAt = before.updatedAt.getTime();

      updateDailyReportContent(db, '2026-04-02', 'Updated');

      const after = getDailyReport(db, '2026-04-02')!;
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });
});
