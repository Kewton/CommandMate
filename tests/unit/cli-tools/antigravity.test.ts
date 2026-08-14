/**
 * Unit tests for AntigravityTool
 * Issue #988: Antigravity (agy) CLI support (Phase A)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock tmux functions
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

const SESSION = 'mcbd-antigravity-test-wt';
const IDLE_FOOTER = '? for shortcuts';
const TRUST_DIALOG =
  'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n↑/↓ Navigate · enter Confirm';

/**
 * The launch command `startSession` now types into the pane (Issue #1762,
 * extended by #1779).
 *
 * `agy` reads one hooks file for the whole machine, so the worktree and instance
 * cannot be written into it and travel in the environment instead. The port is
 * whatever the environment resolves to, hence the pattern rather than a literal.
 * `--model` still goes last, so #989's quoting is unchanged by the prefix.
 *
 * Two variables since #1779: the observation events and the approval
 * adjudication go to receivers with opposite contracts, and the adjudication
 * hook reads an absent `CM_PERMISSION_HOOK_URL` as "this agy is not
 * CommandMate's, abstain" — which is the only thing keeping the machine-global
 * hooks file out of the operator's own agy sessions.
 */
function agyLaunch(modelSuffix = ''): RegExp {
  const escaped = modelSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const query = `\\?tool=antigravity&worktreeId=test-wt&instanceId=antigravity`;
  return new RegExp(
    `^CM_HOOK_URL='http://127\\.0\\.0\\.1:\\d+/api/hooks/agent-event${query}' ` +
      `CM_PERMISSION_HOOK_URL='http://127\\.0\\.0\\.1:\\d+/api/hooks/permission-request${query}' ` +
      `'agy'${escaped}$`
  );
}

describe('AntigravityTool', () => {
  let tool: AntigravityTool;
  const tempHomes: string[] = [];

  beforeEach(() => {
    tool = new AntigravityTool();
    vi.clearAllMocks();
    // Issue #1762: `startSession` merges CommandMate's named hook into
    // `~/.gemini/config/hooks.json`, which is a real file on a real developer's
    // machine. `os.homedir()` reads `$HOME` on POSIX, so a private HOME is all
    // that stands between this suite and the operator's agy configuration.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-test-home-')));
    tempHomes.push(home);
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tempHomes.length > 0) {
      const home = tempHomes.pop();
      if (home) removeTempDir(home);
    }
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('antigravity');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Antigravity CLI');
    });

    it('should have correct command (agy)', () => {
      expect(tool.command).toBe('agy');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('antigravity');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      expect(tool.getSessionName('test-wt')).toBe(SESSION);
    });

    it('should generate session name for an arbitrary worktree id', () => {
      expect(tool.getSessionName('feature-foo')).toBe('mcbd-antigravity-feature-foo');
    });

    it('should throw error for worktree id with slashes (security)', () => {
      expect(() => tool.getSessionName('feature/issue/123')).toThrow(/Invalid session name format/);
    });
  });

  describe('isInstalled', () => {
    it('should resolve to a boolean (which agy)', async () => {
      const installed = await tool.isInstalled();
      expect(typeof installed).toBe('boolean');
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      const running = await tool.isRunning('test-wt');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);
      const running = await tool.isRunning('non-existent-worktree-xyz');
      expect(running).toBe(false);
    });
  });

  describe('Interface implementation', () => {
    it('should implement all required methods', () => {
      expect(typeof tool.isInstalled).toBe('function');
      expect(typeof tool.isRunning).toBe('function');
      expect(typeof tool.startSession).toBe('function');
      expect(typeof tool.sendMessage).toBe('function');
      expect(typeof tool.killSession).toBe('function');
      expect(typeof tool.getSessionName).toBe('function');
    });

    it('should have readonly properties', () => {
      expect(tool.id).toBe('antigravity');
      expect(tool.name).toBe('Antigravity CLI');
      expect(tool.command).toBe('agy');
    });
  });

  describe('startSession', () => {
    it('should throw when agy is not installed', async () => {
      vi.spyOn(tool, 'isInstalled').mockResolvedValue(false);
      await expect(tool.startSession('test-wt', '/path/to/wt')).rejects.toThrow(/not installed/i);
    });

    it('should return early when a session already exists', async () => {
      const { hasSession, createSession } = await import('@/lib/tmux/tmux');
      vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.startSession('test-wt', '/path/to/wt');

      expect(createSession).not.toHaveBeenCalled();
    });

    it('should launch agy and auto-confirm the trust dialog before reaching ready', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, createSession, sendKeys, sendSpecialKey, capturePane } =
          await import('@/lib/tmux/tmux');
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(false);

        // First poll shows the trust dialog, subsequent polls show the idle footer.
        let call = 0;
        vi.mocked(capturePane).mockImplementation(async () => {
          call++;
          return call === 1 ? TRUST_DIALOG : IDLE_FOOTER;
        });

        const promise = tool.startSession('test-wt', '/path/to/wt');
        await vi.advanceTimersByTimeAsync(40000);
        await promise;

        expect(createSession).toHaveBeenCalled();
        // Contract: launch the agy binary in interactive mode, behind the
        // Issue #1762 correlation prefix.
        expect(sendKeys).toHaveBeenCalledWith(SESSION, expect.stringMatching(agyLaunch()), true);
        // Trust dialog confirmed with a single Enter (default "Yes, I trust this folder").
        expect(sendSpecialKey).toHaveBeenCalledWith(SESSION, 'Enter');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not send Enter when no trust dialog appears', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, sendSpecialKey, capturePane } = await import('@/lib/tmux/tmux');
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(false);
        vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

        const promise = tool.startSession('test-wt', '/path/to/wt');
        await vi.advanceTimersByTimeAsync(40000);
        await promise;

        expect(sendSpecialKey).not.toHaveBeenCalledWith(SESSION, 'Enter');
      } finally {
        vi.useRealTimers();
      }
    });

    // Issue #989: --model is a launch-time flag (agy has no in-session /model
    // command), so it must be embedded in the launch command typed at session start.
    describe('with model (Issue #989)', () => {
      it('should launch agy with --model when a model is specified', async () => {
        vi.useFakeTimers();
        try {
          const { hasSession, sendKeys, capturePane } = await import('@/lib/tmux/tmux');
          vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
          vi.mocked(hasSession).mockResolvedValue(false);
          vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

          const promise = tool.startSession('test-wt', '/path/to/wt', undefined, 'Gemini 3.1 Pro (High)');
          await vi.advanceTimersByTimeAsync(40000);
          await promise;

          expect(sendKeys).toHaveBeenCalledWith(
            SESSION,
            expect.stringMatching(agyLaunch(" --model 'Gemini 3.1 Pro (High)'")),
            true
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('should launch plain agy when model is undefined', async () => {
        vi.useFakeTimers();
        try {
          const { hasSession, sendKeys, capturePane } = await import('@/lib/tmux/tmux');
          vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
          vi.mocked(hasSession).mockResolvedValue(false);
          vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

          const promise = tool.startSession('test-wt', '/path/to/wt');
          await vi.advanceTimersByTimeAsync(40000);
          await promise;

          expect(sendKeys).toHaveBeenCalledWith(SESSION, expect.stringMatching(agyLaunch()), true);
        } finally {
          vi.useRealTimers();
        }
      });

      it('should safely escape an embedded single quote in the model value', async () => {
        vi.useFakeTimers();
        try {
          const { hasSession, sendKeys, capturePane } = await import('@/lib/tmux/tmux');
          vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
          vi.mocked(hasSession).mockResolvedValue(false);
          vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

          const promise = tool.startSession('test-wt', '/path/to/wt', undefined, "model'; rm -rf ~ #");
          await vi.advanceTimersByTimeAsync(40000);
          await promise;

          expect(sendKeys).toHaveBeenCalledWith(
            SESSION,
            expect.stringMatching(agyLaunch(` --model 'model'\\''; rm -rf ~ #'`)),
            true
          );
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  describe('sendMessage', () => {
    it('should throw when the session does not exist', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendMessage('test-wt', 'hello')).rejects.toThrow(/does not exist/);
    });

    it('should delegate to the submit-verified sender and invalidate the capture cache', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
        const { sendMessageWithSubmitVerification } = await import('@/lib/cli-tools/submit-verified-sender');
        const { invalidateCache } = await import('@/lib/tmux/tmux-capture-cache');
        vi.mocked(hasSession).mockResolvedValue(true);
        vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

        const promise = tool.sendMessage('test-wt', 'hello');
        await vi.advanceTimersByTimeAsync(20000);
        await promise;

        // Issue #1471: body/Enter separation + submit verification is delegated.
        expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
          expect.objectContaining({ sessionName: SESSION, message: 'hello', cliToolId: 'antigravity' })
        );
        // Contract: sendMessage MUST invalidate the capture cache.
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should apply submit verification to multi-line (pasted) messages too', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
        const { sendMessageWithSubmitVerification } = await import('@/lib/cli-tools/submit-verified-sender');
        vi.mocked(hasSession).mockResolvedValue(true);
        vi.mocked(capturePane).mockResolvedValue(IDLE_FOOTER);

        const promise = tool.sendMessage('test-wt', 'line1\nline2');
        await vi.advanceTimersByTimeAsync(20000);
        await promise;

        // No `\n` gate anymore — the helper runs for every message.
        expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
          expect.objectContaining({ sessionName: SESSION, message: 'line1\nline2', cliToolId: 'antigravity' })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('killSession', () => {
    it('should send Ctrl+D, kill the tmux session, and invalidate the cache', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, sendSpecialKey, killSession: tmuxKillSession } =
          await import('@/lib/tmux/tmux');
        const { invalidateCache } = await import('@/lib/tmux/tmux-capture-cache');
        vi.mocked(hasSession).mockResolvedValue(true);
        vi.mocked(tmuxKillSession).mockResolvedValue(true);

        const promise = tool.killSession('test-wt');
        await vi.advanceTimersByTimeAsync(2000);
        await promise;

        expect(sendSpecialKey).toHaveBeenCalledWith(SESSION, 'C-d');
        expect(tmuxKillSession).toHaveBeenCalledWith(SESSION);
        // Contract: killSession MUST invalidate the capture cache.
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should still invalidate the cache when no session exists (no Ctrl+D sent)', async () => {
      const { hasSession, sendSpecialKey, killSession: tmuxKillSession } =
        await import('@/lib/tmux/tmux');
      const { invalidateCache } = await import('@/lib/tmux/tmux-capture-cache');
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(tmuxKillSession).mockResolvedValue(false);

      await tool.killSession('test-wt');

      expect(sendSpecialKey).not.toHaveBeenCalled();
      expect(invalidateCache).toHaveBeenCalledWith(SESSION);
    });
  });
});
