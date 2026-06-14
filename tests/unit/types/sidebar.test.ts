/**
 * Tests for sidebar types
 *
 * Tests the BranchStatus type, SidebarBranchItem interface, and toBranchItem function
 */

import { describe, it, expect } from 'vitest';
import type { BranchStatus, SidebarBranchItem } from '@/types/sidebar';
import {
  toBranchItem,
  deriveCliStatus,
  aggregateCliStatus,
  formatCliStatusBreakdown,
} from '@/types/sidebar';
import type { Worktree } from '@/types/models';

describe('sidebar types', () => {
  describe('BranchStatus', () => {
    it('should accept valid status values', () => {
      const statuses: BranchStatus[] = ['idle', 'ready', 'running', 'waiting', 'generating'];
      expect(statuses).toHaveLength(5);
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

    it('should return ready when session is running', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        isSessionRunning: true,
        isWaitingForResponse: false,
        isProcessing: false,
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('ready');
    });

    it('should return running when session is processing', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        isSessionRunning: true,
        isWaitingForResponse: false,
        isProcessing: true,
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('running');
    });

    it('should return waiting when waiting for response', () => {
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

    it('should return idle even with sessionStatusByCli data', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.status).toBe('idle');
    });

    it('should populate cliStatus from sessionStatusByCli', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
          codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      // Issue #836: default fallback is now 5 agents
      expect(result.cliStatus).toEqual({
        claude: 'running',
        codex: 'waiting',
        gemini: 'idle',
        opencode: 'idle',
        copilot: 'idle',
      });
    });

    it('should return idle cliStatus when no sessionStatusByCli', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
      };

      const result = toBranchItem(worktree);

      // Issue #836: default fallback is now 5 agents
      expect(result.cliStatus).toEqual({
        claude: 'idle',
        codex: 'idle',
        gemini: 'idle',
        opencode: 'idle',
        copilot: 'idle',
      });
    });

    it('should set hasUnread based on lastAssistantMessageAt and lastViewedAt', () => {
      // hasUnread is now based on lastAssistantMessageAt > lastViewedAt
      const assistantTime = new Date('2024-01-01T12:00:00Z');

      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        lastAssistantMessageAt: assistantTime,
        // No lastViewedAt means never viewed = unread
      };

      const result = toBranchItem(worktree);

      // Should be unread since there's an assistant message but never viewed
      expect(result.hasUnread).toBe(true);
    });

    it('should use selectedAgents for cliStatus keys (Issue #368)', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        selectedAgents: ['gemini', 'vibe-local'],
        sessionStatusByCli: {
          gemini: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
          'vibe-local': { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus).toEqual({
        gemini: 'running',
        'vibe-local': 'waiting',
      });
      // Should NOT include claude or codex since they are not in selectedAgents
      expect(result.cliStatus?.claude).toBeUndefined();
      expect(result.cliStatus?.codex).toBeUndefined();
    });

    it('should fall back to default agents when selectedAgents is not set', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/path/to/worktree',
        repositoryPath: '/path/to/repo',
        repositoryName: 'MyRepo',
        // No selectedAgents set - should use DEFAULT_SELECTED_AGENTS
      };

      const result = toBranchItem(worktree);

      // Issue #836: DEFAULT_SELECTED_AGENTS is
      // ['claude', 'codex', 'gemini', 'opencode', 'copilot']
      expect(result.cliStatus).toEqual({
        claude: 'idle',
        codex: 'idle',
        gemini: 'idle',
        opencode: 'idle',
        copilot: 'idle',
      });
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

    it('should include worktreePath from worktree.path (Issue #651)', () => {
      const worktree: Worktree = {
        id: 'feature-test',
        name: 'feature/test',
        path: '/Users/dev/projects/my-repo/worktrees/feature-test',
        repositoryPath: '/Users/dev/projects/my-repo',
        repositoryName: 'MyRepo',
      };

      const result = toBranchItem(worktree);

      expect(result.worktreePath).toBe('/Users/dev/projects/my-repo/worktrees/feature-test');
    });

    it('should accept optional worktreePath on SidebarBranchItem (Issue #651)', () => {
      const item: SidebarBranchItem = {
        id: 'test-id',
        name: 'feature/test',
        repositoryName: 'MyRepo',
        status: 'idle',
        hasUnread: false,
        worktreePath: '/path/to/worktree',
      };

      expect(item.worktreePath).toBe('/path/to/worktree');
    });

    it('should have undefined worktreePath when SidebarBranchItem is created without it', () => {
      const item: SidebarBranchItem = {
        id: 'test-id',
        name: 'feature/test',
        repositoryName: 'MyRepo',
        status: 'idle',
        hasUnread: false,
      };

      expect(item.worktreePath).toBeUndefined();
    });
  });

  describe('toBranchItem per-instance aggregation (Issue #878)', () => {
    const baseWorktree: Worktree = {
      id: 'photon-mlx-develop',
      name: 'photon-mlx/develop',
      path: '/path/to/worktree',
      repositoryPath: '/path/to/repo',
      repositoryName: 'MyRepo',
    };

    it('should reflect a running instance NOT in selectedAgents (e.g. claude)', () => {
      // Regression: photon-mlx-develop has selectedAgents=[copilot,codex] but a
      // claude session is running. The sidebar icon must show "running"/"ready".
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['copilot', 'codex'],
        isSessionRunning: true,
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          copilot: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          codex: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      // claude (running) is surfaced even though it is not in selectedAgents
      expect(result.cliStatus?.claude).toBe('ready');
      expect(result.cliStatus?.copilot).toBe('idle');
      expect(result.cliStatus?.codex).toBe('idle');
      // The aggregated sidebar icon reflects the running instance
      expect(aggregateCliStatus(result.cliStatus)).toBe('ready');
    });

    it('should reflect an alias instance (claude-2) running via the roster', () => {
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['copilot'],
        agentInstances: [
          { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 0 },
          { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 1 },
          { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 2 },
        ],
        sessionStatusByInstance: {
          copilot: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          'claude-2': { isRunning: true, isWaitingForResponse: false, isProcessing: true },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus?.['claude-2']).toBe('running');
      expect(aggregateCliStatus(result.cliStatus)).toBe('running');
      // The breakdown label uses the instance alias
      expect(result.cliStatusLabels?.['claude-2']).toBe('Claude 2');
    });

    it('should surface a running alias instance even when absent from the roster', () => {
      // No agentInstances roster (legacy) → roster derives from selectedAgents.
      // A running claude-2 alias is still surfaced via sessionStatusByInstance.
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['copilot', 'codex'],
        sessionStatusByInstance: {
          copilot: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          codex: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          'claude-2': { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus?.['claude-2']).toBe('waiting');
      expect(aggregateCliStatus(result.cliStatus)).toBe('waiting');
      // Label is derived from the instance id when no roster alias exists
      expect(result.cliStatusLabels?.['claude-2']).toBe('Claude 2');
    });

    it('should NOT surface idle instances outside the roster', () => {
      // sessionStatusByInstance from the list API contains every primary tool;
      // idle non-roster instances should not clutter the breakdown.
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['copilot', 'codex'],
        sessionStatusByInstance: {
          copilot: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          codex: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          gemini: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(Object.keys(result.cliStatus ?? {}).sort()).toEqual(['codex', 'copilot']);
      expect(aggregateCliStatus(result.cliStatus)).toBe('idle');
    });

    it('should use the agentInstances roster to key and label cliStatus', () => {
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['claude', 'codex'],
        agentInstances: [
          { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
          { id: 'codex', cliTool: 'codex', alias: 'My Codex', order: 1 },
        ],
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
          codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus).toEqual({ claude: 'running', codex: 'ready' });
      expect(result.cliStatusLabels).toEqual({ claude: 'Claude', codex: 'My Codex' });
    });

    it('should preserve legacy behaviour when sessionStatusByInstance is absent', () => {
      // No per-instance data → fall back to selectedAgents + sessionStatusByCli.
      // A running claude is NOT surfaced because it is not in selectedAgents and
      // there is no per-instance source (matches pre-#878 behaviour).
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['copilot', 'codex'],
        sessionStatusByCli: {
          codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus).toEqual({ copilot: 'idle', codex: 'ready' });
      expect(result.cliStatus?.claude).toBeUndefined();
    });

    it('should not break the all-agents default selection', () => {
      const worktree: Worktree = {
        ...baseWorktree,
        selectedAgents: ['claude', 'codex', 'gemini', 'opencode', 'copilot'],
        sessionStatusByInstance: {
          claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          codex: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          gemini: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          opencode: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          copilot: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
        },
      };

      const result = toBranchItem(worktree);

      expect(result.cliStatus).toEqual({
        claude: 'idle',
        codex: 'idle',
        gemini: 'idle',
        opencode: 'idle',
        copilot: 'idle',
      });
      expect(aggregateCliStatus(result.cliStatus)).toBe('idle');
    });
  });

  describe('deriveCliStatus', () => {
    it('should return idle when toolStatus is undefined', () => {
      expect(deriveCliStatus(undefined)).toBe('idle');
    });

    it('should return idle when session is not running', () => {
      expect(deriveCliStatus({ isRunning: false, isWaitingForResponse: false, isProcessing: false })).toBe('idle');
    });

    it('should return ready when session is running but not processing or waiting', () => {
      expect(deriveCliStatus({ isRunning: true, isWaitingForResponse: false, isProcessing: false })).toBe('ready');
    });

    it('should return running when session is processing', () => {
      expect(deriveCliStatus({ isRunning: true, isWaitingForResponse: false, isProcessing: true })).toBe('running');
    });

    it('should return waiting when waiting for response', () => {
      expect(deriveCliStatus({ isRunning: true, isWaitingForResponse: true, isProcessing: false })).toBe('waiting');
    });

    it('should prioritize waiting over running', () => {
      expect(deriveCliStatus({ isRunning: true, isWaitingForResponse: true, isProcessing: true })).toBe('waiting');
    });
  });

  describe('aggregateCliStatus (Issue #867)', () => {
    it('should return idle when cliStatus is undefined', () => {
      expect(aggregateCliStatus(undefined)).toBe('idle');
    });

    it('should return idle for an empty map', () => {
      expect(aggregateCliStatus({})).toBe('idle');
    });

    it('should return idle when all agents are idle', () => {
      expect(aggregateCliStatus({ claude: 'idle', codex: 'idle' })).toBe('idle');
    });

    it('should prioritize waiting above everything else', () => {
      expect(
        aggregateCliStatus({ claude: 'running', codex: 'waiting', gemini: 'ready' })
      ).toBe('waiting');
    });

    it('should prioritize running over ready and idle', () => {
      expect(aggregateCliStatus({ claude: 'ready', codex: 'running' })).toBe('running');
    });

    it('should prioritize generating over ready and idle', () => {
      expect(aggregateCliStatus({ claude: 'ready', codex: 'generating' })).toBe('generating');
    });

    it('should prefer running over generating when both are present', () => {
      // Both render as spinners; ordering is deterministic (running wins).
      expect(aggregateCliStatus({ claude: 'generating', codex: 'running' })).toBe('running');
    });

    it('should return ready when the highest status is ready', () => {
      expect(aggregateCliStatus({ claude: 'idle', codex: 'ready' })).toBe('ready');
    });

    it('should ignore undefined per-agent entries', () => {
      expect(aggregateCliStatus({ claude: undefined, codex: 'ready' })).toBe('ready');
      expect(aggregateCliStatus({ claude: undefined })).toBe('idle');
    });
  });

  describe('formatCliStatusBreakdown (Issue #867)', () => {
    it('should return an empty string when cliStatus is undefined', () => {
      expect(formatCliStatusBreakdown(undefined)).toBe('');
    });

    it('should return an empty string for an empty map', () => {
      expect(formatCliStatusBreakdown({})).toBe('');
    });

    it('should format each agent with its display name and status', () => {
      expect(
        formatCliStatusBreakdown({ claude: 'running', codex: 'idle' })
      ).toBe('Claude: running, Codex: idle');
    });

    it('should use the friendly display name for hyphenated agent ids', () => {
      expect(
        formatCliStatusBreakdown({ claude: 'idle', 'vibe-local': 'ready' })
      ).toBe('Claude: idle, Vibe Local: ready');
    });

    it('should fall back to idle for undefined per-agent entries', () => {
      expect(formatCliStatusBreakdown({ claude: undefined })).toBe('Claude: idle');
    });

    it('should use the provided instance-id label map (Issue #878)', () => {
      expect(
        formatCliStatusBreakdown(
          { claude: 'running', 'claude-2': 'idle' },
          { claude: 'Claude', 'claude-2': 'Claude 2' }
        )
      ).toBe('Claude: running, Claude 2: idle');
    });

    it('should fall back to a derived label for alias instance ids without a label map (Issue #878)', () => {
      // 'claude-2' is not a CLI tool id → getCliToolDisplayNameSafe returns the
      // id itself as the fallback rather than a generic 'Assistant'.
      expect(formatCliStatusBreakdown({ 'claude-2': 'running' })).toBe('claude-2: running');
    });
  });
});
