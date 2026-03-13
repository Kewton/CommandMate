/**
 * Tests for tmux capture cache invalidation across all CLI tools
 * Issue #405: Verify that cache invalidation hooks are properly placed
 *
 * These tests verify the B-pattern (distributed invalidation) coverage
 * by checking that invalidateCache() is called after state-changing operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =========================================================================
// Module mocks (must be before imports)
// =========================================================================

// Mock tmux module
// capturePane returns a Claude prompt pattern so sendMessageToClaude doesn't wait
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue('\u276F \n\u203A '),
  killSession: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([]),
}));

// Mock pasted-text-helper
vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs/promises for claude-session
vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

// Mock child_process for claude-session
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    if (typeof opts === 'function') {
      cb = opts;
    }
    const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (cmd.includes('which claude')) {
      callback(null, { stdout: '/usr/local/bin/claude', stderr: '' });
    } else {
      callback(null, { stdout: '', stderr: '' });
    }
    return {};
  }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof _opts === 'function') {
      cb = _opts;
    }
    const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: '', stderr: '' });
    return {};
  }),
}));

// Mock opencode-config
vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn().mockResolvedValue(undefined),
}));

// Mock db modules for vibe-local
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn().mockReturnValue(null),
}));

// Track invalidateCache calls
const invalidateCacheSpy = vi.fn();
const clearAllCacheSpy = vi.fn();

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: (...args: unknown[]) => invalidateCacheSpy(...args),
  clearAllCache: (...args: unknown[]) => clearAllCacheSpy(...args),
  setCachedCapture: vi.fn(),
  getCachedCapture: vi.fn().mockReturnValue(null),
  getOrFetchCapture: vi.fn().mockImplementation(async (_name: string, _lines: number, fetchFn: () => Promise<string>) => fetchFn()),
  sliceOutput: vi.fn().mockImplementation((output: string) => output),
  resetCacheForTesting: vi.fn(),
  CACHE_TTL_MS: 2000,
  CACHE_MAX_ENTRIES: 100,
  CACHE_MAX_CAPTURE_LINES: 10000,
}));

// =========================================================================
// Imports (after mocks)
// =========================================================================

import { sendMessageToClaude, stopClaudeSession } from '@/lib/session/claude-session';
import { CodexTool } from '@/lib/cli-tools/codex';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';

describe('tmux capture cache invalidation (Issue #405)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // claude-session.ts
  // =========================================================================

  describe('claude-session.ts', () => {
    it('should invalidate cache after sendMessageToClaude', async () => {
      await sendMessageToClaude('test-wt', 'hello');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-claude-test-wt');
    });

    it('should invalidate cache after stopClaudeSession', async () => {
      await stopClaudeSession('test-wt');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-claude-test-wt');
    });
  });

  // =========================================================================
  // codex.ts
  // =========================================================================

  describe('codex.ts', () => {
    it('should invalidate cache after sendMessage', async () => {
      const codex = new CodexTool();
      await codex.sendMessage('test-wt', 'hello');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-codex-test-wt');
    });
  });

  // =========================================================================
  // gemini.ts
  // =========================================================================

  describe('gemini.ts', () => {
    it('should invalidate cache after sendMessage', async () => {
      const gemini = new GeminiTool();
      await gemini.sendMessage('test-wt', 'hello');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-gemini-test-wt');
    });
  });

  // =========================================================================
  // opencode.ts
  // =========================================================================

  describe('opencode.ts', () => {
    it('should invalidate cache after sendMessage', async () => {
      const opencode = new OpenCodeTool();
      await opencode.sendMessage('test-wt', 'hello');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-opencode-test-wt');
    });

    it('should invalidate cache after killSession', async () => {
      const opencode = new OpenCodeTool();
      await opencode.killSession('test-wt');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-opencode-test-wt');
    });
  });

  // =========================================================================
  // vibe-local.ts
  // =========================================================================

  describe('vibe-local.ts', () => {
    it('should invalidate cache after sendMessage', async () => {
      const vibeLocal = new VibeLocalTool();
      await vibeLocal.sendMessage('test-wt', 'hello');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-vibe-local-test-wt');
    });
  });

  // =========================================================================
  // prompt-answer-sender.ts
  // =========================================================================

  describe('prompt-answer-sender.ts', () => {
    it('should invalidate cache after sendPromptAnswer (text input)', async () => {
      await sendPromptAnswer({
        sessionName: 'mcbd-claude-test-wt',
        answer: 'y',
        cliToolId: 'claude',
      });
      expect(invalidateCacheSpy).toHaveBeenCalledWith('mcbd-claude-test-wt');
    });
  });

  // =========================================================================
  // session-cleanup.ts
  // =========================================================================

  describe('session-cleanup.ts', () => {
    it('should call clearAllCache during cleanup', async () => {
      const { cleanupWorktreeSessions } = await import('@/lib/session-cleanup');

      await cleanupWorktreeSessions('test-wt', async () => true);

      expect(clearAllCacheSpy).toHaveBeenCalled();
    });
  });
});
