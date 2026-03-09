import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WebSocket } from 'ws';
import { getTmuxControlModeMetrics, resetTmuxControlModeMetrics } from '@/lib/tmux-control-mode-metrics';

const mockGetWorktreeById = vi.fn();
const mockGetTool = vi.fn();
const mockIsCliToolType = vi.fn();
const mockIsTmuxControlModeEnabled = vi.fn();
const mockSubscribe = vi.fn();
const mockSendInput = vi.fn();
const mockResize = vi.fn();
const mockGetSubscriberCount = vi.fn();
const mockCaptureSnapshot = vi.fn();

vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: (...args: unknown[]) => mockGetWorktreeById(...args),
}));

vi.mock('@/lib/cli-tools/types', () => ({
  isCliToolType: (...args: unknown[]) => mockIsCliToolType(...args),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (...args: unknown[]) => mockGetTool(...args),
    }),
  },
}));

vi.mock('@/lib/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: (...args: unknown[]) => mockIsTmuxControlModeEnabled(...args),
}));

vi.mock('@/lib/transports/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    sendInput: (...args: unknown[]) => mockSendInput(...args),
    resize: (...args: unknown[]) => mockResize(...args),
    getSubscriberCount: (...args: unknown[]) => mockGetSubscriberCount(...args),
    captureSnapshot: (...args: unknown[]) => mockCaptureSnapshot(...args),
  }),
}));

function createMockWebSocket(): { ws: WebSocket; sendMock: Mock } {
  const sendMock = vi.fn();
  const ws = {
    readyState: 1,
    send: sendMock,
  } as unknown as WebSocket;
  return { ws, sendMock };
}

describe('ws-server terminal handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTmuxControlModeMetrics();
    mockGetWorktreeById.mockReturnValue({ id: 'wt-1' });
    mockIsCliToolType.mockReturnValue(true);
    mockIsTmuxControlModeEnabled.mockReturnValue(true);
    mockGetTool.mockReturnValue({
      getSessionName: vi.fn(() => 'session-wt-1-codex'),
    });
    mockGetSubscriberCount.mockReturnValue(0);
    mockSubscribe.mockResolvedValue({
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    mockSendInput.mockResolvedValue(undefined);
    mockResize.mockResolvedValue(undefined);
    mockCaptureSnapshot.mockResolvedValue('');
  });

  it('rejects subscribe from an unregistered websocket client', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();
    __internal.resetStateForTest();

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_error',
      error: 'Unauthorized WebSocket client',
    }));
  });

  it('rejects subscribe when session subscriber limit is reached', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);
    mockGetSubscriberCount.mockReturnValue(4);

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_error',
      error: 'Terminal subscriber limit reached',
    }));
  });

  it('rejects terminal input beyond the configured payload limit', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    await __internal.handleTerminalInput(ws, {
      type: 'terminal_input',
      data: 'x'.repeat(4097),
    });

    expect(mockSendInput).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenLastCalledWith(JSON.stringify({
      type: 'terminal_error',
      error: 'Invalid terminal input',
    }));
  });

  it('records first output latency only once per subscription', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);

    let onOutput: ((data: string) => void) | undefined;
    mockSubscribe.mockImplementation(async (
      _sessionName: string,
      handlers: { onOutput: (data: string) => void }
    ) => {
      onOutput = handlers.onOutput;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    });

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000);
    nowSpy.mockReturnValueOnce(1035);

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    onOutput?.('first');
    onOutput?.('second');

    expect(getTmuxControlModeMetrics().firstOutputLatency).toEqual({
      count: 1,
      lastMs: 35,
      minMs: 35,
      maxMs: 35,
      avgMs: 35,
    });

    nowSpy.mockRestore();
  });

  it('rejects subscribe when worktree is not found', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);
    mockGetWorktreeById.mockReturnValueOnce(null);

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'missing-worktree',
      cliToolId: 'codex',
    });

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_error',
      error: 'Worktree not found',
    }));
  });

  it('cleans up terminal subscription on disconnect', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);

    const unsubscribeMock = vi.fn().mockResolvedValue(undefined);
    mockSubscribe.mockResolvedValueOnce({
      unsubscribe: unsubscribeMock,
    });

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    expect(__internal.getClientInfoForTest(ws)?.terminalSubscription).not.toBeNull();

    __internal.handleDisconnect(ws);

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(__internal.getClientInfoForTest(ws)).toBeUndefined();
  });

  it('falls back to snapshot output when the control stream emits an error', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();
    __internal.resetStateForTest();
    __internal.registerClientForTest(ws);

    let onError: ((error: Error) => void) | undefined;
    mockSubscribe.mockImplementation(async (
      _sessionName: string,
      handlers: { onError: (error: Error) => void }
    ) => {
      onError = handlers.onError;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    });
    mockCaptureSnapshot.mockResolvedValueOnce('snapshot output');

    await __internal.handleTerminalSubscribe(ws, {
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    });

    onError?.(new Error('parser failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCaptureSnapshot).toHaveBeenCalledWith('session-wt-1-codex', { startLine: -200 });
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_output',
      data: 'snapshot output',
      fallback: true,
    }));
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_error',
      error: 'parser failed',
      fallback: true,
    }));
  });
});
