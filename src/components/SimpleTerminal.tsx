/**
 * Simple Terminal Component
 * Terminal interface using existing API endpoints (no WebSocket required)
 */

'use client';

import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { Send, Terminal, RefreshCw, Trash2 } from 'lucide-react';

interface SimpleTerminalProps {
  worktreeId: string;
  cliToolId: string;
}

export function SimpleTerminal({ worktreeId, cliToolId }: SimpleTerminalProps) {
  const [output, setOutput] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // Capture current terminal output
  const captureOutput = async () => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliToolId }),
      });

      if (response.ok) {
        const data = await response.json();
        setOutput(data.output || '');

        // Auto-scroll to bottom
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
      }
    } catch (error) {
      console.error('Failed to capture output:', error);
    }
  };

  // Send command to terminal
  const sendCommand = async (command: string) => {
    if (!command.trim()) return;

    setIsLoading(true);

    // Add to history
    setCommandHistory(prev => [...prev, command]);
    setHistoryIndex(-1);

    try {
      // Send command via tmux send-keys
      const response = await fetch(`/api/worktrees/${worktreeId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cliToolId,
          command,
        }),
      });

      if (response.ok) {
        setInput('');

        // Wait a bit for command to execute then capture output
        setTimeout(async () => {
          await captureOutput();
          setIsLoading(false);
        }, 500);
      } else {
        setIsLoading(false);
        console.error('Failed to send command');
      }
    } catch (error) {
      setIsLoading(false);
      console.error('Error sending command:', error);
    }
  };

  // Handle keyboard events
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      sendCommand(input);
    } else if (e.key === 'ArrowUp') {
      // Navigate command history up
      if (commandHistory.length > 0) {
        const newIndex = historyIndex === -1
          ? commandHistory.length - 1
          : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      // Navigate command history down
      if (historyIndex !== -1) {
        const newIndex = Math.min(commandHistory.length - 1, historyIndex + 1);
        if (newIndex === commandHistory.length - 1) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        }
      }
    }
  };

  // Clear terminal output
  const clearOutput = () => {
    setOutput('');
  };

  // Send Ctrl+C to interrupt
  const sendInterrupt = async () => {
    try {
      await fetch(`/api/worktrees/${worktreeId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cliToolId,
          command: '\x03', // Ctrl+C
        }),
      });
      setTimeout(captureOutput, 500);
    } catch (error) {
      console.error('Failed to send interrupt:', error);
    }
  };

  // Initial capture on mount
  useEffect(() => {
    captureOutput();

    // Auto-refresh every 3 seconds
    const interval = setInterval(captureOutput, 3000);

    return () => clearInterval(interval);
  }, [worktreeId, cliToolId]);

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-100">
      {/* Terminal Output */}
      <div className="flex-1 overflow-hidden">
        <pre
          ref={outputRef}
          className="h-full p-4 font-mono text-sm overflow-auto whitespace-pre-wrap bg-black text-green-400"
          style={{
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            lineHeight: '1.5',
          }}
        >
          {output || 'Terminal output will appear here...'}
        </pre>
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-700 bg-gray-800 p-4">
        <div className="flex items-center gap-2">
          <Terminal className="text-gray-400" size={20} />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter command..."
            disabled={isLoading}
            className="flex-1 bg-gray-900 text-white px-3 py-2 rounded border border-gray-600 focus:border-blue-500 focus:outline-none font-mono text-sm"
          />

          <button
            onClick={() => sendCommand(input)}
            disabled={isLoading || !input.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded flex items-center gap-2"
          >
            <Send size={16} />
            Send
          </button>

          <button
            onClick={captureOutput}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
            title="Refresh output"
          >
            <RefreshCw size={16} />
          </button>

          <button
            onClick={sendInterrupt}
            className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded"
            title="Send Ctrl+C"
          >
            ^C
          </button>

          <button
            onClick={clearOutput}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
            title="Clear output"
          >
            <Trash2 size={16} />
          </button>
        </div>

        {/* Quick Commands */}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => sendCommand('ls -la')}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            ls -la
          </button>
          <button
            onClick={() => sendCommand('pwd')}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            pwd
          </button>
          <button
            onClick={() => sendCommand('git status')}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            git status
          </button>
          <button
            onClick={() => sendCommand('clear')}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            clear
          </button>
        </div>

        {/* Status */}
        {isLoading && (
          <div className="mt-2 text-xs text-gray-400">
            Executing command...
          </div>
        )}

        {commandHistory.length > 0 && (
          <div className="mt-2 text-xs text-gray-500">
            History: {commandHistory.length} commands • Use ↑/↓ to navigate
          </div>
        )}
      </div>
    </div>
  );
}