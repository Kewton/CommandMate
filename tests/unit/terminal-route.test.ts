/**
 * Unit tests for terminal/route.ts
 * Issue #393: Security hardening - input validation and fixed-string errors
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@/lib/cli-tools/types', () => ({
  isCliToolType: vi.fn((value: string) => ['claude', 'codex', 'gemini', 'vibe-local', 'opencode'].includes(value)),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: vi.fn((id: string) => ({
        getSessionName: vi.fn((worktreeId: string) => `mcbd-${id}-${worktreeId}`),
      })),
    })),
  },
}));

vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  sendKeys: vi.fn(),
}));

import { POST } from '@/app/api/worktrees/[id]/terminal/route';
import { getWorktreeById } from '@/lib/db';
import { hasSession, sendKeys } from '@/lib/tmux/tmux';
import { isCliToolType } from '@/lib/cli-tools/types';

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/terminal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultParams = { params: { id: 'wt-1' } };

describe('POST /api/worktrees/[id]/terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1', name: 'test', path: '/path' } as ReturnType<typeof getWorktreeById>);
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(sendKeys).mockResolvedValue(undefined);
  });

  it('should send command successfully with valid cliToolId', async () => {
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendKeys).toHaveBeenCalledWith('mcbd-claude-wt-1', 'echo hello');
  });

  it('should return 400 for invalid cliToolId (shell metacharacters)', async () => {
    vi.mocked(isCliToolType).mockReturnValueOnce(false);
    const req = createRequest({ cliToolId: '"; rm -rf /', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    // R4F006: Fixed-string error, no user input in message
    expect(json.error).toBe('Invalid cliToolId parameter');
    expect(json.error).not.toContain('rm -rf');
  });

  it('should return 400 for missing cliToolId', async () => {
    const req = createRequest({ command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid cliToolId parameter');
  });

  it('should return 404 for non-existent worktreeId', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(undefined as unknown as ReturnType<typeof getWorktreeById>);
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Worktree not found');
  });

  it('should return 404 when session does not exist (no auto-creation)', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    // R4F007: Fixed-string error
    expect(json.error).toBe('Session not found. Use startSession API to create a session first.');
    // R3F001: Verify createSession is NOT called
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('should return 400 for missing command', async () => {
    const req = createRequest({ cliToolId: 'claude' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Missing command parameter');
  });

  it('should return 400 when command exceeds MAX_COMMAND_LENGTH', async () => {
    const longCommand = 'a'.repeat(10001);
    const req = createRequest({ cliToolId: 'claude', command: longCommand });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid command parameter');
  });

  it('should return 500 with fixed-string error on internal error', async () => {
    vi.mocked(sendKeys).mockRejectedValue(new Error('internal tmux failure'));
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(500);
    // R4F002: Fixed-string error, no error.message exposure
    expect(json.error).toBe('Failed to send command to terminal');
    expect(json.error).not.toContain('internal tmux failure');
  });
});
