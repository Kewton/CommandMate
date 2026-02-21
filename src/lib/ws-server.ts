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

interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'broadcast';
  worktreeId: string;
  data?: unknown;
}

interface ClientInfo {
  ws: WebSocket;
  worktreeIds: Set<string>;
}

// Global state
let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, ClientInfo>();
const rooms = new Map<string, Set<WebSocket>>();

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

    // Let Next.js handle its own HMR WebSocket connections
    if (pathname.startsWith('/_next/')) {
      return;
    }

    // Issue #331: WebSocket authentication via Cookie header
    if (isAuthEnabled()) {
      const cookieHeader = request.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const token = cookies[AUTH_COOKIE_NAME];

      if (!token || !verifyToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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

  console.log('WebSocket server initialized');
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(ws: WebSocket, message: WebSocketMessage): void {
  switch (message.type) {
    case 'subscribe':
      handleSubscribe(ws, message.worktreeId);
      break;

    case 'unsubscribe':
      handleUnsubscribe(ws, message.worktreeId);
      break;

    case 'broadcast':
      handleBroadcast(message.worktreeId, message.data);
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
    console.log(`[WS] handleSubscribe: clientInfo not found for worktreeId: ${worktreeId}`);
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

  console.log(`Client subscribed to worktree: ${worktreeId}, room size: ${room.size}, ws readyState: ${ws.readyState}`);
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

  console.log(`Client unsubscribed from worktree: ${worktreeId}`);
}

/**
 * Broadcast message to all clients in a worktree room
 */
function handleBroadcast(worktreeId: string, data: unknown): void {
  const room = rooms.get(worktreeId);
  console.log(`[WS] handleBroadcast called for ${worktreeId}, room size: ${room?.size || 0}`);
  if (!room) {
    console.log(`[WS] No room found for ${worktreeId}`);
    return;
  }
  if (room.size === 0) {
    console.log(`[WS] Room for ${worktreeId} is empty`);
    return;
  }

  try {
    const message = JSON.stringify({
      type: 'broadcast',
      worktreeId,
      data,
    });

    let successCount = 0;
    let errorCount = 0;

    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          successCount++;
        } catch (sendError) {
          errorCount++;
          console.error(`Error sending WebSocket message to client:`, sendError);
        }
      }
    });

    console.log(`Broadcast to worktree ${worktreeId}: ${successCount}/${room.size} clients (${errorCount} errors)`);
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

  // Remove client from clients map
  clients.delete(ws);
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
      console.log(`[WS] Cleaned up room for worktree: ${worktreeId}`);
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

    console.log('WebSocket server closed');
  }
}
