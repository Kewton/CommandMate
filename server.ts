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
import { initScheduleManager, stopAllSchedules } from './src/lib/schedule-manager';
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

// Issue #331: Prevent Next.js (NextCustomServer) from registering its own upgrade
// event listener on the HTTP server.
//
// When next() is called without customServer:false, it creates a NextCustomServer
// instance. NextCustomServer.getRequestHandler() lazily calls setupWebSocketHandler()
// on the first HTTP request, which registers an upgrade listener that calls
// router-server's upgradeHandler → resolveRoutes({ res: socket }) → middleware match
// → serverResult.requestHandler(req, socket, parsedUrl). This passes the raw TCP
// socket as the HTTP response object, causing:
//   TypeError: Cannot read properties of undefined (reading 'bind')
// in handleRequestImpl when it tries to call _res.setHeader.bind(_res).
//
// Making setupWebSocketHandler a no-op prevents this listener from being added.
// All WebSocket upgrades are handled by ws-server.ts (our own upgrade listener).
(app as unknown as { setupWebSocketHandler?: () => void }).setupWebSocketHandler = () => {};

app.prepare().then(() => {
  // Request handler for both HTTP and HTTPS
  const requestHandler = async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    // Guard: res must be a proper HTTP ServerResponse (not a raw net.Socket).
    // Defense-in-depth: normally not needed after the setupWebSocketHandler fix above,
    // but kept for safety in case any other path passes a non-ServerResponse object.
    if (typeof (res as unknown as { setHeader?: unknown })?.setHeader !== 'function') {
      return;
    }

    // Issue #332: Inject X-Real-IP header for IP restriction
    // [S3-005] This applies to HTTP requests only. WebSocket upgrade requests
    // are skipped below and handled by ws-server.ts (which uses socket.remoteAddress directly).
    const clientIp = req.socket.remoteAddress || '';
    if (process.env.CM_TRUST_PROXY !== 'true') {
      // CM_TRUST_PROXY=false: always overwrite to prevent forged headers
      req.headers['x-real-ip'] = clientIp;
    } else {
      // CM_TRUST_PROXY=true: only set if X-Forwarded-For is absent
      if (!req.headers['x-forwarded-for']) {
        req.headers['x-real-ip'] = clientIp;
      }
    }

    // Skip WebSocket upgrade requests - they are handled by the server 'upgrade' event.
    if (req.headers['upgrade']) {
      return;
    }

    const method = req.method ?? 'UNKNOWN';
    const url = req.url ?? '/';
    try {
      const parsedUrl = parse(url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error(`handleRequestImpl failed: ${method} ${url}`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
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

  // H3 fix: Pass hostname to listen() so CM_BIND is respected.
  // Note: http.Server.listen(port, hostname, callback) does not pass err to callback;
  // listen errors emit an 'error' event instead.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use`);
    } else if (err.code === 'EADDRNOTAVAIL') {
      console.error(`Address ${hostname}:${port} is not available`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  server.listen(port, hostname, async () => {
    console.log(`> Ready on ${protocol}://${hostname}:${port}`);
    console.log(`> WebSocket server ready`);

    // Initialize worktrees after server starts
    await initializeWorktrees();

    // [S3-010] Initialize schedule manager AFTER worktrees are ready
    initScheduleManager();
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

    // Issue #294: Stop all scheduled executions (SIGKILL fire-and-forget)
    stopAllSchedules();

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
