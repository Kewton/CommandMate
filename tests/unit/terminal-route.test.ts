/**
 * Unit tests for terminal/route.ts
 * Issue #393: Security hardening - input validation and fixed-string errors
 *
 * Issue #1906 moved the send itself onto `ICLITool.sendMessage`, so the mocks
 * below drive the tool rather than tmux. `sendKeys` / `sendSpecialKeys` /
 * `sendMessageWithSubmitVerification` stay mocked purely as negative controls:
 * the route reaching any of them again is the bypass coming back.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@/lib/cli-tools/types', () => ({
  isCliToolType: vi.fn((value: string) => ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot'].includes(value)),
  isValidInstanceId: vi.fn((value: string) => /^[A-Za-z0-9._-]+$/.test(value)),
}));

const mockSendMessage = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: vi.fn((id: string) => ({
        getSessionName: vi.fn((worktreeId: string) => `mcbd-${id}-${worktreeId}`),
        sendMessage: mockSendMessage,
        isRunning: mockIsRunning,
      })),
    })),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

// Issue #1925: the route resolves (tool, instance) through the shared authority.
vi.mock('@/lib/session/resolve-session-target', () => ({
  resolveSessionTargetStrict: vi.fn((_db: unknown, _id: string, opts: { requestedCliTool: string }) => ({
    ok: true,
    target: { cliToolId: opts.requestedCliTool },
  })),
  describeSessionTargetConflict: vi.fn(() => 'conflict'),
  INSTANCE_TOOL_CONFLICT: 'instance_tool_conflict',
}));

// Issue #1906: the prompt guard the route now consults before typing.
const mockIsPromptWaiting = vi.fn();
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: (...args: unknown[]) => mockIsPromptWaiting(...args),
  promptWaitingMessage: vi.fn(() => 'wt-1 is waiting on a prompt.'),
  PROMPT_WAITING_CODE: 'PROMPT_WAITING',
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/worktrees/[id]/terminal/route';
import { getWorktreeById } from '@/lib/db';
import { hasSession, sendKeys } from '@/lib/tmux/tmux';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { isCliToolType } from '@/lib/cli-tools/types';

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/terminal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultParams = { params: Promise.resolve({ id: 'wt-1' }) };

describe('POST /api/worktrees/[id]/terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1', name: 'test', path: '/path' } as ReturnType<typeof getWorktreeById>);
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendMessageWithSubmitVerification).mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue(undefined);
    mockIsRunning.mockResolvedValue(true);
    mockIsPromptWaiting.mockResolvedValue({ waiting: false });
  });

  it('should send command successfully with valid cliToolId (delegated to ICLITool.sendMessage)', async () => {
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Issue #1906: the route delegates rather than driving tmux itself. #1470's
    // body/Enter separation and read-back verification still happen — inside
    // `ClaudeTool.sendMessage`, which is where every other caller gets them.
    expect(mockSendMessage).toHaveBeenCalledWith('wt-1', 'echo hello', undefined);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
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
    mockIsRunning.mockResolvedValue(false);
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(404);
    // R4F007: Fixed-string error
    expect(json.error).toBe('Session not found. Use startSession API to create a session first.');
    // R3F001: Verify createSession is NOT called
    expect(sendKeys).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
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
    mockSendMessage.mockRejectedValue(new Error('internal tmux failure'));
    const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(500);
    // R4F002: Fixed-string error, no error.message exposure
    expect(json.error).toBe('Failed to send command to terminal');
    expect(json.error).not.toContain('internal tmux failure');
  });

  // Issue #1470: an unconfirmed submit must NOT be reported as success.
  it('should NOT return { success: true } when submit cannot be confirmed', async () => {
    mockSendMessage.mockRejectedValue(
      new Error('Message submit could not be confirmed (typed but unsent)')
    );
    const req = createRequest({ cliToolId: 'codex', command: 'a long typed-but-unsent message' });
    const res = await POST(req, defaultParams);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBeUndefined();
    expect(json.error).toBe('Failed to send command to terminal');
  });

  /**
   * Issue #1906. This route special-cased copilot the same way
   * `send-user-message.ts` did: `command.replace(/\n+/g, ' ')`, a raw
   * `sendKeys`, a 200 ms sleep, a bare `Enter`. `CopilotTool.sendMessage` — with
   * `waitForPrompt` (#1886's folder-trust answer), `SELECTION_LIST_COMMANDS`
   * (#1895) and #1471's read-back submit verification — was unreachable from
   * here, so an Enter copilot swallowed still returned `{ success: true }`.
   */
  describe('Copilot goes through CopilotTool.sendMessage (#1906)', () => {
    it('delegates a copilot slash command instead of typing it with sendKeys', async () => {
      const req = createRequest({ cliToolId: 'copilot', command: '/model' });
      const res = await POST(req, defaultParams);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', '/model', undefined);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('delegates copilot regular text instead of typing it with sendKeys', async () => {
      const req = createRequest({ cliToolId: 'copilot', command: 'hello world' });
      const res = await POST(req, defaultParams);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', 'hello world', undefined);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('keeps a copilot message multi-line (the flattening is gone)', async () => {
      const body = 'line one\nline two\nline three';
      const req = createRequest({ cliToolId: 'copilot', command: body });
      const res = await POST(req, defaultParams);

      expect(res.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', body, undefined);
      const sent = mockSendMessage.mock.calls[0][1] as string;
      expect(sent).toContain('\n');
      expect(sent).not.toBe('line one line two line three');
    });

    it('reports a copilot send failure as 500, never as success', async () => {
      mockSendMessage.mockRejectedValue(
        new Error('Failed to send message to Copilot: Message submit could not be confirmed')
      );
      const req = createRequest({ cliToolId: 'copilot', command: 'hello world' });
      const res = await POST(req, defaultParams);
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.success).toBeUndefined();
      expect(json.error).toBe('Failed to send command to terminal');
    });

    it('delegates every other tool too (no batched send-keys anywhere)', async () => {
      const req = createRequest({ cliToolId: 'claude', command: '/model' });
      const res = await POST(req, defaultParams);

      expect(res.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', '/model', undefined);
      expect(sendKeys).not.toHaveBeenCalled();
      expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    });
  });

  /**
   * Issue #1906 item 3. `sendUserMessage` has refused to type into an open
   * dialog since #1708/#1737; this route did not, so a Review-screen message
   * sent while a permission dialog was up landed in the DIALOG's input line —
   * lost, and left there for the next `respond` to deliver as an answer.
   */
  describe('prompt guard (#1906)', () => {
    it('refuses with 409 + PROMPT_WAITING and types nothing', async () => {
      mockIsPromptWaiting.mockResolvedValue({ waiting: true, reason: 'claude_prompt', blockedBy: 'scraper' });
      const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
      const res = await POST(req, defaultParams);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe('PROMPT_WAITING');
      expect(json.success).toBeUndefined();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('consults the guard for the RESOLVED instance, not just the tool', async () => {
      const req = createRequest({ cliToolId: 'codex', command: 'echo hello', instanceId: 'codex-2' });
      await POST(req, defaultParams);

      expect(mockIsPromptWaiting).toHaveBeenCalledWith('wt-1', 'codex', 'codex-2');
    });

    it('sends normally when the guard says nothing is waiting', async () => {
      const req = createRequest({ cliToolId: 'claude', command: 'echo hello' });
      const res = await POST(req, defaultParams);

      expect(res.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalled();
    });
  });
});
