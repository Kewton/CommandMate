/**
 * Issue #161: prompt-response API - Prompt re-verification tests
 * Issue #287: promptCheck fallback when re-verification fails
 *
 * Tests that the prompt-response API re-verifies prompt existence
 * before calling sendKeys, preventing the race condition where
 * a prompt disappears between detection and response sending.
 *
 * Issue #287 additions: When promptCheck is null (capture fails),
 * the API falls back to body.promptType/body.defaultOptionNumber
 * to determine if cursor-key navigation should be used.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree, PromptType } from '@/types/models';

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
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

// Mock cli-session (captureSessionOutput)
vi.mock('@/lib/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

// Mock prompt-detector
vi.mock('@/lib/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));

// Mock cli-patterns
vi.mock('@/lib/cli-patterns', () => ({
  stripAnsi: vi.fn((s: string) => s),
  buildDetectPromptOptions: vi.fn().mockReturnValue({ requireDefaultIndicator: false }),
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

interface CreateRequestOptions {
  answer: string;
  cliTool?: string;
  promptType?: PromptType;
  defaultOptionNumber?: number;
}

function createRequest(worktreeId: string, answerOrOptions: string | CreateRequestOptions, cliTool?: string): NextRequest {
  let body: Record<string, unknown>;

  if (typeof answerOrOptions === 'string') {
    body = { answer: answerOrOptions };
    if (cliTool) body.cliTool = cliTool;
  } else {
    body = { answer: answerOrOptions.answer };
    if (answerOrOptions.cliTool) body.cliTool = answerOrOptions.cliTool;
    if (answerOrOptions.promptType !== undefined) body.promptType = answerOrOptions.promptType;
    if (answerOrOptions.defaultOptionNumber !== undefined) body.defaultOptionNumber = answerOrOptions.defaultOptionNumber;
  }

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
    const { detectPrompt } = await import('@/lib/prompt-detector');
    const { sendSpecialKeys } = await import('@/lib/tmux');

    // Prompt is still active at the time of re-verification
    vi.mocked(captureSessionOutput).mockResolvedValue('Do you want to proceed?\n\u276F 1. Yes\n  2. No');
    vi.mocked(detectPrompt).mockReturnValue({
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
    // Issue #193: Claude multi-choice uses sendSpecialKeys (cursor-based navigation)
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('should NOT send keys when prompt has disappeared (race condition)', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { detectPrompt } = await import('@/lib/prompt-detector');
    const { sendKeys } = await import('@/lib/tmux');

    // Prompt disappeared by the time of re-verification
    vi.mocked(captureSessionOutput).mockResolvedValue('\u23FA Processing complete.\n\n\u276F ');
    vi.mocked(detectPrompt).mockReturnValue({
      isPrompt: false,
      cleanContent: '\u23FA Processing complete.\n\n\u276F ',
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

describe('POST /api/worktrees/:id/prompt-response - promptCheck fallback (Issue #287)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

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

  it('should use cursor-key navigation when promptCheck=null and body.promptType=multiple_choice', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { sendSpecialKeys, sendKeys } = await import('@/lib/tmux');

    // captureSessionOutput fails -> promptCheck remains null
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));

    // Request includes promptType and defaultOptionNumber from the UI
    const request = createRequest('test-wt', {
      answer: '2',
      promptType: 'multiple_choice',
      defaultOptionNumber: 1,
    });
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    // Should use sendSpecialKeys (cursor navigation) NOT sendKeys (text input)
    expect(sendSpecialKeys).toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();

    // Verify the correct cursor offset: target=2, default=1, offset=+1 -> 1 Down + Enter
    const sentKeys = vi.mocked(sendSpecialKeys).mock.calls[0][1];
    expect(sentKeys).toEqual(['Down', 'Enter']);
  });

  it('should use defaultOptionNumber=1 as fallback when defaultOptionNumber is undefined', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { sendSpecialKeys } = await import('@/lib/tmux');

    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));

    // Request with promptType but NO defaultOptionNumber (old UI scenario)
    const request = createRequest('test-wt', {
      answer: '3',
      promptType: 'multiple_choice',
      // defaultOptionNumber intentionally omitted -> should fall back to 1
    });
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();

    // offset = 3 - 1 (fallback) = 2 -> 2 Down + Enter
    const sentKeys = vi.mocked(sendSpecialKeys).mock.calls[0][1];
    expect(sentKeys).toEqual(['Down', 'Down', 'Enter']);
  });

  it('should use text+Enter for yes_no promptType when promptCheck=null', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');

    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));

    const request = createRequest('test-wt', {
      answer: 'y',
      promptType: 'yes_no',
    });
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    // yes_no should use text+Enter, not cursor navigation
    expect(sendKeys).toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('should use text+Enter when no promptType is provided (backward compatibility)', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');

    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));

    // Old client: no promptType or defaultOptionNumber fields
    const request = createRequest('test-wt', '1');
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    // Should fall back to text+Enter (backward compatible behavior)
    expect(sendKeys).toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('should prefer promptCheck data over body fields when promptCheck succeeds', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { detectPrompt } = await import('@/lib/prompt-detector');
    const { sendSpecialKeys } = await import('@/lib/tmux');

    // promptCheck succeeds with default on option 2
    vi.mocked(captureSessionOutput).mockResolvedValue('Choose:\n  1. A\n\u276F 2. B');
    vi.mocked(detectPrompt).mockReturnValue({
      isPrompt: true,
      promptData: {
        type: 'multiple_choice',
        question: 'Choose:',
        options: [
          { number: 1, label: 'A', isDefault: false },
          { number: 2, label: 'B', isDefault: true },
        ],
        status: 'pending',
      },
      cleanContent: 'Choose:',
    });

    // Body says defaultOptionNumber=1 (stale data from UI), but promptCheck says default=2
    const request = createRequest('test-wt', {
      answer: '1',
      promptType: 'multiple_choice',
      defaultOptionNumber: 1,
    });
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();

    // Should use promptCheck's default (2), not body's (1): offset = 1 - 2 = -1 -> 1 Up + Enter
    const sentKeys = vi.mocked(sendSpecialKeys).mock.calls[0][1];
    expect(sentKeys).toEqual(['Up', 'Enter']);
  });

  it('should handle promptType/defaultOptionNumber as optional fields (backward compatibility)', async () => {
    const { captureSessionOutput } = await import('@/lib/cli-session');
    const { detectPrompt } = await import('@/lib/prompt-detector');
    const { sendSpecialKeys } = await import('@/lib/tmux');

    // promptCheck succeeds - works exactly as before regardless of body fields
    vi.mocked(captureSessionOutput).mockResolvedValue('Q?\n\u276F 1. Yes\n  2. No');
    vi.mocked(detectPrompt).mockReturnValue({
      isPrompt: true,
      promptData: {
        type: 'multiple_choice',
        question: 'Q?',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No', isDefault: false },
        ],
        status: 'pending',
      },
      cleanContent: 'Q?',
    });

    // Old client: no promptType in body
    const request = createRequest('test-wt', '2');
    const response = await promptResponse(request, { params: { id: 'test-wt' } });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();
    // offset = 2 - 1 = 1 -> 1 Down + Enter
    const sentKeys = vi.mocked(sendSpecialKeys).mock.calls[0][1];
    expect(sentKeys).toEqual(['Down', 'Enter']);
  });
});
