/**
 * Custom Next.js Server with WebSocket Support
 * Integrates WebSocket server for real-time communication
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { setupWebSocket, closeWebSocket } from './src/lib/ws-server';
import { scanWorktrees, syncWorktreesToDB } from './src/lib/worktrees';
import { getDbInstance } from './src/lib/db-instance';
import { stopAllPolling } from './src/lib/claude-poller';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // Create HTTP server
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  // Setup WebSocket server
  setupWebSocket(server);

  // Scan and sync worktrees on startup
  async function initializeWorktrees() {
    const rootDir = process.env.MCBD_ROOT_DIR;
    if (!rootDir) {
      console.warn('Warning: MCBD_ROOT_DIR not set, skipping worktree scan');
      return;
    }

    try {
      console.log(`Scanning worktrees in: ${rootDir}`);
      const worktrees = await scanWorktrees(rootDir);
      const db = getDbInstance();
      syncWorktreesToDB(db, worktrees);
      console.log(`✓ Found and synced ${worktrees.length} worktrees`);
    } catch (error) {
      console.error('Error initializing worktrees:', error);
    }
  }

  server.listen(port, async (err?: Error) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket server ready`);

    // Initialize worktrees after server starts
    await initializeWorktrees();
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    stopAllPolling();
    server.close(() => {
      console.log('HTTP server closed');
      closeWebSocket();
      console.log('WebSocket server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    stopAllPolling();
    server.close(() => {
      console.log('HTTP server closed');
      closeWebSocket();
      console.log('WebSocket server closed');
      process.exit(0);
    });
  });
});
