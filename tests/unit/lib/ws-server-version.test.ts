/**
 * Unit tests for the WebSocket version handshake (#1338 / #1356).
 *
 * The client announces its bundle version on connect; the server replies with a
 * `version_mismatch` event only when its runtime version has genuinely drifted.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WebSocket } from 'ws';
import { VERSION_MISMATCH_EVENT_TYPE } from '@/lib/realtime/types';

const mockGetServerVersion = vi.fn(() => '0.10.3');

vi.mock('@/lib/version-checker', () => ({
  getServerVersion: () => mockGetServerVersion(),
}));

// Keep ws-server's transitive server-only imports inert (mirrors ws-server-terminal.test.ts).
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: vi.fn() }) },
}));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: vi.fn(() => false),
}));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({}),
}));

function createMockWebSocket(readyState = 1): { ws: WebSocket; sendMock: Mock } {
  const sendMock = vi.fn();
  const ws = { readyState, send: sendMock } as unknown as WebSocket;
  return { ws, sendMock };
}

describe('ws-server version handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerVersion.mockReturnValue('0.10.3');
  });

  it('replies with version_mismatch when the client bundle has drifted', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();

    __internal.handleClientVersion(ws, { type: 'client_version', version: '0.10.0' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendMock.mock.calls[0][0] as string)).toEqual({
      type: VERSION_MISMATCH_EVENT_TYPE,
      serverVersion: '0.10.3',
      clientVersion: '0.10.0',
    });
  });

  it('routes a client_version message through handleMessage', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();

    __internal.handleMessage(ws, { type: 'client_version', version: '0.10.0' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendMock.mock.calls[0][0] as string)).toMatchObject({
      type: VERSION_MISMATCH_EVENT_TYPE,
    });
  });

  it('stays silent when versions match (no false positive)', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();

    __internal.handleClientVersion(ws, { type: 'client_version', version: '0.10.3' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('stays silent when the server version is an unknown fallback', async () => {
    const { __internal } = await import('@/lib/ws-server');
    mockGetServerVersion.mockReturnValue('0.0.0');
    const { ws, sendMock } = createMockWebSocket();

    __internal.handleClientVersion(ws, { type: 'client_version', version: '0.10.0' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('ignores a hello with no version', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket();

    __internal.handleClientVersion(ws, { type: 'client_version' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not send on a socket that is no longer open', async () => {
    const { __internal } = await import('@/lib/ws-server');
    const { ws, sendMock } = createMockWebSocket(3 /* CLOSED */);

    __internal.handleClientVersion(ws, { type: 'client_version', version: '0.10.0' });

    expect(sendMock).not.toHaveBeenCalled();
  });
});
