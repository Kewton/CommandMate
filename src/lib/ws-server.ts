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
  data?: any;
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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('WebSocket client connected');

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
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
        // Don't close connection on parse error, just log it
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      handleDisconnect(ws);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
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

  console.log(`Client subscribed to worktree: ${worktreeId}`);
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
function handleBroadcast(worktreeId: string, data: any): void {
  const room = rooms.get(worktreeId);
  if (!room) return;

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
  } catch (error) {
    console.error(`Error broadcasting to worktree ${worktreeId}:`, error);
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
          } catch (e) {
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
export function broadcast(worktreeId: string, data: any): void {
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
export function broadcastMessage(type: string, data: any): void {
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
