/**
 * External Apps Type Tests
 * Issue #136: Phase 4 - Task 4.1 - WorktreeExternalApp derived type
 * Tests for type definitions related to worktree external apps
 */

import { describe, it, expect } from 'vitest';
import type {
  ExternalApp,
  WorktreeExternalApp,
  CreateWorktreeExternalAppInput,
} from '../../../src/types/external-apps';
import { isWorktreeExternalApp } from '../../../src/types/external-apps';

describe('External Apps Types - Issue #136 Extensions', () => {
  describe('WorktreeExternalApp', () => {
    it('should extend ExternalApp with issueNo property', () => {
      const worktreeApp: WorktreeExternalApp = {
        id: 'wt-135-uuid',
        name: 'worktree-135',
        displayName: 'Worktree #135',
        description: 'Worktree for Issue #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3001,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        issueNo: 135,
      };

      expect(worktreeApp.issueNo).toBe(135);
      expect(worktreeApp.pathPrefix).toBe('commandmate_issue/135');
    });

    it('should require issueNo to be a number', () => {
      const worktreeApp: WorktreeExternalApp = {
        id: 'wt-200-uuid',
        name: 'worktree-200',
        displayName: 'Worktree #200',
        pathPrefix: 'commandmate_issue/200',
        targetPort: 3002,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        issueNo: 200,
      };

      expect(typeof worktreeApp.issueNo).toBe('number');
    });
  });

  describe('CreateWorktreeExternalAppInput', () => {
    it('should require issueNo for worktree app creation', () => {
      const input: CreateWorktreeExternalAppInput = {
        name: 'worktree-135',
        displayName: 'Worktree #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3001,
        appType: 'other',
        issueNo: 135,
      };

      expect(input.issueNo).toBe(135);
    });

    it('should inherit optional fields from CreateExternalAppInput', () => {
      const input: CreateWorktreeExternalAppInput = {
        name: 'worktree-150',
        displayName: 'Worktree #150',
        description: 'Testing worktree',
        pathPrefix: 'commandmate_issue/150',
        targetPort: 3003,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: true,
        websocketPathPattern: '/ws',
        issueNo: 150,
      };

      expect(input.description).toBe('Testing worktree');
      expect(input.websocketEnabled).toBe(true);
    });
  });

  describe('isWorktreeExternalApp type guard', () => {
    it('should return true for WorktreeExternalApp', () => {
      const worktreeApp: ExternalApp & { issueNo?: number } = {
        id: 'wt-135-uuid',
        name: 'worktree-135',
        displayName: 'Worktree #135',
        pathPrefix: 'commandmate_issue/135',
        targetPort: 3001,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        issueNo: 135,
      };

      expect(isWorktreeExternalApp(worktreeApp)).toBe(true);
    });

    it('should return false for regular ExternalApp (no issueNo)', () => {
      const regularApp: ExternalApp = {
        id: 'main-app-uuid',
        name: 'main-app',
        displayName: 'Main App',
        pathPrefix: 'main',
        targetPort: 3000,
        targetHost: 'localhost',
        appType: 'nextjs',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(isWorktreeExternalApp(regularApp)).toBe(false);
    });

    it('should return false for app with null issueNo', () => {
      const appWithNullIssue = {
        id: 'app-uuid',
        name: 'some-app',
        displayName: 'Some App',
        pathPrefix: 'some',
        targetPort: 3000,
        targetHost: 'localhost',
        appType: 'other' as const,
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        issueNo: null,
      };

      expect(isWorktreeExternalApp(appWithNullIssue as ExternalApp)).toBe(false);
    });

    it('should narrow type when guard returns true', () => {
      const app: ExternalApp & { issueNo?: number | null } = {
        id: 'wt-uuid',
        name: 'worktree-100',
        displayName: 'Worktree #100',
        pathPrefix: 'commandmate_issue/100',
        targetPort: 3001,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        issueNo: 100,
      };

      if (isWorktreeExternalApp(app)) {
        // TypeScript should know issueNo is number here
        const issueNo: number = app.issueNo;
        expect(issueNo).toBe(100);
      }
    });
  });
});
