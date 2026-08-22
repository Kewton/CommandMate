/**
 * Unit tests for OpenCodeTool
 * Issue #379: OpenCode CLI tool implementation
 * Issue #1763: structured events — `--port`, the generation fence and the
 * subscription lifecycle around the unchanged tmux pane handling.
 */

import { afterAll, afterEach, describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  OpenCodeTool,
  OPENCODE_EXIT_COMMAND,
  OPENCODE_PANE_HEIGHT,
  OPENCODE_READY_MAX_ATTEMPTS,
  OPENCODE_READY_POLL_INTERVAL_MS,
} from '@/lib/cli-tools/opencode';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

// Mock tmux module
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  // Issue #1908: the launch path polls the pane instead of sleeping 15 s.
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  // Issue #1905: `/exit` is typed and submitted as two tmux commands.
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

// Mock opencode-config module
vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

// Mock submit-verified sender (Issue #1471: shared body/Enter + submit verification)
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process (exec for BaseCLITool.isInstalled(), execFile for OpenCodeTool.startSession())
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue(undefined),
  };
});

// Issue #1763: the event pipeline is stubbed so no port is bound and no socket
// is opened. `prepareAgentLaunch` below is deliberately NOT stubbed — the
// command that reaches the pane is the thing under test.
vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/session/agent-session-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/agent-session-lifecycle')>();
  return { ...actual, beginAgentSession: vi.fn(actual.beginAgentSession) };
});

import {
  hasSession,
  createSession,
  capturePane,
  sendKeys,
  sendSpecialKeys,
  killSession,
} from '@/lib/tmux/tmux';
import { ensureOpencodeConfig } from '@/lib/cli-tools/opencode-config';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import {
  attachOpencodeEventStream,
  releaseOpencodeEventStream,
  reserveOpencodeServerPort,
  resumeOpencodeEventStream,
} from '@/lib/hooks/sources/opencode/runtime';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-tool-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

describe('OpenCodeTool', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetOpencodePortAssignments();
    // Never the operator's home directory.
    vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
    // `clearAllMocks` clears calls but keeps implementations, so the pipeline
    // stubs are re-stated here — a test that made one reserve a port would
    // otherwise leak it into every test that follows.
    vi.mocked(reserveOpencodeServerPort).mockResolvedValue(null);
    vi.mocked(attachOpencodeEventStream).mockResolvedValue(false);
    vi.mocked(resumeOpencodeEventStream).mockResolvedValue(false);
    vi.mocked(releaseOpencodeEventStream).mockResolvedValue(undefined);
    // Issue #1908: the default frame is a ready one, so the launch tests below
    // leave `waitForReady` on its first attempt. The polling itself is pinned in
    // tests/unit/cli-tools/opencode-launch-readiness-1908.test.ts.
    vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());
    tool = new OpenCodeTool();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetOpencodePortAssignments();
  });

  describe('properties', () => {
    it('should have id = "opencode"', () => {
      expect(tool.id).toBe('opencode');
    });

    it('should have name = "OpenCode"', () => {
      expect(tool.name).toBe('OpenCode');
    });

    it('should have command = "opencode"', () => {
      expect(tool.command).toBe('opencode');
    });
  });

  describe('constants', () => {
    it('should export OPENCODE_EXIT_COMMAND as /exit [D1-006]', () => {
      expect(OPENCODE_EXIT_COMMAND).toBe('/exit');
    });

    it('polls for readiness over a 30-second window instead of sleeping (#1908)', () => {
      // The old `OPENCODE_INIT_WAIT_MS = 15000` was removed, not retuned: no
      // fixed number is right when the composer lands at 3 s idle and at 24 s
      // under load. What is pinned instead is the window the poll covers.
      expect(OPENCODE_READY_POLL_INTERVAL_MS).toBe(500);
      expect(OPENCODE_READY_MAX_ATTEMPTS).toBe(60);
      expect(OPENCODE_READY_POLL_INTERVAL_MS * OPENCODE_READY_MAX_ATTEMPTS).toBe(30_000);
    });

    it('should export OPENCODE_PANE_HEIGHT as 200', () => {
      expect(OPENCODE_PANE_HEIGHT).toBe(200);
    });
  });

  describe('getSessionName()', () => {
    it('should return mcbd-opencode-{worktreeId} format', () => {
      const sessionName = tool.getSessionName('test-123');
      expect(sessionName).toBe('mcbd-opencode-test-123');
    });
  });

  describe('isRunning()', () => {
    it('should delegate to hasSession()', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      const result = await tool.isRunning('test-123');
      expect(result).toBe(true);
      expect(hasSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      const result = await tool.isRunning('test-123');
      expect(result).toBe(false);
    });
  });

  describe('startSession()', () => {
    it('should skip if session already exists', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.startSession('test-123', '/test/path');

      expect(createSession).not.toHaveBeenCalled();
    });

    it('resumes the event stream on the reuse path without a new generation', async () => {
      // Issue #1763: the pane outlived this CommandMate process. Its opencode
      // server is still listening, so the subscription is recovered — but the
      // generation is NOT bumped, because it is the same pane and fencing here
      // would discard a still-valid verdict on every reconnect.
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.startSession('test-123', '/test/path');

      expect(resumeOpencodeEventStream).toHaveBeenCalledWith(
        { worktreeId: 'test-123', cliToolId: 'opencode', instanceId: undefined },
        '/test/path'
      );
      expect(beginAgentSession).not.toHaveBeenCalled();
    });

    it('opens a new event generation before the pane is created', async () => {
      // Issue #1759 S8 / #1763. Mutation target: deleting this call lets the
      // previous opencode process's last event decide the new session's status
      // — a freshly started pane publishing `running` before anybody typed.
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(ensureOpencodeConfig).mockResolvedValue({
        written: false,
        configPath: null,
        reason: 'disabled',
      });

      vi.useFakeTimers();
      void tool.startSession('test-123', '/test/path', 'opencode-2');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(beginAgentSession).toHaveBeenCalledWith({
        worktreeId: 'test-123',
        cliToolId: 'opencode',
        instanceId: 'opencode-2',
      });
      // Before the pane exists, so no window has a live pane judged against a
      // stale generation.
      expect(vi.mocked(beginAgentSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(createSession).mock.invocationCallOrder[0]
      );
    });

    it('launches with --port once a port has been reserved', async () => {
      // The whole of the launch change (#1758 §5.1.2): the plain TUI is the
      // HTTP server, so there is no `serve` process to start and no `attach`.
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(ensureOpencodeConfig).mockResolvedValue({
        written: false,
        configPath: null,
        reason: 'disabled',
      });
      vi.mocked(reserveOpencodeServerPort).mockImplementation(async (target) => {
        rememberOpencodePort(target, 4242, '/test/path');
        return 4242;
      });

      vi.useFakeTimers();
      void tool.startSession('test-123', '/test/path');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(sendKeys).toHaveBeenCalledWith(
        'mcbd-opencode-test-123',
        `'opencode' --port 4242 --hostname 127.0.0.1`,
        true
      );
      expect(attachOpencodeEventStream).toHaveBeenCalled();
    });

    it('launches the bare TUI when CM_AGENT_HOOKS_INJECT=0', async () => {
      // The rollback. Byte-for-byte the pre-#1763 command, even with a port
      // recorded, so an operator who turns structured events off gets the old
      // behaviour rather than a half-configured one.
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(ensureOpencodeConfig).mockResolvedValue({
        written: false,
        configPath: null,
        reason: 'disabled',
      });
      rememberOpencodePort(
        { worktreeId: 'test-123', cliToolId: 'opencode' },
        4242,
        '/test/path'
      );
      vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');

      vi.useFakeTimers();
      void tool.startSession('test-123', '/test/path');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', 'opencode', true);
    });

    it('should create session and start opencode TUI', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(ensureOpencodeConfig).mockResolvedValue({
        written: false,
        configPath: null,
        reason: 'disabled',
      });

      // Speed up test by mocking setTimeout
      vi.useFakeTimers();
      const promise = tool.startSession('test-123', '/test/path');
      // Advance through all setTimeout calls
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      // Verify ensureOpencodeConfig was called
      expect(ensureOpencodeConfig).toHaveBeenCalledWith('/test/path');

      // Verify createSession was called with correct options
      expect(createSession).toHaveBeenCalledWith({
        sessionName: 'mcbd-opencode-test-123',
        workingDirectory: '/test/path',
        // Issue #1624: `historyLimit: 50000` used to be passed here and at the
        // six other call sites. They now omit it so scrollback depth comes from
        // the single TMUX_HISTORY_LIMIT default, which tmux.test.ts and
        // tmux-history-limit.live.test.ts pin. Re-adding it here would let a
        // call site drift back to a hardcoded value unnoticed.
      });

      // Verify opencode command was sent. Issue #1763: with no port reserved
      // (the stub above answers null) this stays the pre-#1763 bare command.
      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', 'opencode', true);
    });
  });

  describe('sendMessage()', () => {
    it('should throw if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendMessage('test-123', 'hello'))
        .rejects.toThrow('does not exist');
    });

    it('should delegate sending to the submit-verified sender', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.sendMessage('test-123', 'hello');

      // Issue #1471: opencode delegates body/Enter separation + submit verification.
      expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionName: 'mcbd-opencode-test-123',
          message: 'hello',
          cliToolId: 'opencode',
        })
      );
    });

    it('should apply submit verification to multi-line messages', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.sendMessage('test-123', 'line1\nline2');

      expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionName: 'mcbd-opencode-test-123',
          message: 'line1\nline2',
          cliToolId: 'opencode',
        })
      );
    });

    it('should apply submit verification to single-line messages too (no `\\n` gate)', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.sendMessage('test-123', 'single line');

      // The old `message.includes('\n')` gate is gone — every message is verified.
      expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
      expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'single line', cliToolId: 'opencode' })
      );
    });
  });

  describe('killSession()', () => {
    it('should send /exit and then kill session if still running [D1-006]', async () => {
      vi.mocked(hasSession)
        .mockResolvedValueOnce(true)   // First check: session exists
        .mockResolvedValueOnce(true);  // Second check: still exists after /exit
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(killSession).mockResolvedValue(true);

      await tool.killSession('test-123');

      // Should send /exit command
      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', OPENCODE_EXIT_COMMAND, false);
      // Should fall back to kill-session
      expect(killSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    /**
     * Issue #1905, measured on opencode 1.18.21: `send-keys '/exit' C-m` in a
     * single tmux command does not exit — `/` opens the command palette and the
     * batched `C-m` is eaten by it, so the TUI sits there with `/exit` typed
     * (still up 10.8 s later, 2 runs of 2). Sent as body-then-Enter it exits in
     * ~0.45 s. The order matters as much as the split, so both are pinned.
     */
    it('types /exit and submits it with a separate Enter, in that order', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
      vi.mocked(killSession).mockResolvedValue(true);

      await tool.killSession('test-123');

      // The body must never carry the Enter with it.
      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', OPENCODE_EXIT_COMMAND, false);
      expect(sendKeys).not.toHaveBeenCalledWith(
        'mcbd-opencode-test-123',
        OPENCODE_EXIT_COMMAND,
        true
      );
      expect(sendSpecialKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', ['Enter']);
      expect(vi.mocked(sendKeys).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sendSpecialKeys).mock.invocationCallOrder[0]
      );
    });

    it('should not kill if /exit successfully terminated the session', async () => {
      vi.mocked(hasSession)
        .mockResolvedValueOnce(true)   // First check: session exists
        .mockResolvedValueOnce(false); // Second check: session gone after /exit
      vi.mocked(sendKeys).mockResolvedValue(undefined);

      await tool.killSession('test-123');

      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', OPENCODE_EXIT_COMMAND, false);
      expect(killSession).not.toHaveBeenCalled();
    });

    it('should handle non-existent session gracefully', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(killSession).mockResolvedValue(false);

      await tool.killSession('test-123');
      // When session doesn't exist, killSession (tmux) is still called as cleanup
      expect(killSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    it('releases the event stream and the port before the pane goes', async () => {
      // Issue #1763: the server's lifetime is the pane's, so a stream left open
      // would reconnect at a port that is about to be free — and a port left
      // recorded would be handed to the next instance as "already ours".
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(killSession).mockResolvedValue(false);

      await tool.killSession('test-123', 'opencode-2');

      expect(releaseOpencodeEventStream).toHaveBeenCalledWith({
        worktreeId: 'test-123',
        cliToolId: 'opencode',
        instanceId: 'opencode-2',
      });
      expect(vi.mocked(releaseOpencodeEventStream).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(killSession).mock.invocationCallOrder[0]
      );
    });
  });
});
