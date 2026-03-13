/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockOpen = vi.fn();
const mockWrite = vi.fn();
const mockClear = vi.fn();
const mockDispose = vi.fn();
const mockLoadAddon = vi.fn();
const mockOnData = vi.fn();
const mockFit = vi.fn();
const mockIsTmuxControlModeEnabledForClient = vi.fn();

let webSocketInstances: MockWebSocket[] = [];
let terminalDataHandler: ((data: string) => void) | null = null;

class MockTerminal {
  cols = 80;
  rows = 24;

  open = mockOpen;
  write = mockWrite;
  clear = mockClear;
  dispose = mockDispose;
  loadAddon = mockLoadAddon;
  onData = (handler: (data: string) => void) => {
    terminalDataHandler = handler;
    mockOnData(handler);
  };
}

class MockFitAddon {
  fit = mockFit;
}

class MockWebSocket {
  static OPEN = 1;

  readyState = MockWebSocket.OPEN;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    webSocketInstances.push(this);
  }
}

vi.mock('xterm', () => ({
  Terminal: MockTerminal,
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: MockFitAddon,
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: class WebLinksAddon {},
}));

vi.mock('xterm/css/xterm.css', () => ({}));

vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabledForClient: () => mockIsTmuxControlModeEnabledForClient(),
}));

describe('TerminalComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    webSocketInstances = [];
    terminalDataHandler = null;
    mockIsTmuxControlModeEnabledForClient.mockReturnValue(true);
    Object.defineProperty(window, 'WebSocket', {
      writable: true,
      value: MockWebSocket,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not create a websocket when control mode is disabled', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" controlModeEnabled={false} />);

    expect(webSocketInstances).toHaveLength(0);
    expect(screen.getByText('Snapshot Fallback')).toBeInTheDocument();
    expect(screen.getByText('Control mode is disabled for this client.')).toBeInTheDocument();
    expect(mockWrite).toHaveBeenCalledWith(
      '\x1b[33m⚠ Tmux control mode is disabled; live terminal streaming is unavailable.\x1b[0m\r\n'
    );
  });

  it('uses the client feature flag when controlModeEnabled is omitted', async () => {
    mockIsTmuxControlModeEnabledForClient.mockReturnValue(false);
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    expect(webSocketInstances).toHaveLength(0);
    expect(screen.getByText('Snapshot Fallback')).toBeInTheDocument();
  });

  it('subscribes over websocket and updates status on terminal_status', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    expect(webSocketInstances).toHaveLength(1);
    const socket = webSocketInstances[0];
    await act(async () => {
      socket.onopen?.();
    });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_subscribe',
      worktreeId: 'wt-1',
      cliToolId: 'codex',
    }));

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'terminal_status', connected: true }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    expect(mockWrite).toHaveBeenCalledWith('\x1b[32m✓ Connected to terminal\x1b[0m\r\n');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_resize',
      cols: 80,
      rows: 24,
    }));
  });

  it('disables quick commands until the terminal is connected', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const quickCommand = screen.getByRole('button', { name: 'git status' });
    expect(quickCommand).toBeDisabled();

    const socket = webSocketInstances[0];
    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({ type: 'terminal_status', connected: true }),
      });
    });

    await waitFor(() => {
      expect(quickCommand).not.toBeDisabled();
    });

    fireEvent.click(quickCommand);

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_input',
      data: 'git status\n',
    }));
  });

  it('forwards terminal input to the websocket', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const socket = webSocketInstances[0];
    expect(terminalDataHandler).not.toBeNull();

    await act(async () => {
      terminalDataHandler?.('ls -la');
    });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_input',
      data: 'ls -la',
    }));
  });

  it('sends terminal resize events after the stream is connected', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const socket = webSocketInstances[0];
    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({ type: 'terminal_status', connected: true }),
      });
    });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(mockFit).toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'terminal_resize',
      cols: 80,
      rows: 24,
    }));
  });

  it('shows error status when terminal_error is received', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const socket = webSocketInstances[0];
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'terminal_error', error: 'stream failed' }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    expect(mockWrite).toHaveBeenCalledWith('\x1b[31m✗ stream failed\x1b[0m\r\n');
  });

  it('shows disconnected status when the websocket closes', async () => {
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const socket = webSocketInstances[0];
    await act(async () => {
      socket.onclose?.();
    });

    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });

    expect(mockWrite).toHaveBeenCalledWith('\x1b[33m⚠ Disconnected from terminal\x1b[0m\r\n');
  });

  it('reconnects after the websocket closes', async () => {
    vi.useFakeTimers();
    const { TerminalComponent } = await import('@/components/Terminal');

    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);

    const firstSocket = webSocketInstances[0];
    await act(async () => {
      firstSocket.onclose?.();
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(webSocketInstances).toHaveLength(2);
    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.getByText('Reconnecting to terminal stream.')).toBeInTheDocument();

    vi.useRealTimers();
  });
});
