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

interface TerminalComponentProps {
  worktreeId: string;
  cliToolId: string;
  className?: string;
}

export function TerminalComponent({
  worktreeId,
  cliToolId,
  className = ''
}: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

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

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    setTerminal(term);

    // Connect to WebSocket for real-time communication
    const ws = new WebSocket(`ws://localhost:3000/terminal/${worktreeId}/${cliToolId}`);

    ws.onopen = () => {
      console.log('Terminal WebSocket connected');
      setIsConnected(true);
      term.write('\x1b[32m✓ Connected to terminal\x1b[0m\r\n');
    };

    ws.onmessage = (event) => {
      // Write terminal output to xterm
      term.write(event.data);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      term.write('\x1b[31m✗ Connection error\x1b[0m\r\n');
    };

    ws.onclose = () => {
      console.log('Terminal WebSocket disconnected');
      setIsConnected(false);
      term.write('\x1b[33m⚠ Disconnected from terminal\x1b[0m\r\n');
    };

    setSocket(ws);

    // Handle terminal input
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'input',
          data: data
        }));
      }
    });

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      ws.close();
      term.dispose();
    };
  }, [worktreeId, cliToolId]);

  // Send command to terminal
  const sendCommand = (command: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'command',
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
          <span className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm font-mono">
            {cliToolId} - {worktreeId}
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
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
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

      {/* Quick Commands */}
      <div className="px-4 py-2 bg-gray-800 border-t border-gray-700">
        <div className="flex gap-2">
          <button
            onClick={() => sendCommand('ls -la')}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            ls -la
          </button>
          <button
            onClick={() => sendCommand('git status')}
            className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded"
          >
            git status
          </button>
          <button
            onClick={() => sendCommand('pwd')}
            className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded"
          >
            pwd
          </button>
        </div>
      </div>
    </div>
  );
}