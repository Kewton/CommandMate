/**
 * Custom Next.js Server with WebSocket Support
 * Integrates WebSocket server for real-time communication
 * Issue #331: HTTPS support and auth cleanup on shutdown
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

import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync, accessSync, realpathSync, statSync } from 'fs';
import { constants as fsConstants } from 'fs';
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
import { registerAndFilterRepositories, resolveRepositoryPath } from './src/lib/db-repository';
import { getWorktreeIdsByRepository, deleteWorktreesByIds } from './src/lib/db';

const dev = process.env.NODE_ENV !== 'production';
const hostname = getEnvByKey('CM_BIND') || '127.0.0.1';
const port = parseInt(getEnvByKey('CM_PORT') || '3000', 10);

// Issue #331: HTTPS configuration
const certPath = process.env.CM_HTTPS_CERT;
const keyPath = process.env.CM_HTTPS_KEY;

/** Maximum certificate file size: 1MB */
const MAX_CERT_FILE_SIZE = 1024 * 1024;

/**
 * Validate certificate file path for security
 * Issue #331: Certificate path validation
 */
function validateCertPath(filePath: string, label: string): string {
  if (!existsSync(filePath)) {
    console.error(`[Security] ${label} file not found: ${filePath}`);
    // ExitCode.CONFIG_ERROR = 2 (direct number, not imported from CLI types)
    process.exit(2);
  }

  try {
    accessSync(filePath, fsConstants.R_OK);
  } catch {
    console.error(`[Security] ${label} file not readable: ${filePath}`);
    process.exit(2);
  }

  const realPath = realpathSync(filePath);
  const stats = statSync(realPath);

  if (stats.size > MAX_CERT_FILE_SIZE) {
    console.error(`[Security] ${label} file too large (${stats.size} bytes, max ${MAX_CERT_FILE_SIZE}): ${filePath}`);
    process.exit(2);
  }

  return realPath;
}

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // Request handler for both HTTP and HTTPS
  const requestHandler = async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  };

  // Issue #331: Create HTTP or HTTPS server
  let server: import('http').Server | import('https').Server;
  let protocol = 'http';

  if (certPath && keyPath) {
    const validatedCertPath = validateCertPath(certPath, 'Certificate');
    const validatedKeyPath = validateCertPath(keyPath, 'Key');

    try {
      const cert = readFileSync(validatedCertPath);
      const key = readFileSync(validatedKeyPath);
      server = createHttpsServer({ cert, key }, requestHandler);
      protocol = 'https';
      console.log('HTTPS server created with TLS certificates');
    } catch (error) {
      console.error('Failed to read TLS certificates:', error);
      process.exit(2);
    }
  } else {
    server = createHttpServer(requestHandler);
  }

  // Setup WebSocket server
  setupWebSocket(server as import('http').Server);

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

      // Issue #202: Register environment variable repositories and filter out excluded ones
      // registerAndFilterRepositories() encapsulates the ordering constraint:
      // registration MUST happen before filtering (see design policy Section 4)
      const { filteredPaths, excludedPaths, excludedCount } =
        registerAndFilterRepositories(db, repositoryPaths);
      if (excludedCount > 0) {
        console.log(`Excluded repositories: ${excludedCount}, Active repositories: ${filteredPaths.length}`);
        // SF-SEC-003: Log excluded repository paths for audit/troubleshooting
        excludedPaths.forEach(p => {
          console.log(`  [excluded] ${p}`);
        });

        // Issue #202: Remove worktrees of excluded repositories from DB
        // Without this, worktree records remain in DB and appear in the UI
        for (const excludedPath of excludedPaths) {
          const resolvedPath = resolveRepositoryPath(excludedPath);
          const worktreeIds = getWorktreeIdsByRepository(db, resolvedPath);
          if (worktreeIds.length > 0) {
            const result = deleteWorktreesByIds(db, worktreeIds);
            console.log(`  Removed ${result.deletedCount} worktree(s) from excluded repository: ${resolvedPath}`);
          }
        }
      }

      // Scan filtered repositories (excluded repos are skipped)
      const worktrees = await scanMultipleRepositories(filteredPaths);

      // Sync to database
      syncWorktreesToDB(db, worktrees);

      console.log(`Total: ${worktrees.length} worktree(s) synced to database`);
    } catch (error) {
      console.error('Error initializing worktrees:', error);
    }
  }

  server.listen(port, async (err?: Error) => {
    if (err) throw err;
    console.log(`> Ready on ${protocol}://${hostname}:${port}`);
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
