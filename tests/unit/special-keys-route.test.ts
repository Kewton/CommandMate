/**
 * Unit tests for special-keys/route.ts
 * Issue #473: Special keys API endpoint with multi-layer defense
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
  sendSpecialKeys: vi.fn(),
  isAllowedSpecialKey: vi.fn((key: string) => ['Up', 'Down', 'Enter', 'Escape', 'Tab', 'BTab'].includes(key)),
  sendSpecialKeysAndInvalidate: vi.fn(),
}));

vi.mock('@/lib/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

import { POST } from '@/app/api/worktrees/[id]/special-keys/route';
import { getWorktreeById } from '@/lib/db';
import { hasSession, sendSpecialKeysAndInvalidate } from '@/lib/tmux';
import { isCliToolType } from '@/lib/cli-tools/types';

function createRequest(body: unknown): NextRequest {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/special-keys', {
    method: 'POST',
    body: bodyStr,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createInvalidJsonRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/special-keys', {
    method: 'POST',
    body: '{invalid json',
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultParams = { params: { id: 'wt-1' } };

describe('POST /api/worktrees/[id]/special-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1', name: 'test', path: '/path' } as ReturnType<typeof getWorktreeById>);
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(sendSpecialKeysAndInvalidate).mockResolvedValue(undefined);
  });

  // === Success cases ===
  it('should send special keys successfully', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendSpecialKeysAndInvalidate).toHaveBeenCalledWith('mcbd-opencode-wt-1', ['Up']);
  });

  it('should accept multiple valid keys', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: ['Down', 'Down', 'Enter'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  // === Layer 0: JSON parse defense [DR4-002] ===
  it('should return 400 for invalid JSON body', async () => {
    const req = createInvalidJsonRequest();
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request body');
  });

  // === Layer 1: cliToolId validation ===
  it('should return 400 for invalid cliToolId', async () => {
    vi.mocked(isCliToolType).mockReturnValueOnce(false);
    const req = createRequest({ cliToolId: 'invalid-tool', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid cliToolId parameter');
    // [DR4-003] Should not contain user input
    expect(json.error).not.toContain('invalid-tool');
  });

  it('should return 400 for missing cliToolId', async () => {
    const req = createRequest({ keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid cliToolId parameter');
  });

  // === Layer 2: keys type validation [DR4-004] ===
  it('should return 400 when keys is not an array', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: 'Up' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid keys parameter');
  });

  it('should return 400 when keys contains non-string elements', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: [123, 'Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid keys parameter');
  });

  it('should return 400 for empty keys array', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: [] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid keys parameter');
  });

  it('should return 400 when keys is missing', async () => {
    const req = createRequest({ cliToolId: 'opencode' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid keys parameter');
  });

  // === Layer 3: keys content validation (isAllowedSpecialKey, MAX_KEYS_LENGTH) ===
  it('should return 400 for disallowed key names', async () => {
    const req = createRequest({ cliToolId: 'opencode', keys: ['C-c'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid special key');
    // [DR4-003] Should not expose the invalid key value
    expect(json.error).not.toContain('C-c');
  });

  it('should return 400 when keys exceed MAX_KEYS_LENGTH (10)', async () => {
    const keys = Array(11).fill('Up');
    const req = createRequest({ cliToolId: 'opencode', keys });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid keys parameter');
  });

  it('should accept exactly MAX_KEYS_LENGTH (10) keys', async () => {
    const keys = Array(10).fill('Up');
    const req = createRequest({ cliToolId: 'opencode', keys });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  // === Layer 4: DB existence check ===
  it('should return 404 for non-existent worktree', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(undefined as unknown as ReturnType<typeof getWorktreeById>);
    const req = createRequest({ cliToolId: 'opencode', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Worktree not found');
  });

  // === Layer 5: Session existence check ===
  it('should return 404 when session does not exist', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    const req = createRequest({ cliToolId: 'opencode', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Session not found');
  });

  // === Layer 6: Internal error ===
  it('should return 500 with fixed-string error on internal failure', async () => {
    vi.mocked(sendSpecialKeysAndInvalidate).mockRejectedValue(new Error('tmux crash'));
    const req = createRequest({ cliToolId: 'opencode', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to send special keys to terminal');
    // [DR4-003] Should not expose internal error details
    expect(json.error).not.toContain('tmux crash');
  });

  // === Security: no params.id in error responses [DR4-003] ===
  it('should never include worktree ID in error messages', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(undefined as unknown as ReturnType<typeof getWorktreeById>);
    const req = createRequest({ cliToolId: 'opencode', keys: ['Up'] });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(json.error).not.toContain('wt-1');
  });
});
