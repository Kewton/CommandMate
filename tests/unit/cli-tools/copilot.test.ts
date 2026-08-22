/**
 * Unit tests for CopilotTool
 * Issue #545: Copilot CLI support
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CopilotTool, COPILOT_EXIT_COMMAND } from '@/lib/cli-tools/copilot';
import { resolveCopilotExecutable } from '@/lib/cli-tools/copilot-executable';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { COPILOT_EXIT_WAIT_MS, TUI_EXIT_WAIT_MS } from '@/config/cli-tool-timing-config';

// Mock child_process execFile so nothing here can spawn a real process
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Issue #1907: install detection is a filesystem probe now (PATH lookup +
// `--version`), so it is stubbed here and exercised for real against temp
// directories in copilot-install-detection-1907.test.ts.
vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

// Mock tmux functions
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  // Issue #1905: the exit command is typed and submitted separately.
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
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

describe('CopilotTool', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    tool = new CopilotTool();
    vi.clearAllMocks();
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('copilot');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Copilot');
    });

    // Issue #1907: was 'gh', from the days when copilot was the `gh-copilot`
    // extension. Copilot CLI is a standalone executable.
    it('should have correct command (copilot)', () => {
      expect(tool.command).toBe('copilot');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('copilot');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-copilot-feature-foo');
    });

    it('should throw error for worktree id with slashes (security)', () => {
      expect(() => tool.getSessionName('feature/issue/123')).toThrow(/Invalid session name format/);
    });
  });

  // Issue #1907: `isInstalled` is now the resolver's answer and nothing else.
  // The resolution rules themselves (PATH first, gh's downloaded copy second,
  // a version string required) live in copilot-install-detection-1907.test.ts,
  // where they run against real temp directories.
  describe('isInstalled', () => {
    it('should return true when a copilot executable answered --version', async () => {
      vi.mocked(resolveCopilotExecutable).mockResolvedValue({
        path: '/usr/local/bin/copilot',
        version: '1.0.80',
        source: 'path',
      });

      await expect(tool.isInstalled()).resolves.toBe(true);
    });

    it('should return false when nothing answered', async () => {
      vi.mocked(resolveCopilotExecutable).mockResolvedValue(null);

      await expect(tool.isInstalled()).resolves.toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      const running = await tool.isRunning('test-worktree');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
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
      expect(tool.id).toBe('copilot');
      expect(tool.name).toBe('Copilot');
      expect(tool.command).toBe('copilot');
    });
  });

  describe('extractSlashCommand (via sendMessage behavior)', () => {
    it('should recognize /model as a selection list command', () => {
      // Access private method via any cast for testing
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/model')).toBe('model');
      expect(extract.call(tool, '/agent')).toBe('agent');
      expect(extract.call(tool, '/theme')).toBe('theme');
    });

    it('should return null for non-slash messages', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, 'hello world')).toBeNull();
      expect(extract.call(tool, '')).toBeNull();
    });

    it('should extract command name from slash command with args', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/help commands')).toBe('help');
      expect(extract.call(tool, '/compact  ')).toBe('compact');
    });
  });

  describe('sendModelCommand', () => {
    it('should be a public method', () => {
      expect(typeof tool.sendModelCommand).toBe('function');
    });

    it('should throw if session does not exist', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendModelCommand('test-wt', 'gpt-5-mini'))
        .rejects.toThrow(/does not exist/);
    });

    it('should send /model command and Enter to session', async () => {
      vi.useFakeTimers();

      const { hasSession, sendKeys, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);
      await promise;

      expect(sendKeys).toHaveBeenCalledWith(
        'mcbd-copilot-test-wt',
        '/model gpt-5-mini',
        true
      );

      vi.useRealTimers();
    });

    it('should never send a bare Enter after an argument-form /model (Issue #1895)', async () => {
      vi.useFakeTimers();

      // `/model <id>` switches in place and prints `● Model changed from … for
      // this session.` — measured on 1.0.80 and captured as
      // `copilot-picker-1895/model-arg-immediate.txt`. No picker is ever drawn.
      //
      // The pane is nonetheless mocked as a picker here, which is the strongest
      // form of the assertion: even if copilot DID somehow show one, the
      // argument form must not answer it on the operator's behalf. The old code
      // waited 5s for exactly this screen and then sent `C-m` into it.
      const { hasSession, capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(
        [
          '   Recommended models',
          ' ❯  Search models…',
          ' ↑/↓ to navigate · enter to select · esc to cancel',
        ].join('\n'),
      );

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);
      await promise.catch(() => undefined);

      expect(sendSpecialKey).not.toHaveBeenCalledWith('mcbd-copilot-test-wt', 'C-m');

      vi.useRealTimers();
    });

    it('should wait for prompt recovery after model switch', async () => {
      vi.useFakeTimers();

      const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);

      await expect(promise).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('waitForSelectionList returns boolean', () => {
    it('should return true when selection list is detected', async () => {
      const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      // The picker's key-hint footer at the bottom of the pane — the only thing
      // `isCopilotSelectionFrame` reads (Issue #1895). `Search models…` alone is
      // deliberately NOT enough any more.
      vi.mocked(capturePane).mockResolvedValue(
        [
          '   Recommended models',
          ' ❯  Search models…',
          ' ↑/↓ to navigate · enter to select · esc to cancel',
        ].join('\n'),
      );

      // Access private method for testing
      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const result = await waitForSelectionList.call(tool, 'mcbd-copilot-test');
      expect(result).toBe(true);
    });

    it('should return false when selection list times out', async () => {
      vi.useFakeTimers();

      const { capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(capturePane).mockResolvedValue('some other output');

      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const promise = waitForSelectionList.call(tool, 'mcbd-copilot-test');

      // Advance timers past the 5s timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await promise;
      expect(result).toBe(false);

      vi.useRealTimers();
    });
  });

  /**
   * Issue #1905. Until this Issue nothing reached this method from the product:
   * `POST /api/worktrees/:id/kill-session` called `lib/tmux`'s `killSession`
   * directly and the Assistant session route (the only other caller) does not
   * allow copilot. Both defects below are therefore first-time regressions,
   * pinned against measurements on GitHub Copilot CLI 1.0.80.
   */
  describe('killSession (Issue #1905)', () => {
    async function runKill(): Promise<{
      sendKeys: ReturnType<typeof vi.fn>;
      sendSpecialKey: ReturnType<typeof vi.fn>;
      sendSpecialKeys: ReturnType<typeof vi.fn>;
      killSession: ReturnType<typeof vi.fn>;
    }> {
      const tmux = await import('@/lib/tmux/tmux');
      vi.mocked(tmux.hasSession).mockResolvedValue(true);
      vi.useFakeTimers();
      const promise = tool.killSession('feature-foo');
      await vi.runAllTimersAsync();
      await promise;
      vi.useRealTimers();
      return tmux as unknown as {
        sendKeys: ReturnType<typeof vi.fn>;
        sendSpecialKey: ReturnType<typeof vi.fn>;
        sendSpecialKeys: ReturnType<typeof vi.fn>;
        killSession: ReturnType<typeof vi.fn>;
      };
    }

    /**
     * The body used to be the bare word `exit` batched with its Enter into one
     * `send-keys exit C-m`. Measured on 1.0.80, that spelling does end the
     * process — the Issue's premise that it only becomes a chat message is
     * wrong for this version — but it is indistinguishable from a prompt and
     * the batched form is the shape #1471 removed everywhere else.
     */
    it('types the slash exit command without batching Enter into it', async () => {
      const { sendKeys } = await runKill();

      expect(sendKeys).toHaveBeenCalledWith('mcbd-copilot-feature-foo', COPILOT_EXIT_COMMAND, false);
      expect(COPILOT_EXIT_COMMAND).toBe('/exit');
      // No `sendEnter: true` batch, and no bare `exit` body, anywhere.
      for (const call of sendKeys.mock.calls) {
        expect(call[2]).toBe(false);
        expect(call[1]).not.toBe('exit');
      }
    });

    it('submits with a separate Enter, after the body and after the interrupt', async () => {
      const { sendSpecialKey, sendSpecialKeys } = await runKill();

      expect(sendSpecialKey).toHaveBeenCalledWith('mcbd-copilot-feature-foo', 'C-c');
      expect(sendSpecialKeys).toHaveBeenCalledWith('mcbd-copilot-feature-foo', ['Enter']);
      expect(sendSpecialKey.mock.invocationCallOrder[0]).toBeLessThan(
        sendSpecialKeys.mock.invocationCallOrder[0]
      );
    });

    /**
     * The wait between the submit and the tmux kill. 11 samples of copilot
     * 1.0.80's shutdown ran 1.006 s to 2.193 s, so the generic
     * `TUI_EXIT_WAIT_MS` (500) guaranteed the kill landed mid-shutdown. Held to
     * the measurement rather than to the constant's identity, so lowering the
     * constant back under a second fails here.
     */
    it('waits longer than the slowest measured shutdown before force-killing', () => {
      expect(COPILOT_EXIT_WAIT_MS).toBeGreaterThan(2193);
      expect(COPILOT_EXIT_WAIT_MS).toBeGreaterThan(TUI_EXIT_WAIT_MS);
    });

    it('still force-kills the tmux session as the fallback', async () => {
      const { killSession } = await runKill();
      expect(killSession).toHaveBeenCalledWith('mcbd-copilot-feature-foo');
    });

    it('does not touch the pane when there is no session to exit', async () => {
      const tmux = await import('@/lib/tmux/tmux');
      vi.mocked(tmux.hasSession).mockResolvedValue(false);

      await tool.killSession('feature-foo');

      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.sendSpecialKeys).not.toHaveBeenCalled();
      expect(tmux.killSession).toHaveBeenCalledWith('mcbd-copilot-feature-foo');
    });
  });
});
