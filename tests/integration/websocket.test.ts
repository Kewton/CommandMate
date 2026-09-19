/**
 * WebSocket Integration Tests
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HTTPServer } from 'http';
import WebSocket from 'ws';
import { setupWebSocket, closeWebSocket } from '@/lib/ws-server';

describe('WebSocket Server', () => {
  let httpServer: HTTPServer;
  let wsUrl: string;

  beforeEach(async () => {
    // Create HTTP server for WebSocket
    httpServer = createServer();

    // Setup WebSocket on the HTTP server
    setupWebSocket(httpServer);

    // Start server on random available port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 3000;
        wsUrl = `ws://localhost:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    // Close WebSocket server
    closeWebSocket();

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should accept WebSocket connections', async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('should handle client disconnection', async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.close();
      });
      ws.on('close', () => {
        expect(ws.readyState).toBe(WebSocket.CLOSED);
        resolve();
      });
    });
  });

  it('should broadcast messages to clients in the same room', async () => {
    const client1 = new WebSocket(wsUrl);
    const client2 = new WebSocket(wsUrl);
    const client3 = new WebSocket(wsUrl);

    // Wait for all clients to connect
    await Promise.all([
      new Promise((resolve) => client1.on('open', resolve)),
      new Promise((resolve) => client2.on('open', resolve)),
      new Promise((resolve) => client3.on('open', resolve)),
    ]);

    // Subscribe client1 and client2 to worktree 'test-worktree'
    client1.send(JSON.stringify({
      type: 'subscribe',
      worktreeId: 'test-worktree',
    }));

    client2.send(JSON.stringify({
      type: 'subscribe',
      worktreeId: 'test-worktree',
    }));

    // Subscribe client3 to different worktree
    client3.send(JSON.stringify({
      type: 'subscribe',
      worktreeId: 'other-worktree',
    }));

    // Wait a bit for subscriptions to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send broadcast message to 'test-worktree'
    const receivedMessages: any[] = [];

    client1.on('message', (data) => {
      receivedMessages.push({ client: 1, message: JSON.parse(data.toString()) });
    });

    client2.on('message', (data) => {
      receivedMessages.push({ client: 2, message: JSON.parse(data.toString()) });
    });

    client3.on('message', (data) => {
      receivedMessages.push({ client: 3, message: JSON.parse(data.toString()) });
    });

    // Broadcast message to test-worktree
    client1.send(JSON.stringify({
      type: 'broadcast',
      worktreeId: 'test-worktree',
      data: { content: 'Test message' },
    }));

    // Wait for messages to be received
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Client1 and Client2 should receive the message
    // Client3 should NOT receive it (different room)
    const client1Messages = receivedMessages.filter(m => m.client === 1);
    const client2Messages = receivedMessages.filter(m => m.client === 2);
    const client3Messages = receivedMessages.filter(m => m.client === 3);

    expect(client1Messages.length).toBeGreaterThan(0);
    expect(client2Messages.length).toBeGreaterThan(0);
    expect(client3Messages.length).toBe(0);

    // Verify message content
    expect(client1Messages[0].message.data.content).toBe('Test message');
    expect(client2Messages[0].message.data.content).toBe('Test message');

    // Cleanup
    client1.close();
    client2.close();
    client3.close();
  });

  it('should handle multiple rooms simultaneously', async () => {
    const room1Client1 = new WebSocket(wsUrl);
    const room1Client2 = new WebSocket(wsUrl);
    const room2Client1 = new WebSocket(wsUrl);

    await Promise.all([
      new Promise((resolve) => room1Client1.on('open', resolve)),
      new Promise((resolve) => room1Client2.on('open', resolve)),
      new Promise((resolve) => room2Client1.on('open', resolve)),
    ]);

    // Subscribe to different rooms
    room1Client1.send(JSON.stringify({ type: 'subscribe', worktreeId: 'room-1' }));
    room1Client2.send(JSON.stringify({ type: 'subscribe', worktreeId: 'room-1' }));
    room2Client1.send(JSON.stringify({ type: 'subscribe', worktreeId: 'room-2' }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const room1Messages: any[] = [];
    const room2Messages: any[] = [];

    room1Client1.on('message', (data) => {
      room1Messages.push(JSON.parse(data.toString()));
    });

    room1Client2.on('message', (data) => {
      room1Messages.push(JSON.parse(data.toString()));
    });

    room2Client1.on('message', (data) => {
      room2Messages.push(JSON.parse(data.toString()));
    });

    // Send messages to both rooms
    room1Client1.send(JSON.stringify({
      type: 'broadcast',
      worktreeId: 'room-1',
      data: { message: 'Room 1 message' },
    }));

    room2Client1.send(JSON.stringify({
      type: 'broadcast',
      worktreeId: 'room-2',
      data: { message: 'Room 2 message' },
    }));

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Room 1 should have received 2 messages (both clients)
    expect(room1Messages.length).toBe(2);
    expect(room1Messages[0].data.message).toBe('Room 1 message');

    // Room 2 should have received 1 message
    expect(room2Messages.length).toBe(1);
    expect(room2Messages[0].data.message).toBe('Room 2 message');

    // Cleanup
    room1Client1.close();
    room1Client2.close();
    room2Client1.close();
  });

  it('should remove client from room on disconnect', async () => {
    const client1 = new WebSocket(wsUrl);
    const client2 = new WebSocket(wsUrl);

    await Promise.all([
      new Promise((resolve) => client1.on('open', resolve)),
      new Promise((resolve) => client2.on('open', resolve)),
    ]);

    // Both subscribe to same room
    client1.send(JSON.stringify({ type: 'subscribe', worktreeId: 'test-room' }));
    client2.send(JSON.stringify({ type: 'subscribe', worktreeId: 'test-room' }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Disconnect client1
    client1.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const client2Messages: any[] = [];
    client2.on('message', (data) => {
      client2Messages.push(JSON.parse(data.toString()));
    });

    // Send broadcast (only client2 should receive)
    client2.send(JSON.stringify({
      type: 'broadcast',
      worktreeId: 'test-room',
      data: { message: 'After disconnect' },
    }));

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Client2 should receive the message
    expect(client2Messages.length).toBe(1);

    // Cleanup
    client2.close();
  });

  it('should handle invalid message format gracefully', async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        // Send invalid JSON
        ws.send('invalid json');

        // Should still be connected
        setTimeout(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          resolve();
        }, 100);
      });
    });
  });

  it('should handle unsubscribe requests', async () => {
    const client = new WebSocket(wsUrl);

    await new Promise((resolve) => client.on('open', resolve));

    // Subscribe
    client.send(JSON.stringify({ type: 'subscribe', worktreeId: 'test-room' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Unsubscribe
    client.send(JSON.stringify({ type: 'unsubscribe', worktreeId: 'test-room' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messages: any[] = [];
    client.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Send broadcast (client should NOT receive as it unsubscribed)
    client.send(JSON.stringify({
      type: 'broadcast',
      worktreeId: 'test-room',
      data: { message: 'Should not receive' },
    }));

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should not receive any broadcast messages after unsubscribe
    expect(messages.length).toBe(0);

    // Cleanup
    client.close();
  });
});
