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
import { stopAllAutoYesPolling } from './src/lib/auto-yes-manager';
import { runMigrations } from './src/lib/db-migrations';
import { getEnvByKey } from './src/lib/env';

const dev = process.env.NODE_ENV !== 'production';
const hostname = getEnvByKey('CM_BIND') || '127.0.0.1';
const port = parseInt(getEnvByKey('CM_PORT') || '3000', 10);

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

  // Graceful shutdown with timeout
  let isShuttingDown = false;

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
      console.log('Shutdown already in progress, forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

    console.log(`${signal} received: shutting down...`);

    // Stop polling first
    stopAllPolling();

    // Issue #138: Stop all auto-yes pollers
    stopAllAutoYesPolling();

    // Close WebSocket connections immediately (don't wait)
    closeWebSocket();

    // Force exit after 3 seconds if graceful shutdown fails
    const forceExitTimeout = setTimeout(() => {
      console.log('Graceful shutdown timeout, forcing exit...');
      process.exit(1);
    }, 3000);

    // Try graceful HTTP server close
    server.close(() => {
      clearTimeout(forceExitTimeout);
      console.log('Server closed gracefully');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});
