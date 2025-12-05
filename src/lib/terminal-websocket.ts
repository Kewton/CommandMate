/**
 * Terminal WebSocket Handler
 * Bridges browser terminal to tmux sessions
 */

import { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { spawn } from 'child_process';
import * as tmux from './tmux';
import { captureSessionOutput } from './cli-session';
import type { CLIToolType } from './cli-tools/types';

interface TerminalConnection {
  worktreeId: string;
  cliToolId: string;
  ws: any;
  tmuxSession: string;
}

const connections = new Map<string, TerminalConnection>();

/**
 * Get tmux session name for a worktree and CLI tool
 */
function getSessionName(worktreeId: string, cliToolId: string): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}

/**
 * Initialize WebSocket server for terminal connections
 */
export function initTerminalWebSocket(server: any) {
  const wss = new WebSocketServer({
    server,
    path: '/terminal'
  });

  wss.on('connection', async (ws, request: IncomingMessage) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Extract worktreeId and cliToolId from path: /terminal/{worktreeId}/{cliToolId}
    if (pathParts.length < 3) {
      ws.send(JSON.stringify({ error: 'Invalid path format' }));
      ws.close();
      return;
    }

    const worktreeId = pathParts[1];
    const cliToolId = pathParts[2];
    const connectionId = `${worktreeId}-${cliToolId}`;

    console.log(`Terminal WebSocket connected: ${connectionId}`);

    // Store connection
    connections.set(connectionId, {
      worktreeId,
      cliToolId,
      ws,
      tmuxSession: getSessionName(worktreeId, cliToolId)
    });

    // Initial tmux capture to show current state
    try {
      const output = await captureSessionOutput(worktreeId, cliToolId as CLIToolType);
      ws.send(output);
    } catch (error) {
      console.error('Error capturing initial output:', error);
      ws.send('\x1b[31mError: Failed to capture terminal output\x1b[0m\r\n');
    }

    // Handle messages from browser
    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        const connection = connections.get(connectionId);

        if (!connection) {
          console.error('Connection not found:', connectionId);
          return;
        }

        switch (data.type) {
          case 'input':
            // Send user input to tmux session
            await sendToTmux(connection.tmuxSession, data.data);

            // Capture and send back updated output
            setTimeout(async () => {
              try {
                const output = await captureSessionOutput(worktreeId, cliToolId as any, 100);
                ws.send(output);
              } catch (error) {
                console.error('Error capturing output after input:', error);
              }
            }, 100); // Small delay to allow tmux to process
            break;

          case 'command':
            // Execute a complete command
            await sendToTmux(connection.tmuxSession, data.data);

            // Capture output after command execution
            setTimeout(async () => {
              try {
                const output = await captureSessionOutput(worktreeId, cliToolId as any, 100);
                ws.send(output);
              } catch (error) {
                console.error('Error capturing output after command:', error);
              }
            }, 200);
            break;

          case 'refresh':
            // Refresh terminal output
            const output = await captureSessionOutput(worktreeId, cliToolId as CLIToolType);
            ws.send(output);
            break;

          default:
            console.warn('Unknown message type:', data.type);
        }
      } catch (error) {
        console.error('Error handling terminal message:', error);
        ws.send('\x1b[31mError: ' + (error as Error).message + '\x1b[0m\r\n');
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      console.log(`Terminal WebSocket disconnected: ${connectionId}`);
      connections.delete(connectionId);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`Terminal WebSocket error for ${connectionId}:`, error);
    });
  });

  // Periodic refresh for active connections
  setInterval(async () => {
    for (const [connectionId, connection] of connections.entries()) {
      if (connection.ws.readyState === 1) { // WebSocket.OPEN
        try {
          // Capture last few lines for incremental update
          const output = await captureSessionOutput(
            connection.worktreeId,
            connection.cliToolId as any,
            10
          );

          // Only send if there's new content
          if (output && output.trim()) {
            connection.ws.send(output);
          }
        } catch (error) {
          console.error(`Error refreshing terminal ${connectionId}:`, error);
        }
      }
    }
  }, 2000); // Refresh every 2 seconds

  return wss;
}

/**
 * Send input to tmux session
 */
async function sendToTmux(sessionName: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmuxSend = spawn('tmux', ['send-keys', '-t', sessionName, input]);

    tmuxSend.on('error', (error) => {
      console.error('Error sending to tmux:', error);
      reject(error);
    });

    tmuxSend.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tmux send-keys exited with code ${code}`));
      }
    });
  });
}

/**
 * Alternative: Direct PTY approach (without tmux)
 * This creates a direct pseudo-terminal connection
 */
export function createDirectTerminal(worktreeId: string, cliToolId: string) {
  const pty = spawn('bash', [], {
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    cwd: `/Users/maenokota/share/work/github_kewton/MySwiftAgent-worktrees/${worktreeId}`,
  });

  return {
    onData: (callback: (data: string) => void) => {
      pty.stdout.on('data', (data) => callback(data.toString()));
      pty.stderr.on('data', (data) => callback(data.toString()));
    },

    write: (data: string) => {
      pty.stdin.write(data);
    },

    resize: (cols: number, rows: number) => {
      // PTY resize if needed
      // This would require node-pty for proper implementation
    },

    destroy: () => {
      pty.kill();
    }
  };
}