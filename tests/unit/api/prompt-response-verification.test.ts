/**
 * Issue #161: prompt-response API - Prompt re-verification tests
 *
 * Tests that the prompt-response API re-verifies prompt existence
 * before calling sendKeys, preventing the race condition where
 * a prompt disappears between detection and response sending.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// --- Mocks ---

// Mock db-instance
declare module '@/lib/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => {
      if (mockDb) { mockDb.close(); mockDb = null; }
    },
  };
});

// Mock tmux
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
}));

// Mock cli-session (captureSessionOutput)
vi.mock('@/lib/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

// Mock cli-patterns (includes detectPromptForCli, stripAnsi)
vi.mock('@/lib/cli-patterns', () => ({
  stripAnsi: vi.fn((s: string) => s),
  detectPromptForCli: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));

// Mock CLIToolManager
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    }),
  },
}));

// --- Helpers ---

function createRequest(worktreeId: string, answer: string, cliTool?: string): NextRequest {
  const body: Record<string, string> = { answer };
  if (cliTool) body.cliTool = cliTool;

  return new Request(`http://localhost:3000/api/worktrees/${worktreeId}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// --- Tests ---

describe('POST /api/worktrees/:id/prompt-response - Prompt re-verification (Issue #161)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Create test worktree
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    vi.clearAllMocks();
  });

  it('should send keys when prompt is still active', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { detectPromptForCli } = await import('@/lib/cli-patterns');
    const { sendKeys } = await import('@/lib/tmux');

    // Prompt is still active at the time of re-verification
    vi.mocked(captureSessionOutput).mockResolvedValue('Do you want to proceed?\n❯ 1. Yes\n  2. No');
    vi.mocked(detectPromptForCli).mockReturnValue({
      isPrompt: true,
      promptData: {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: [
          { number: 1, label: 'Yes', isDefault: true, requiresTextInput: false },
          { number: 2, label: 'No', isDefault: false, requiresTextInput: false },
        ],
        status: 'pending',
      },
      cleanContent: 'Do you want to proceed?',
    });

    const request = createRequest('test-wt', '1');
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendKeys).toHaveBeenCalled();
  });

  it('should NOT send keys when prompt has disappeared (race condition)', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { detectPromptForCli } = await import('@/lib/cli-patterns');
    const { sendKeys } = await import('@/lib/tmux');

    // Prompt disappeared by the time of re-verification
    vi.mocked(captureSessionOutput).mockResolvedValue('⏺ Processing complete.\n\n❯ ');
    vi.mocked(detectPromptForCli).mockReturnValue({
      isPrompt: false,
      cleanContent: '⏺ Processing complete.\n\n❯ ',
    });

    const request = createRequest('test-wt', '1');
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(false);
    expect(data.reason).toBe('prompt_no_longer_active');
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('should proceed with send when capture fails (fallback for manual responses)', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { sendKeys } = await import('@/lib/tmux');

    // captureSessionOutput fails (e.g., tmux error)
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));

    const request = createRequest('test-wt', '1');
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    // Should still send keys (don't block manual responses)
    expect(data.success).toBe(true);
    expect(sendKeys).toHaveBeenCalled();
  });

  it('should return 404 for non-existent worktree', async () => {
    const request = createRequest('nonexistent', '1');
    const response = await promptResponse(request, { params: { id: 'nonexistent' } });

    expect(response.status).toBe(404);
  });

  it('should return 400 when answer is missing', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/test-wt/prompt-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as unknown as NextRequest;

    const response = await promptResponse(request, { params: { id: 'test-wt' } });

    expect(response.status).toBe(400);
  });
});
