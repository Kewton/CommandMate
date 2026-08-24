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
  // Issue #1880: the send path now empties the composer first, and the loop
  // that does it resolves this primitive up front. The frame above carries no
  // input box, so no pass is ever sent — but the mock still has to expose it.
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([]),
}));

// Issue #1977: every wait in `src/config/cli-tool-timing-config.ts` is a real
// `setTimeout` inside production code, and this file awaits nine send/kill
// paths that go through them. Measured on the unloaded development machine
// before this mock, the file spent 5.95s of its 5.95s asleep:
//
//   opencode killSession 2103ms (OPENCODE_EXIT_WAIT_MS 2000 + text-input 100)
//   claude   stopSession  502ms (TUI_EXIT_WAIT_MS 500)
//   vibe-local send       504ms (text-input 100 + processed 200 + double-enter 200)
//   codex / gemini / opencode send  ~303ms each
//                               (TUI_TEXT_INPUT_WAIT_MS 100 + TUI_MESSAGE_PROCESSED_WAIT_MS 200,
//                                both read by src/lib/cli-tools/submit-verified-sender.ts)
//   prompt-answer-sender  100ms (TUI_TEXT_INPUT_WAIT_MS)
//
// Those numbers exist so a real TUI has time to redraw between keystrokes.
// Nothing in this file drives a real TUI — `@/lib/tmux/tmux` is mocked above —
// so the sleeps buy nothing here and put the worst `it()` at 2.1s, within 2.4x
// of vitest's 5000ms default. A machine 2.4x slower than idle turns a green
// assertion into `Test timed out in 5000ms`, which is Issue #1977.
//
// Only the `*_MS` durations are zeroed, and every other export is passed
// through unchanged, so a future non-duration export in that module does not
// silently become 0.
vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.endsWith('_MS') && typeof value === 'number' ? 0 : value,
    ])
  );
});

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
vi.mock('@/lib/db/db-instance', () => ({
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
  CACHE_TTL_MS: 3000,
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
// Issue #1977: statically imported alongside every other subject in this file.
// It used to be `await import('@/lib/session-cleanup')` inside the last `it()`,
// which charged that test 880ms of module loading — measured with every other
// subject already warm, and dominated by `@/lib/polling/response-poller`
// (778ms of the 880ms), a barrel this file never asserts on. Under deliberate
// process pressure that one `await import` stretched to 4031ms: 80% of the way
// to a 5000ms timeout, for a cost that is not the assertion. `vi.mock` calls
// are hoisted above every import, so the mocks above still apply.
import { cleanupWorktreeSessions } from '@/lib/session-cleanup';

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
      await cleanupWorktreeSessions('test-wt', async () => true);

      expect(clearAllCacheSpy).toHaveBeenCalled();
    });
  });
});
