/**
 * Custom Next.js Server with WebSocket Support
 * Integrates WebSocket server for real-time communication
 */

// IMPORTANT: Register uncaught exception handler FIRST, before any imports
// This ensures we catch WebSocket frame errors before other handlers
process.on('uncaughtException', (error: Error & { code?: string }) => {
  // Check for WebSocket-related errors that are non-fatal
  const isWebSocketError =
    error.code === 'WS_ERR_INVALID_UTF8' ||
    error.code === 'WS_ERR_INVALID_CLOSE_CODE' ||
    error.code === 'WS_ERR_UNEXPECTED_RSV_1' ||
    error.code === 'ECONNRESET' ||
    error.code === 'EPIPE' ||
    (error instanceof RangeError && error.message?.includes('Invalid WebSocket frame')) ||
    error.message?.includes('write after end');

  if (isWebSocketError) {
    // Silently ignore these non-fatal WebSocket frame errors
    // They commonly occur when mobile browsers send malformed close frames
    return;
  }
  // For other uncaught exceptions, log and exit
  console.error('Uncaught exception:', error);
  process.exit(1);
});

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { setupWebSocket, closeWebSocket } from './src/lib/ws-server';
import {
  getRepositoryPaths,
  scanMultipleRepositories,
  syncWorktreesToDB
} from './src/lib/worktrees';
import { getDbInstance } from './src/lib/db-instance';
import { stopAllPolling } from './src/lib/response-poller';
import { runMigrations } from './src/lib/db-migrations';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.MCBD_BIND || '127.0.0.1';
const port = parseInt(process.env.MCBD_PORT || process.env.PORT || '3000', 10);

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
    try {
      // Run database migrations first
      console.log('Running database migrations...');
      const db = getDbInstance();
      runMigrations(db);

      // Get repository paths from environment variables
      const repositoryPaths = getRepositoryPaths();

      if (repositoryPaths.length === 0) {
        console.warn('Warning: No repository paths configured');
        console.warn('Set WORKTREE_REPOS (comma-separated) or MCBD_ROOT_DIR');
        return;
      }

      console.log(`Configured repositories: ${repositoryPaths.length}`);
      repositoryPaths.forEach((path, i) => {
        console.log(`  ${i + 1}. ${path}`);
      });

      // Scan all repositories
      const worktrees = await scanMultipleRepositories(repositoryPaths);

      // Sync to database
      syncWorktreesToDB(db, worktrees);

      console.log(`✓ Total: ${worktrees.length} worktree(s) synced to database`);
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
