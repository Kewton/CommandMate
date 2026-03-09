/**
 * WebSocket Server for Real-time Communication
 * Manages WebSocket connections and room-based message broadcasting
 * Issue #331: WebSocket authentication via Cookie header
 */

import { Server as HTTPServer } from 'http';
import { Server as HTTPSServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { isAuthEnabled, parseCookies, AUTH_COOKIE_NAME, verifyToken } from './auth';
import { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, normalizeIp } from './ip-restriction';
import { isCliToolType } from './cli-tools/types';
import { CLIToolManager } from './cli-tools/manager';
import { getDbInstance } from './db-instance';
import { getWorktreeById } from './db';
import { observeTmuxControlFirstOutputLatency } from './tmux-control-mode-metrics';
import { getControlModeTmuxTransport } from './transports/control-mode-tmux-transport';
import { isTmuxControlModeEnabled } from './tmux-control-mode-flags';

interface WebSocketMessage {
  type:
    | 'subscribe'
    | 'unsubscribe'
    | 'broadcast'
    | 'terminal_subscribe'
    | 'terminal_input'
    | 'terminal_resize'
    | 'terminal_unsubscribe';
  worktreeId?: string;
  cliToolId?: string;
  data?: unknown;
  cols?: number;
  rows?: number;
}

interface TerminalSubscription {
  worktreeId: string;
  cliToolId: string;
  sessionName: string;
  startedAt: number;
  unsubscribe: () => Promise<void>;
}

interface ClientInfo {
  ws: WebSocket;
  worktreeIds: Set<string>;
  terminalSubscription: TerminalSubscription | null;
}

// Global state
let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, ClientInfo>();
const rooms = new Map<string, Set<WebSocket>>();
const MAX_TERMINAL_INPUT_LENGTH = 4096;
const MAX_TERMINAL_SUBSCRIBERS_PER_SESSION = 4;
const TERMINAL_FALLBACK_CAPTURE_LINES = -200;

/**
 * Check if a WebSocket error is an expected non-fatal error.
 * Common causes include mobile browser disconnects sending malformed close frames.
 *
 * @param error - Error with optional code property
 * @returns true if the error is expected and can be silently handled
 */
function isExpectedWebSocketError(error: Error & { code?: string }): boolean {
  return (
    error.code === 'WS_ERR_INVALID_CLOSE_CODE' ||
    error.message?.includes('Invalid WebSocket frame') ||
    error.message?.includes('write after end') ||
    error.message?.includes('ECONNRESET') ||
    error.message?.includes('EPIPE')
  );
}

/**
 * Setup WebSocket server on HTTP or HTTPS server
 * Issue #331: Added auth check on WebSocket upgrade
 *
 * @param server - HTTP or HTTPS server instance
 *
 * @example
 * ```typescript
 * const server = createServer();
 * setupWebSocket(server);
 * server.listen(3000);
 * ```
 */
export function setupWebSocket(server: HTTPServer | HTTPSServer): void {
  wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests - only accept app WebSocket connections, not Next.js HMR
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url || '/';

    // Let Next.js handle its own HMR WebSocket connections in development.
    // In production there are no /_next/ WebSocket connections (no HMR).
    // Leaving the socket unhandled in production can trigger the Node.js 'request'
    // event as a fallback on Node.js 19+, causing TypeError in handleRequestImpl
    // because the response has no setHeader (Issue #331).
    if (pathname.startsWith('/_next/')) {
      if (process.env.NODE_ENV !== 'development') {
        socket.write('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    // Issue #332: WebSocket IP restriction
    // [S2-008] Uses request.socket.remoteAddress directly (not getClientIp()).
    // getClientIp() is for HTTP headers (X-Real-IP/X-Forwarded-For);
    // WebSocket upgrade gets IP from the socket connection directly.
    if (isIpRestrictionEnabled()) {
      const wsClientIp = normalizeIp(request.socket.remoteAddress || '');
      if (!isIpAllowed(wsClientIp, getAllowedRanges())) {
        // [S4-004] Log injection prevention: normalizeIp() + substring(0, 45)
        const safeIp = wsClientIp.substring(0, 45);
        console.warn(`[IP-RESTRICTION] WebSocket denied: ${safeIp}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // Issue #331: WebSocket authentication via Cookie header
    if (isAuthEnabled()) {
      const cookieHeader = request.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const token = cookies[AUTH_COOKIE_NAME];

      if (!token || !verifyToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  // Handle WebSocket server errors (e.g., invalid frames from clients)
  wss.on('error', (error) => {
    console.error('[WS Server] Error:', error.message);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Connection logging removed to reduce noise

    // Initialize client info
    const clientInfo: ClientInfo = {
      ws,
      worktreeIds: new Set(),
      terminalSubscription: null,
    };
    clients.set(ws, clientInfo);

    // Handle underlying socket errors (catches invalid frame errors earlier)
    // Force destroy the socket on error to prevent further frame processing
    const socket = (ws as unknown as { _socket?: { on: (event: string, handler: (err: Error) => void) => void; destroy?: () => void } })._socket;
    if (socket) {
      socket.on('error', (err: Error & { code?: string }) => {
        if (!isExpectedWebSocketError(err)) {
          console.error('[WS Socket] Error:', err.message);
        }

        // Immediately destroy the socket to prevent further errors
        try {
          if (socket.destroy) socket.destroy();
        } catch {
          // Socket may already be destroyed
        }
        handleDisconnect(ws);
      });
    }

    // Handle messages
    ws.on('message', (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (parseError) {
        console.error('Error parsing WebSocket message:', parseError);
        // Don't close connection on parse error, just log it
      }
    });

    // Handle disconnection - silently clean up
    ws.on('close', () => {
      handleDisconnect(ws);
    });

    // Handle errors (including invalid close codes from mobile browsers)
    ws.on('error', (error: Error & { code?: string }) => {
      if (!isExpectedWebSocketError(error)) {
        console.error('[WS] WebSocket error:', error.message);
      }

      // Immediately terminate to prevent further errors
      try {
        ws.terminate();
      } catch {
        // WebSocket may already be closed
      }
      handleDisconnect(ws);
    });
  });

  // WebSocket server initialization complete (no log in production per CLAUDE.md)
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(ws: WebSocket, message: WebSocketMessage): void {
  switch (message.type) {
    case 'subscribe':
      if (!message.worktreeId) return;
      handleSubscribe(ws, message.worktreeId);
      break;

    case 'unsubscribe':
      if (!message.worktreeId) return;
      handleUnsubscribe(ws, message.worktreeId);
      break;

    case 'broadcast':
      if (!message.worktreeId) return;
      handleBroadcast(message.worktreeId, message.data);
      break;

    case 'terminal_subscribe':
      void handleTerminalSubscribe(ws, message);
      break;

    case 'terminal_input':
      void handleTerminalInput(ws, message);
      break;

    case 'terminal_resize':
      void handleTerminalResize(ws, message);
      break;

    case 'terminal_unsubscribe':
      void handleTerminalUnsubscribe(ws);
      break;

    default:
      console.warn('Unknown message type:', message);
  }
}

/**
 * Subscribe client to a worktree room
 */
function handleSubscribe(ws: WebSocket, worktreeId: string): void {
  const clientInfo = clients.get(ws);
  if (!clientInfo) {
    return;
  }

  // Add worktreeId to client's subscriptions
  clientInfo.worktreeIds.add(worktreeId);

  // Add client to room
  if (!rooms.has(worktreeId)) {
    rooms.set(worktreeId, new Set());
  }
  const room = rooms.get(worktreeId)!;
  room.add(ws);

  // Client subscribed (no log in production per CLAUDE.md)
}

/**
 * Unsubscribe client from a worktree room
 */
function handleUnsubscribe(ws: WebSocket, worktreeId: string): void {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  // Remove worktreeId from client's subscriptions
  clientInfo.worktreeIds.delete(worktreeId);

  // Remove client from room
  const room = rooms.get(worktreeId);
  if (room) {
    room.delete(ws);
    // Clean up empty rooms
    if (room.size === 0) {
      rooms.delete(worktreeId);
    }
  }

  // Client unsubscribed (no log in production per CLAUDE.md)
}

/**
 * Broadcast message to all clients in a worktree room
 */
function handleBroadcast(worktreeId: string, data: unknown): void {
  const room = rooms.get(worktreeId);
  if (!room || room.size === 0) {
    return;
  }

  try {
    const message = JSON.stringify({
      type: 'broadcast',
      worktreeId,
      data,
    });

    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (sendError) {
          console.error(`Error sending WebSocket message to client:`, sendError);
        }
      }
    });
  } catch (broadcastError) {
    console.error(`Error broadcasting to worktree ${worktreeId}:`, broadcastError);
    // Try to broadcast with sanitized data
    try {
      const sanitizedMessage = JSON.stringify({
        type: 'broadcast',
        worktreeId,
        data: { error: 'Message encoding error' },
      });
      room.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(sanitizedMessage);
          } catch {
            // Silent fail for fallback
          }
        }
      });
    } catch (fallbackError) {
      console.error('Failed to send fallback message:', fallbackError);
    }
  }
}

/**
 * Handle client disconnection
 */
function handleDisconnect(ws: WebSocket): void {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  // Remove client from all rooms
  clientInfo.worktreeIds.forEach((worktreeId) => {
    const room = rooms.get(worktreeId);
    if (room) {
      room.delete(ws);
      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(worktreeId);
      }
    }
  });

  if (clientInfo.terminalSubscription) {
    void clientInfo.terminalSubscription.unsubscribe();
    clientInfo.terminalSubscription = null;
  }

  // Remove client from clients map
  clients.delete(ws);
}

function sendTerminalEvent(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(data));
}

async function handleTerminalSubscribe(ws: WebSocket, message: WebSocketMessage): Promise<void> {
  const clientInfo = clients.get(ws);
  if (!clientInfo) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: 'Unauthorized WebSocket client',
    });
    return;
  }

  if (!isTmuxControlModeEnabled()) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: 'Tmux control mode is disabled',
    });
    return;
  }

  const { worktreeId, cliToolId } = message;
  if (!worktreeId || !cliToolId || !isCliToolType(cliToolId)) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: 'Invalid terminal subscription parameters',
    });
    return;
  }

  const db = getDbInstance();
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: 'Worktree not found',
    });
    return;
  }

  if (clientInfo.terminalSubscription) {
    await clientInfo.terminalSubscription.unsubscribe();
    clientInfo.terminalSubscription = null;
  }

  const cliTool = CLIToolManager.getInstance().getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId);
  const transport = getControlModeTmuxTransport();
  if (transport.getSubscriberCount(sessionName) >= MAX_TERMINAL_SUBSCRIBERS_PER_SESSION) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: 'Terminal subscriber limit reached',
    });
    return;
  }

  let firstOutputObserved = false;
  const startedAt = Date.now();
  const subscription = await transport.subscribe(sessionName, {
    onOutput: (data) => {
      if (!firstOutputObserved) {
        firstOutputObserved = true;
        observeTmuxControlFirstOutputLatency(Date.now() - startedAt);
      }
      sendTerminalEvent(ws, { type: 'terminal_output', data });
    },
    onExit: ({ exitCode }) => {
      sendTerminalEvent(ws, { type: 'terminal_exit', exitCode });
    },
    onError: (error) => {
      void (async () => {
        try {
          const snapshot = await transport.captureSnapshot(sessionName, {
            startLine: TERMINAL_FALLBACK_CAPTURE_LINES,
          });
          if (snapshot.length > 0) {
            sendTerminalEvent(ws, {
              type: 'terminal_output',
              data: snapshot,
              fallback: true,
            });
          }
        } catch {
          // Best-effort snapshot fallback. The original control-mode error is still reported.
        }

        sendTerminalEvent(ws, {
          type: 'terminal_error',
          error: error.message,
          fallback: true,
        });
      })();
    },
  });

  clientInfo.terminalSubscription = {
    worktreeId,
    cliToolId,
    sessionName,
    startedAt,
    unsubscribe: subscription.unsubscribe,
  };

  sendTerminalEvent(ws, {
    type: 'terminal_status',
    connected: true,
    worktreeId,
    cliToolId,
  });
}

async function handleTerminalInput(ws: WebSocket, message: WebSocketMessage): Promise<void> {
  const clientInfo = clients.get(ws);
  const subscription = clientInfo?.terminalSubscription;
  if (!subscription) {
    sendTerminalEvent(ws, { type: 'terminal_error', error: 'No active terminal subscription' });
    return;
  }

  const input = typeof message.data === 'string' ? message.data : '';
  if (input.length === 0 || input.length > MAX_TERMINAL_INPUT_LENGTH) {
    sendTerminalEvent(ws, { type: 'terminal_error', error: 'Invalid terminal input' });
    return;
  }

  try {
    await getControlModeTmuxTransport().sendInput(subscription.sessionName, input);
  } catch (error) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: error instanceof Error ? error.message : 'Failed to send terminal input',
    });
  }
}

async function handleTerminalResize(ws: WebSocket, message: WebSocketMessage): Promise<void> {
  const clientInfo = clients.get(ws);
  const subscription = clientInfo?.terminalSubscription;
  if (!subscription) {
    return;
  }

  if (
    typeof message.cols !== 'number' || !Number.isInteger(message.cols) || message.cols < 20 || message.cols > 500 ||
    typeof message.rows !== 'number' || !Number.isInteger(message.rows) || message.rows < 5 || message.rows > 200
  ) {
    sendTerminalEvent(ws, { type: 'terminal_error', error: 'Invalid terminal resize payload' });
    return;
  }

  try {
    await getControlModeTmuxTransport().resize(subscription.sessionName, message.cols, message.rows);
  } catch (error) {
    sendTerminalEvent(ws, {
      type: 'terminal_error',
      error: error instanceof Error ? error.message : 'Failed to resize terminal',
    });
  }
}

async function handleTerminalUnsubscribe(ws: WebSocket): Promise<void> {
  const clientInfo = clients.get(ws);
  if (!clientInfo?.terminalSubscription) {
    return;
  }

  try {
    await clientInfo.terminalSubscription.unsubscribe();
  } catch {
    // Best-effort cleanup during terminal unsubscribe.
  }
  clientInfo.terminalSubscription = null;
  sendTerminalEvent(ws, { type: 'terminal_status', connected: false });
}

/**
 * Broadcast message to a specific worktree room (for API use)
 *
 * @param worktreeId - Worktree identifier
 * @param data - Data to broadcast
 *
 * @example
 * ```typescript
 * broadcast('feature-foo', { type: 'message', content: 'New message' });
 * ```
 */
export function broadcast(worktreeId: string, data: unknown): void {
  handleBroadcast(worktreeId, data);
}

/**
 * Broadcast message with type to a specific worktree room
 *
 * @param type - Message type
 * @param data - Data to broadcast (should include worktreeId)
 *
 * @example
 * ```typescript
 * broadcastMessage('message', { worktreeId: 'feature-foo', message: {...} });
 * ```
 */
export function broadcastMessage(type: string, data: { worktreeId?: string; [key: string]: unknown }): void {
  if (data.worktreeId) {
    handleBroadcast(data.worktreeId, { type, ...data });
  } else {
    console.warn('broadcastMessage called without worktreeId');
  }
}

/**
 * Clean up WebSocket rooms for deleted worktrees
 * Removes rooms from the rooms map (clients will naturally disconnect or resubscribe)
 *
 * @param worktreeIds - Array of worktree IDs to clean up
 *
 * @example
 * ```typescript
 * cleanupRooms(['wt-1', 'wt-2', 'wt-3']);
 * ```
 */
export function cleanupRooms(worktreeIds: string[]): void {
  for (const worktreeId of worktreeIds) {
    const room = rooms.get(worktreeId);
    if (room) {
      // Unsubscribe all clients from this room
      room.forEach((ws) => {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
          clientInfo.worktreeIds.delete(worktreeId);
        }
      });
      // Delete the room
      rooms.delete(worktreeId);
      // Room cleaned up (no log in production per CLAUDE.md)
    }
  }
}

/**
 * Close WebSocket server
 * Used for testing and graceful shutdown
 */
export function closeWebSocket(): void {
  if (wss) {
    // Close all client connections
    clients.forEach((clientInfo) => {
      clientInfo.ws.close();
    });

    // Clear state
    clients.clear();
    rooms.clear();

    // Close server
    wss.close();
    wss = null;

    // WebSocket server closed (no log in production per CLAUDE.md)
  }
}

export const __internal = {
  handleMessage,
  handleTerminalSubscribe,
  handleTerminalInput,
  handleTerminalResize,
  handleTerminalUnsubscribe,
  handleDisconnect,
  registerClientForTest(ws: WebSocket): void {
    clients.set(ws, {
      ws,
      worktreeIds: new Set(),
      terminalSubscription: null,
    });
  },
  getClientInfoForTest(ws: WebSocket): ClientInfo | undefined {
    return clients.get(ws);
  },
  resetStateForTest(): void {
    clients.clear();
    rooms.clear();
  },
};
