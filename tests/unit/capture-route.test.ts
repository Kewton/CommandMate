/**
 * Unit tests for capture/route.ts
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

vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(),
  capturePane: vi.fn(),
}));

import { POST } from '@/app/api/worktrees/[id]/capture/route';
import { getWorktreeById } from '@/lib/db';
import { hasSession, capturePane } from '@/lib/tmux';
import { isCliToolType } from '@/lib/cli-tools/types';

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/capture', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultParams = { params: { id: 'wt-1' } };

describe('POST /api/worktrees/[id]/capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1', name: 'test', path: '/path' } as ReturnType<typeof getWorktreeById>);
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue('captured output');
  });

  it('should capture output successfully with valid cliToolId', async () => {
    const req = createRequest({ cliToolId: 'claude', lines: 100 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.output).toBe('captured output');
    expect(capturePane).toHaveBeenCalledWith('mcbd-claude-wt-1', 100);
  });

  it('should use default lines=1000 when not specified', async () => {
    const req = createRequest({ cliToolId: 'claude' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.output).toBe('captured output');
    expect(capturePane).toHaveBeenCalledWith('mcbd-claude-wt-1', 1000);
  });

  it('should return 400 for invalid cliToolId', async () => {
    vi.mocked(isCliToolType).mockReturnValueOnce(false);
    const req = createRequest({ cliToolId: '$(malicious)', lines: 100 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    // R4F006: Fixed-string error, no user input in message
    expect(json.error).toBe('Invalid cliToolId parameter');
    expect(json.error).not.toContain('malicious');
  });

  it('should return 404 for non-existent worktreeId', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(undefined as unknown as ReturnType<typeof getWorktreeById>);
    const req = createRequest({ cliToolId: 'claude', lines: 100 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Worktree not found');
  });

  it('should return 400 for negative lines', async () => {
    const req = createRequest({ cliToolId: 'claude', lines: -1 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid lines parameter: must be an integer between 1 and 100000');
  });

  it('should return 400 for string lines', async () => {
    const req = createRequest({ cliToolId: 'claude', lines: 'abc' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid lines parameter: must be an integer between 1 and 100000');
  });

  it('should return 400 for lines exceeding 100000', async () => {
    const req = createRequest({ cliToolId: 'claude', lines: 100001 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid lines parameter: must be an integer between 1 and 100000');
  });

  it('should return 400 for float lines', async () => {
    const req = createRequest({ cliToolId: 'claude', lines: 10.5 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid lines parameter: must be an integer between 1 and 100000');
  });

  it('should return 404 when session does not exist (no auto-creation)', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    const req = createRequest({ cliToolId: 'claude', lines: 100 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    // R4F007: Fixed-string error, no cliToolId in message
    expect(json.error).toBe('Session not found. Use startSession API to create a session first.');
    expect(json.error).not.toContain('claude');
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('should return 500 with fixed-string error on internal error', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('internal tmux failure'));
    const req = createRequest({ cliToolId: 'claude', lines: 100 });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(500);
    // R4F002: Fixed-string error, no error.message exposure
    expect(json.error).toBe('Failed to capture terminal output');
    expect(json.error).not.toContain('internal tmux failure');
  });
});
