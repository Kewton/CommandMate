/**
 * WebSocket Server for Real-time Communication
 * Manages WebSocket connections and room-based message broadcasting
 */

import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

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
 * Setup WebSocket server on HTTP server
 *
 * @param server - HTTP server instance
 *
 * @example
 * ```typescript
 * const server = createServer();
 * setupWebSocket(server);
 * server.listen(3000);
 * ```
 */
export function setupWebSocket(server: HTTPServer): void {
  wss = new WebSocketServer({ server });

  // Handle server-level errors (e.g., invalid WebSocket frames from clients)
  wss.on('error', (error) => {
    console.error('[WS Server] Error:', error.message || error);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Initialize client info
    const clientInfo: ClientInfo = {
      ws,
      worktreeIds: new Set(),
    };
    clients.set(ws, clientInfo);

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

    // Handle disconnection
    ws.on('close', () => {
      handleDisconnect(ws);
    });

    // Handle errors - this catches invalid frame errors from individual clients
    ws.on('error', (error: Error & { code?: string }) => {
      // Silently handle common mobile browser disconnect errors
      if (error.code !== 'WS_ERR_INVALID_CLOSE_CODE') {
        console.error('[WS] WebSocket error:', error.message || error);
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
  if (!clientInfo) return;

  // Add worktreeId to client's subscriptions
  clientInfo.worktreeIds.add(worktreeId);

  // Add client to room
  if (!rooms.has(worktreeId)) {
    rooms.set(worktreeId, new Set());
  }
  rooms.get(worktreeId)!.add(ws);
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
}

/**
 * Broadcast message to all clients in a worktree room
 */
function handleBroadcast(worktreeId: string, data: unknown): void {
  const room = rooms.get(worktreeId);
  if (!room || room.size === 0) return;

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
        } catch {
          // Silent fail for individual client errors
        }
      }
    });
  } catch (broadcastError) {
    console.error(`[WS] Broadcast error for ${worktreeId}:`, broadcastError);
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
