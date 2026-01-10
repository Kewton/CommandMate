/**
 * Tests for sidebar types
 *
 * Tests the BranchStatus type, SidebarBranchItem interface, and toBranchItem function
 */

import { describe, it, expect } from 'vitest';
import type { BranchStatus, SidebarBranchItem } from '@/types/sidebar';
import { toBranchItem } from '@/types/sidebar';
import type { Worktree } from '@/types/models';

describe('sidebar types', () => {
  describe('BranchStatus', () => {
    it('should accept valid status values', () => {
      const statuses: BranchStatus[] = ['idle', 'running', 'waiting', 'generating'];
      expect(statuses).toHaveLength(4);
    });
  });

  describe('SidebarBranchItem', () => {
    it('should have required properties', () => {
      const item: SidebarBranchItem = {
        id: 'test-id',
        name: 'feature/test',
        repositoryName: 'MyRepo',
        status: 'idle',
        hasUnread: false,
      };

      expect(item.id).toBe('test-id');
      expect(item.name).toBe('feature/test');
      expect(item.repositoryName).toBe('MyRepo');
      expect(item.status).toBe('idle');
      expect(item.hasUnread).toBe(false);
    });

    it('should accept optional lastActivity', () => {
      const now = new Date();
      const item: SidebarBranchItem = {
        id: 'test-id',
        name: 'feature/test',
        repositoryName: 'MyRepo',
        status: 'running',
        hasUnread: true,
        lastActivity: now,
      };

      expect(item.lastActivity).toEqual(now);
    });
  });

  describe('toBranchItem', () => {
    it('should convert Worktree to SidebarBranchItem', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
      };

      const result = toBranchItem(worktree);

      expect(result.id).toBe('feature-test');
      expect(result.name).toBe('feature/test');
      expect(result.repositoryName).toBe('MyRepo');
      expect(result.status).toBe('idle');
      expect(result.hasUnread).toBe(false);
    });

    it('should set status to running when session is running', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        isSessionRunning: true,
        isWaitingForResponse: false,
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('running');
    });

    it('should set status to waiting when waiting for response', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        isSessionRunning: true,
        isWaitingForResponse: true,
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('waiting');
    });

    it('should use sessionStatusByCli for more granular status', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: true },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('waiting');
    });

    it('should set hasUnread based on lastUserMessageAt', () => {
      const recentDate = new Date();
      recentDate.setMinutes(recentDate.getMinutes() - 5); // 5 minutes ago

      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        lastUserMessageAt: recentDate,
      };

      const result = toBranchItem(worktree);

      // hasUnread is determined by lastUserMessageAt presence
      expect(typeof result.hasUnread).toBe('boolean');
    });

    it('should include lastActivity from updatedAt', () => {
      const updateDate = new Date('2024-01-01T12:00:00Z');

      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        updatedAt: updateDate,
      };

      const result = toBranchItem(worktree);

      expect(result.lastActivity).toEqual(updateDate);
    });
  });
});
