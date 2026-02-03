/**
 * External Apps DB Issue Filter Tests
 * Issue #136: Phase 4 - Task 4.2 - External Apps DB extension
 * Tests for issue_no filter functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import {
  createExternalApp,
  createWorktreeExternalApp,
  getEnabledExternalApps,
  getExternalAppsByIssueNo,
  getMainExternalApps,
} from '@/lib/external-apps/db';
import type { CreateWorktreeExternalAppInput } from '@/types/external-apps';

describe('External Apps DB - Issue #136 Extensions', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('createWorktreeExternalApp', () => {
    it('should create external app with issue_no', () => {
      const input: CreateWorktreeExternalAppInput = {
        name: 'worktree-135',
        displayName: 'Worktree #135',
        description: 'Worktree for Issue #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3001,
        appType: 'other',
        issueNo: 135,
      };

      const app = createWorktreeExternalApp(testDb, input);

      expect(app.name).toBe('worktree-135');
      expect(app.issueNo).toBe(135);
    });

    it('should store issue_no in database', () => {
      const input: CreateWorktreeExternalAppInput = {
        name: 'worktree-200',
        displayName: 'Worktree #200',
        pathPrefix: 'commandmate_issue/200',
        targetPort: 3002,
        appType: 'other',
        issueNo: 200,
      };

      const created = createWorktreeExternalApp(testDb, input);

      // Query database directly to verify
      const row = testDb.prepare(
        'SELECT issue_no FROM external_apps WHERE id = ?'
      ).get(created.id) as { issue_no: number };

      expect(row.issue_no).toBe(200);
    });
  });

  describe('getEnabledExternalApps with filter', () => {
    beforeEach(() => {
      // Create a main app (no issue_no)
      createExternalApp(testDb, {
        name: 'main-app',
        displayName: 'Main App',
        pathPrefix: 'main',
        targetPort: 3000,
        appType: 'nextjs',
      });

      // Create worktree apps
      createWorktreeExternalApp(testDb, {
        name: 'worktree-135',
        displayName: 'Worktree #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3001,
        appType: 'other',
        issueNo: 135,
      });

      createWorktreeExternalApp(testDb, {
        name: 'worktree-200',
        displayName: 'Worktree #200',
        pathPrefix: 'commandmate_issue/200',
        targetPort: 3002,
        appType: 'other',
        issueNo: 200,
      });
    });

    it('should return all enabled apps when no filter', () => {
      const apps = getEnabledExternalApps(testDb);
      expect(apps).toHaveLength(3);
    });

    it('should filter by specific issue_no', () => {
      const apps = getEnabledExternalApps(testDb, { issueNo: 135 });
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('worktree-135');
    });

    it('should return main apps when issueNo is null', () => {
      const apps = getEnabledExternalApps(testDb, { issueNo: null });
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('main-app');
    });
  });

  describe('getExternalAppsByIssueNo', () => {
    beforeEach(() => {
      createWorktreeExternalApp(testDb, {
        name: 'worktree-100',
        displayName: 'Worktree #100',
        pathPrefix: 'commandmate_issue/100',
        targetPort: 3001,
        appType: 'other',
        issueNo: 100,
      });

      createWorktreeExternalApp(testDb, {
        name: 'worktree-100-extra',
        displayName: 'Worktree #100 Extra',
        pathPrefix: 'commandmate_issue/100/extra',
        targetPort: 3002,
        appType: 'other',
        issueNo: 100,
      });
    });

    it('should return all apps for a specific issue', () => {
      const apps = getExternalAppsByIssueNo(testDb, 100);
      expect(apps).toHaveLength(2);
    });

    it('should return empty array for non-existent issue', () => {
      const apps = getExternalAppsByIssueNo(testDb, 999);
      expect(apps).toHaveLength(0);
    });
  });

  describe('getMainExternalApps', () => {
    beforeEach(() => {
      createExternalApp(testDb, {
        name: 'main-1',
        displayName: 'Main 1',
        pathPrefix: 'main1',
        targetPort: 3000,
        appType: 'nextjs',
      });

      createExternalApp(testDb, {
        name: 'main-2',
        displayName: 'Main 2',
        pathPrefix: 'main2',
        targetPort: 3001,
        appType: 'sveltekit',
      });

      createWorktreeExternalApp(testDb, {
        name: 'worktree-135',
        displayName: 'Worktree #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3002,
        appType: 'other',
        issueNo: 135,
      });
    });

    it('should return only main apps (issue_no IS NULL)', () => {
      const apps = getMainExternalApps(testDb);
      expect(apps).toHaveLength(2);
      expect(apps.every(app => !('issueNo' in app) || app.issueNo === undefined)).toBe(true);
    });
  });
});
