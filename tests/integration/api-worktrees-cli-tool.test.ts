/**
 * API Routes Integration Tests - Worktrees List with CLI Tool Support
 * Tests the /api/worktrees endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Mock the database instance
vi.mock('@/lib/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

describe('GET /api/worktrees - CLI Tool Support', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return correct session status for different CLI tools', async () => {
    // Mock isRunning for different CLI tools
    const { CLIToolManager } = await import('@/lib/cli-tools/manager');
    const manager = CLIToolManager.getInstance();

    const claudeTool = manager.getTool('claude');
    const codexTool = manager.getTool('codex');
    const geminiTool = manager.getTool('gemini');

    vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);
    vi.spyOn(codexTool, 'isRunning').mockResolvedValue(false);
    vi.spyOn(geminiTool, 'isRunning').mockResolvedValue(true);

    // Create test worktrees with different CLI tools
    const claudeWorktree: Worktree = {
      id: 'claude-wt',
      name: 'Claude Worktree',
      path: '/path/to/claude',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
      updatedAt: new Date('2025-01-18T10:00:00Z'),
    };

    const codexWorktree: Worktree = {
      id: 'codex-wt',
      name: 'Codex Worktree',
      path: '/path/to/codex',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'codex',
      updatedAt: new Date('2025-01-18T11:00:00Z'),
    };

    const geminiWorktree: Worktree = {
      id: 'gemini-wt',
      name: 'Gemini Worktree',
      path: '/path/to/gemini',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'gemini',
      updatedAt: new Date('2025-01-18T12:00:00Z'),
    };

    upsertWorktree(db, claudeWorktree);
    upsertWorktree(db, codexWorktree);
    upsertWorktree(db, geminiWorktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(3);

    // Check Claude worktree (running)
    const claudeWt = data.worktrees.find((wt: any) => wt.id === 'claude-wt');
    expect(claudeWt).toBeDefined();
    expect(claudeWt.cliToolId).toBe('claude');
    expect(claudeWt.isSessionRunning).toBe(true);

    // Check Codex worktree (not running)
    const codexWt = data.worktrees.find((wt: any) => wt.id === 'codex-wt');
    expect(codexWt).toBeDefined();
    expect(codexWt.cliToolId).toBe('codex');
    expect(codexWt.isSessionRunning).toBe(false);

    // Check Gemini worktree (running)
    const geminiWt = data.worktrees.find((wt: any) => wt.id === 'gemini-wt');
    expect(geminiWt).toBeDefined();
    expect(geminiWt.cliToolId).toBe('gemini');
    expect(geminiWt.isSessionRunning).toBe(true);

    // Verify correct isRunning methods were called
    expect(claudeTool.isRunning).toHaveBeenCalledWith('claude-wt');
    expect(codexTool.isRunning).toHaveBeenCalledWith('codex-wt');
    expect(geminiTool.isRunning).toHaveBeenCalledWith('gemini-wt');
  });

  it('should default to claude when cliToolId is not specified', async () => {
    // Mock isRunning for claude tool
    const { CLIToolManager } = await import('@/lib/cli-tools/manager');
    const manager = CLIToolManager.getInstance();
    const claudeTool = manager.getTool('claude');
    vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);

    // Create worktree without cliToolId (defaults to claude)
    const worktree: Worktree = {
      id: 'default-wt',
      name: 'Default Worktree',
      path: '/path/to/default',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      // cliToolId not specified - should default to 'claude'
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    const defaultWt = data.worktrees.find((wt: any) => wt.id === 'default-wt');

    expect(defaultWt).toBeDefined();
    expect(defaultWt.cliToolId).toBe('claude');
    expect(defaultWt.isSessionRunning).toBe(true);
    expect(claudeTool.isRunning).toHaveBeenCalledWith('default-wt');
  });

  it('should include cliToolId in worktree response', async () => {
    // Mock isRunning
    const { CLIToolManager } = await import('@/lib/cli-tools/manager');
    const manager = CLIToolManager.getInstance();
    const codexTool = manager.getTool('codex');
    vi.spyOn(codexTool, 'isRunning').mockResolvedValue(false);

    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'codex',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(1);
    expect(data.worktrees[0].cliToolId).toBe('codex');
  });
});
