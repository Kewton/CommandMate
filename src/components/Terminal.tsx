/**
 * Web Terminal Component
 * Browser-based terminal interface using xterm.js
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { isTmuxControlModeEnabledForClient } from '@/lib/tmux/tmux-control-mode-flags';

interface TerminalComponentProps {
  worktreeId: string;
  cliToolId: string;
  className?: string;
  controlModeEnabled?: boolean;
}

type ConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

const RECONNECT_DELAY_MS = 1000;

export function TerminalComponent({
  worktreeId,
  cliToolId,
  className = '',
  controlModeEnabled,
}: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm.js terminal
    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f48771',
        green: '#89d185',
        yellow: '#f4bf75',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#d4d4d4',
        brightBlack: '#5a5a5a',
        brightRed: '#f07178',
        brightGreen: '#c3e88d',
        brightYellow: '#f78c6c',
        brightBlue: '#82aaff',
        brightMagenta: '#c792ea',
        brightCyan: '#89ddff',
        brightWhite: '#ffffff',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
      convertEol: true,
    });

    // Add addons
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Open terminal in the DOM
    term.open(terminalRef.current);
    fitAddon.fit();

    let ws: WebSocket | null = null;
    let isDisposed = false;

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_resize',
          cols: term.cols,
          rows: term.rows,
        }));
      }
    };
    window.addEventListener('resize', handleResize);

    setTerminal(term);

    const isControlModeEnabled = controlModeEnabled ?? isTmuxControlModeEnabledForClient();

    if (!isControlModeEnabled) {
      setConnectionStatus('disabled');
      term.write('\x1b[33m⚠ Tmux control mode is disabled; live terminal streaming is unavailable.\x1b[0m\r\n');
      return () => {
        window.removeEventListener('resize', handleResize);
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        term.dispose();
      };
    }

    // Connect to the app WebSocket and subscribe to terminal stream events.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    setConnectionStatus('connecting');
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'terminal_subscribe',
        worktreeId,
        cliToolId,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          type: string;
          data?: string;
          error?: string;
          connected?: boolean;
        };

        if (message.type === 'terminal_output' && message.data) {
          term.write(message.data);
        } else if (message.type === 'terminal_status') {
          setConnectionStatus(message.connected ? 'connected' : 'disconnected');
          if (message.connected) {
            term.write('\x1b[32m✓ Connected to terminal\x1b[0m\r\n');
            ws.send(JSON.stringify({
              type: 'terminal_resize',
              cols: term.cols,
              rows: term.rows,
            }));
          } else {
            term.write('\x1b[33m⚠ Terminal disconnected\x1b[0m\r\n');
          }
        } else if (message.type === 'terminal_error') {
          setConnectionStatus('error');
          term.write(`\x1b[31m✗ ${message.error || 'Terminal error'}\x1b[0m\r\n`);
        }
      } catch {
        term.write(event.data);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnectionStatus('error');
      term.write('\x1b[31m✗ Connection error\x1b[0m\r\n');
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected');
      term.write('\x1b[33m⚠ Disconnected from terminal\x1b[0m\r\n');
      if (!isDisposed && reconnectTimerRef.current === null) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          setReconnectAttempt((current) => current + 1);
        }, RECONNECT_DELAY_MS);
      }
    };

    setSocket(ws);

    // Handle terminal input
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_input',
          data,
        }));
      }
    });

    // Cleanup
    return () => {
      isDisposed = true;
      window.removeEventListener('resize', handleResize);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_unsubscribe' }));
      }
      ws?.close();
      term.dispose();
    };
  }, [worktreeId, cliToolId, controlModeEnabled, reconnectAttempt]);

  const statusMeta: Record<ConnectionStatus, { dot: string; label: string; detail: string }> = {
    disabled: {
      dot: 'bg-amber-500',
      label: 'Snapshot Fallback',
      detail: 'Control mode is disabled for this client.',
    },
    connecting: {
      dot: 'bg-yellow-500',
      label: 'Connecting',
      detail: reconnectAttempt > 0
        ? 'Reconnecting to terminal stream.'
        : 'Waiting for terminal stream subscription.',
    },
    connected: {
      dot: 'bg-green-500',
      label: 'Live',
      detail: 'Interactive tmux control mode is active.',
    },
    disconnected: {
      dot: 'bg-red-500',
      label: 'Disconnected',
      detail: 'Terminal stream is not connected.',
    },
    error: {
      dot: 'bg-red-500',
      label: 'Error',
      detail: 'Terminal stream encountered an error.',
    },
  };

  const status = statusMeta[connectionStatus];

  // Send command to terminal
  const sendCommand = (command: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'terminal_input',
        data: command + '\n'
      }));
    }
  };

  // Clear terminal
  const clearTerminal = () => {
    if (terminal) {
      terminal.clear();
    }
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 text-white">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${status.dot}`} />
          <span className="text-sm font-mono">
            {cliToolId} - {worktreeId}
          </span>
          <span className="rounded border border-gray-600 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300">
            {status.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearTerminal}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
          >
            Clear
          </button>
          <button
            onClick={() => sendCommand('clear')}
            disabled={connectionStatus !== 'connected'}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear Screen
          </button>
        </div>
      </div>

      {/* Terminal Container */}
      <div
        ref={terminalRef}
        className="flex-1 bg-gray-900 p-2"
      />

      <div className="border-t border-gray-700 bg-gray-900 px-4 py-2 text-xs text-gray-400">
        {status.detail}
      </div>

      {/* Quick Commands */}
      <div className="px-4 py-2 bg-gray-800 border-t border-gray-700">
        <div className="flex gap-2">
          <button
            onClick={() => sendCommand('ls -la')}
            disabled={connectionStatus !== 'connected'}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:cursor-not-allowed disabled:opacity-50"
          >
            ls -la
          </button>
          <button
            onClick={() => sendCommand('git status')}
            disabled={connectionStatus !== 'connected'}
            className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded disabled:cursor-not-allowed disabled:opacity-50"
          >
            git status
          </button>
          <button
            onClick={() => sendCommand('pwd')}
            disabled={connectionStatus !== 'connected'}
            className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded disabled:cursor-not-allowed disabled:opacity-50"
          >
            pwd
          </button>
        </div>
      </div>
    </div>
  );
}
