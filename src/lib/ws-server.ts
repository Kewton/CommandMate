/**
 * WebSocket Server for Real-time Communication
 * Manages WebSocket connections and room-based message broadcasting
 * Issue #331: WebSocket authentication via Cookie header
 */

import { Server as HTTPServer } from 'http';
import { Server as HTTPSServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { connect as netConnectImpl, Socket as NetSocket } from 'net';
import type { Duplex } from 'stream';
import { isAuthEnabled, parseCookies, AUTH_COOKIE_NAME, verifyToken } from './security/auth';
import { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, normalizeIp } from './security/ip-restriction';
import { isCliToolType } from './cli-tools/types';
// Issue #1984: `CLIToolManager` ではなくセッション名の規則だけを引く。ここで欲しいのは
// `getTool(id).getSessionName(...)` の戻り値 1 つで、7 ツールの実装は module load 時には
// 1 つも要らない。manager 経由の静的 import は
// `ws-server -> cli-tools/manager -> polling/response-poller -> ... -> ws-server` という
// モジュールスコープの循環の一辺でもあった。
import { resolveSessionName } from './cli-tools/session-name';
import { getDbInstance } from './db/db-instance';
import { getWorktreeById } from './db';
import { observeTmuxControlFirstOutputLatency } from './tmux/tmux-control-mode-metrics';
import { getControlModeTmuxTransport } from './tmux/control-mode-tmux-transport';
import { isTmuxControlModeEnabled } from './tmux/tmux-control-mode-flags';
import { getExternalAppCache } from './external-apps/cache';
import type { ExternalApp } from '@/types/external-apps';
import { resolveBundleDrift } from '@/lib/version-checker';
import {
  CLIENT_VERSION_MESSAGE_TYPE,
  VERSION_MISMATCH_EVENT_TYPE,
} from '@/lib/realtime/types';
import {
  startWaitingStatusBroadcast,
  stopWaitingStatusBroadcast,
} from '@/lib/realtime/waiting-broadcast';
// Issue #2220: this module's `rooms` is per module instance, and a production
// build has two instances of it (`dist/server` + a `.next/server/chunks` copy).
// The registry is how a route handler's copy reaches the one holding sockets.
import {
  getRoomPublisher,
  recordUnroutedPublish,
  registerRoomPublisher,
  type RoomMigrationResult,
  type RoomPublisher,
  type RoomPublisherHandle,
  type RoomRename,
} from '@/lib/realtime/publisher-registry';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ws-server');

interface WebSocketMessage {
  type:
    | 'subscribe'
    | 'unsubscribe'
    | 'broadcast'
    | typeof CLIENT_VERSION_MESSAGE_TYPE
    | 'terminal_subscribe'
    | 'terminal_input'
    | 'terminal_resize'
    | 'terminal_unsubscribe';
  worktreeId?: string;
  cliToolId?: string;
  data?: unknown;
  cols?: number;
  rows?: number;
  /** Client bundle version carried by a {@link CLIENT_VERSION_MESSAGE_TYPE} hello. */
  version?: string;
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
/**
 * This instance's claim on the process's rooms, or null when it never called
 * `setupWebSocket` (every route bundle) or has already withdrawn.
 *
 * Issue #2220: held so `closeWebSocket` can present the token it was given. A
 * bare "clear the registry" would let a torn-down instance silence a newer one.
 */
let publisherHandle: RoomPublisherHandle | null = null;
const MAX_TERMINAL_INPUT_LENGTH = 4096;
const MAX_TERMINAL_SUBSCRIBERS_PER_SESSION = 4;
const TERMINAL_FALLBACK_CAPTURE_LINES = -200;

/**
 * Allowed upstream hosts for /proxy/<prefix> WebSocket proxying.
 * SSRF defense: only accept loopback addresses.
 * Issue #671.
 */
const PROXY_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Write a minimal HTTP error response to a raw upgrade socket and destroy it.
 * Used for 4xx / 5xx rejections in the /proxy/<prefix> upgrade branch.
 */
function writeRawResponseAndDestroy(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  } catch {
    // Socket may already be closed; ignore.
  }
  socket.destroy();
}

/**
 * Build the raw HTTP upgrade request to send to the upstream.
 * Preserves Upgrade, Connection, and all Sec-WebSocket-* headers verbatim.
 * This is a raw TCP pass-through, not a stripped proxy.
 */
function buildUpstreamUpgradeRequest(request: IncomingMessage): string {
  const method = request.method || 'GET';
  const url = request.url || '/';
  const httpVersion = request.httpVersion || '1.1';
  const lines: string[] = [`${method} ${url} HTTP/${httpVersion}`];

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        lines.push(`${name}: ${v}`);
      }
    } else {
      lines.push(`${name}: ${value}`);
    }
  }

  return lines.join('\r\n') + '\r\n\r\n';
}

/**
 * Dependencies for handleProxyUpgrade (injected for testability).
 */
interface ProxyUpgradeDeps {
  getDb: () => unknown;
  getCache: (db: unknown) => { getByPathPrefix: (p: string) => Promise<ExternalApp | null | undefined> };
  netConnect: (opts: { host: string; port: number }) => NetSocket | Duplex;
}

/**
 * Handle a WebSocket upgrade request targeted at /proxy/<prefix>/...
 * by TCP-piping it to the configured External App upstream.
 *
 * - Rejects malformed, missing, disabled, non-websocket-enabled apps.
 * - Rejects non-loopback target hosts (SSRF defense).
 * - On success, pipes bytes in both directions without touching the WS protocol.
 *
 * Issue #671.
 */
export async function handleProxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  _head: Buffer,
  deps: ProxyUpgradeDeps
): Promise<void> {
  const url = request.url || '/';
  // /proxy/<prefix>/... → segment index 2 is the prefix
  const segments = url.split('?')[0].split('/');
  const pathPrefix = segments[2] || '';

  if (!pathPrefix) {
    writeRawResponseAndDestroy(socket, '400 Bad Request');
    return;
  }

  let app: ExternalApp | null | undefined;
  try {
    const db = deps.getDb();
    const cache = deps.getCache(db);
    app = await cache.getByPathPrefix(pathPrefix);
  } catch (err) {
    logger.error('ws-proxy:cache-error', {
      pathPrefix,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!socket.destroyed && socket.writable) {
      writeRawResponseAndDestroy(socket, '502 Bad Gateway');
    }
    return;
  }

  // After awaiting, the client socket may have gone away.
  if (socket.destroyed || !socket.writable) {
    return;
  }

  if (!app) {
    writeRawResponseAndDestroy(socket, '404 Not Found');
    return;
  }

  if (!app.enabled) {
    writeRawResponseAndDestroy(socket, '503 Service Unavailable');
    return;
  }

  if (!app.websocketEnabled) {
    writeRawResponseAndDestroy(socket, '403 Forbidden');
    return;
  }

  if (!PROXY_ALLOWED_HOSTS.has(app.targetHost)) {
    // Do not log host/port; only pathPrefix.
    logger.warn('ws-proxy:ssrf-blocked', { pathPrefix });
    writeRawResponseAndDestroy(socket, '403 Forbidden');
    return;
  }

  // Establish upstream TCP connection and wire up bidirectional piping.
  const upstream = deps.netConnect({ host: app.targetHost, port: app.targetPort });
  let upstreamConnected = false;
  let teardownCalled = false;

  const teardown = (): void => {
    if (teardownCalled) return;
    teardownCalled = true;
    try {
      upstream.destroy();
    } catch {
      // ignore
    }
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  };

  upstream.on('connect', () => {
    upstreamConnected = true;
    try {
      const rawRequest = buildUpstreamUpgradeRequest(request);
      upstream.write(rawRequest);
    } catch (writeErr) {
      logger.error('ws-proxy:upstream-write-error', {
        pathPrefix,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
      teardown();
      return;
    }

    // Raw TCP pass-through: upstream and client exchange bytes directly.
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (err: Error) => {
    logger.error('ws-proxy:upstream-error', {
      pathPrefix,
      error: err.message,
    });
    if (!upstreamConnected && !socket.destroyed && socket.writable) {
      writeRawResponseAndDestroy(socket, '502 Bad Gateway');
    } else {
      teardown();
    }
  });

  upstream.on('close', () => {
    teardown();
  });

  socket.on('error', (err: Error) => {
    logger.error('ws-proxy:client-error', {
      pathPrefix,
      error: err.message,
    });
    teardown();
  });

  socket.on('close', () => {
    teardown();
  });
}

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

  // Issue #2220: this instance now owns the sockets, so publish the capability
  // the other module instances have to borrow. Registered before anything can
  // subscribe, and only from here — `setupWebSocket` is the one function that
  // makes a `rooms` map real, so it is the one function allowed to claim the
  // registry. Everything the registry hands out is a closure over the maps
  // below; the maps themselves never leave this module.
  publisherHandle = registerRoomPublisher(localRoomPublisher);

  // Issue #1788: publish the waiting edge to the worktree room. Started here
  // rather than at module scope so the listener's lifetime matches the server's
  // — and so the closure it registers is the one holding *this* bundle's `rooms`
  // map, which is what a broadcast has to reach.
  startWaitingStatusBroadcast(handleBroadcast);

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
        logger.warn('websocket:denied', { ip: safeIp });
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

    // Issue #671: External Apps WebSocket TCP proxy.
    // /proxy/<prefix>/... upgrades are forwarded to the upstream app's TCP port.
    // Everything else falls through to the built-in WSS (broadcast, terminal, etc.).
    if (pathname.startsWith('/proxy/')) {
      void (async () => {
        try {
          await handleProxyUpgrade(request, socket, head, {
            getDb: () => getDbInstance(),
            getCache: (db) => getExternalAppCache(db as never),
            netConnect: (opts) => netConnectImpl(opts),
          });
        } catch (err) {
          logger.error('ws-proxy:unhandled-error', {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!socket.destroyed && socket.writable) {
            try {
              socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            } catch {
              // ignore
            }
            socket.destroy();
          }
        }
      })();
      return;
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  // Handle WebSocket server errors (e.g., invalid frames from clients)
  wss.on('error', (error) => {
    logger.error('server:error', { error: error.message });
  });

  wss.on('connection', (ws: WebSocket) => {
    // Connection logging removed to reduce noise

    // Initialize client info
    const clientInfo: ClientInfo = {
      ws,
      worktreeIds: new Set(),
      terminalSubscription: null,
    };
    clients.set(ws, clientInfo);

    // Issue #573: Removed _socket direct access (as unknown as pattern).
    // ws.on('error') handler below covers socket-level errors because the ws library
    // internally propagates underlying socket errors to the WebSocket 'error' event
    // (see ws lib: WebSocket.js sets up _socket.on('error') -> this.emit('error')).
    // ws.terminate() is equivalent to _socket.destroy() as it internally calls
    // this._socket.destroy() (ws lib README: "Immediately destroys the connection").

    // Handle messages
    ws.on('message', (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (parseError) {
        logger.error('message:parse-failed', { error: parseError instanceof Error ? parseError.message : String(parseError) });
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
        logger.error('websocket:error', { error: error.message });
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

    case CLIENT_VERSION_MESSAGE_TYPE:
      handleClientVersion(ws, message);
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
      logger.warn('message:unknown-type');
  }
}

/**
 * Handle a client-version hello (#1338/#1356/#2271).
 *
 * The client announces the version its bundle was built from on every
 * (re)connect. `resolveBundleDrift` compares that against the version of the
 * bundle **this server is serving** and answers null unless the two builds
 * really differ; on drift, reply with a version_mismatch event so the tab can
 * surface a reload nudge.
 *
 * Issue #2271: this used to ask `getServerVersion()`, i.e. the installed
 * package.json. Releases bump that file without rebuilding the running server's
 * `.next` — by design — so the comparison was permanently unequal and every tab
 * carried an undismissable banner. The resolver, not this handler, is where
 * "what counts as drift" is defined; keep it that way.
 */
function handleClientVersion(ws: WebSocket, message: WebSocketMessage): void {
  const clientVersion = typeof message.version === 'string' ? message.version : '';
  if (!clientVersion) return;

  const drift = resolveBundleDrift(clientVersion);
  if (!drift) return;

  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        type: VERSION_MISMATCH_EVENT_TYPE,
        serverVersion: drift.serverVersion,
        clientVersion: drift.clientVersion,
      }),
    );
  } catch (error) {
    logger.error('version:notify-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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
          logger.error('broadcast:send-failed', { error: sendError instanceof Error ? sendError.message : String(sendError) });
        }
      }
    });
  } catch (broadcastError) {
    logger.error('broadcast:failed', { worktreeId, error: broadcastError instanceof Error ? broadcastError.message : String(broadcastError) });
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
      logger.error('fallback:send-failed', { error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
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

  const sessionName = resolveSessionName(cliToolId, worktreeId);
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

// ---------------------------------------------------------------------------
// Issue #2220: cross-instance routing
//
// Everything below the line reads `rooms` / `clients`; everything above the
// public API forwards to whichever module instance actually has them. The four
// exported entry points (`broadcast`, `hasRoomSubscribers`, `cleanupRooms`,
// `migrateWorktreeRooms`) keep their signatures, so no producer had to change:
// a route handler importing `broadcastMessage` from this module now lands on
// the custom server's sockets without knowing it crossed a bundle.
//
// (Spelling that import out as source text here would be a mistake: the cycle
// guard in tests/unit/guards/no-ws-server-manager-cycle-1984.test.ts parses
// comments too, and reads a specifier in one as a real edge.)
// ---------------------------------------------------------------------------

/** {@link hasRoomSubscribers} against *this* instance's maps. */
function hasLocalRoomSubscribers(worktreeId: string): boolean {
  const room = rooms.get(worktreeId);
  return !!room && room.size > 0;
}

/**
 * This instance's capability, as published to the registry.
 *
 * Identity matters, not just shape: {@link remoteRoomPublisher} compares
 * against this exact object to tell "someone else owns the sockets" from "I do".
 * Without that check the owner would forward to itself and recurse.
 */
const localRoomPublisher: RoomPublisher = {
  publish: handleBroadcast,
  hasSubscribers: hasLocalRoomSubscribers,
  cleanupRooms: cleanupLocalRooms,
  migrateRooms: migrateLocalWorktreeRooms,
};

/**
 * The owning instance's publisher, when that instance is not this one.
 *
 * Returns null in the two cases where the local maps are already the right
 * target: this instance is the owner, or nothing has claimed the rooms at all
 * (a unit test that never stood a server up, or the CLI). The second case
 * preserves the pre-#2220 behaviour exactly — an unowned publish still writes
 * to whatever the caller's own `rooms` holds, rather than becoming a hard
 * failure.
 */
function remoteRoomPublisher(): RoomPublisher | null {
  const publisher = getRoomPublisher();
  return publisher && publisher !== localRoomPublisher ? publisher : null;
}

/**
 * Report the one state in which a frame is silently lost: nobody owns the rooms
 * and this instance has none of its own.
 *
 * Deliberately not "the room was empty" — an empty room is the normal answer
 * for a worktree nobody has open. This is narrower and always a defect: it says
 * the process has no publisher, which is what #2220 looked like from the
 * outside while every browser still reported its socket as `connected`.
 */
function noteIfUnroutable(operation: string, worktreeId: string): void {
  if (getRoomPublisher() === null && rooms.size === 0) {
    recordUnroutedPublish(operation, worktreeId);
  }
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
  const owner = remoteRoomPublisher();
  if (owner) {
    owner.publish(worktreeId, data);
    return;
  }
  noteIfUnroutable('broadcast', worktreeId);
  handleBroadcast(worktreeId, data);
}

/**
 * Whether a worktree room currently has at least one subscribed client.
 *
 * Issue #1120: lets the server-side terminal streamer skip the (relatively
 * expensive) tmux capture + detection work when nobody is watching the room.
 *
 * Issue #2220: bridged as well, and not as an afterthought.
 * `broadcastTerminalSnapshot` and `emitChatTurnProgress` call this *first* and
 * return early on `false`, so a caller reading its own empty `rooms` never
 * reaches the publish at all — bridging only `broadcast` would have left the
 * terminal snapshot and `chat_turn_progress` exactly as broken as before.
 *
 * @param worktreeId - Worktree identifier
 */
export function hasRoomSubscribers(worktreeId: string): boolean {
  const owner = remoteRoomPublisher();
  if (owner) return owner.hasSubscribers(worktreeId);
  noteIfUnroutable('hasRoomSubscribers', worktreeId);
  return hasLocalRoomSubscribers(worktreeId);
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
    // Issue #2220: through `broadcast`, not straight into `handleBroadcast` —
    // this is the entry point every history producer uses, and it was the one
    // reaching the caller's own empty `rooms`.
    broadcast(data.worktreeId, { type, ...data });
  } else {
    logger.warn('broadcast:missing-worktree-id');
  }
}

/**
 * Message type sent to a room whose worktree ID has been renamed
 * (Issue #1621 Phase 3).
 *
 * Clients that do not understand it ignore it (`parseRealtimeEvent` drops
 * unknown types), so it is safe to emit to every subscriber; the point is that
 * a browser holding the old ID can learn the new one without a reload.
 */
export const WORKTREE_RENAMED_EVENT_TYPE = 'worktree_renamed' as const;

/**
 * Move every WebSocket subscription from a renamed worktree ID to the new one
 * (Issue #1621 Phase 3).
 *
 * Two things are keyed on the worktree ID here, and both have to move together
 * because they are the write side and the read side of the same pair:
 *
 * 1. the **room** (`rooms`, plus each client's `worktreeIds` set) — every
 *    server-side `broadcast(worktreeId, …)` after the rename uses the NEW ID,
 *    so a room left under the old key goes silent while its clients still
 *    believe they are subscribed;
 * 2. the **terminal subscription's session name** — derived from the worktree ID
 *    (`mcbd-<cli>-<id>`) and cached on the subscription, so `terminal_input` /
 *    `terminal_resize` would keep addressing a tmux session that no longer
 *    answers to that name.
 *
 * Every affected subscriber is then notified, so a client can re-point its own
 * state instead of waiting for a reload.
 *
 * Takes the whole batch because IDs can swap (A→B, B→A): all source rooms are
 * detached before any destination room is written. Where a destination room
 * already exists the two sets are merged rather than replaced — dropping the
 * incumbent subscribers would silence clients that did nothing wrong.
 *
 * Issue #2220: bridged like the publish paths. A rename is applied from
 * `/worktrees` and from the repository routes, i.e. from a bundle that owns no
 * rooms; migrating only the caller's own empty map would leave the live
 * subscribers stranded under the old key and silence them for good.
 *
 * @param renames - Worktree ID pairs being applied
 * @returns The pairs that actually had room subscribers to move
 */
export function migrateWorktreeRooms(
  renames: ReadonlyArray<RoomRename>
): RoomMigrationResult[] {
  const owner = remoteRoomPublisher();
  if (owner) return owner.migrateRooms(renames);
  return migrateLocalWorktreeRooms(renames);
}

/** {@link migrateWorktreeRooms} against *this* instance's maps. */
function migrateLocalWorktreeRooms(
  renames: ReadonlyArray<RoomRename>
): RoomMigrationResult[] {
  const targets = new Map<string, string>();
  for (const { oldId, newId } of renames) {
    if (!oldId || !newId || oldId === newId) continue;
    targets.set(oldId, newId);
  }
  if (targets.size === 0) return [];

  // Detach first, write second — a swap must not have one half clobber the other.
  const detached: Array<{ oldId: string; newId: string; sockets: Set<WebSocket> }> = [];
  for (const [oldId, newId] of targets) {
    const room = rooms.get(oldId);
    if (!room || room.size === 0) continue;
    rooms.delete(oldId);
    detached.push({ oldId, newId, sockets: room });
  }

  const moved: Array<{ oldId: string; newId: string; subscribers: number }> = [];
  for (const { oldId, newId, sockets } of detached) {
    const destination = rooms.get(newId) ?? new Set<WebSocket>();
    for (const ws of sockets) {
      destination.add(ws);
      const clientInfo = clients.get(ws);
      if (clientInfo) {
        clientInfo.worktreeIds.delete(oldId);
        clientInfo.worktreeIds.add(newId);
      }
      sendTerminalEvent(ws, {
        type: WORKTREE_RENAMED_EVENT_TYPE,
        worktreeId: newId,
        previousWorktreeId: oldId,
      });
    }
    rooms.set(newId, destination);
    moved.push({ oldId, newId, subscribers: sockets.size });
  }

  // Terminal subscriptions live on the client, not in the room, so they are
  // swept separately: a client can stream a terminal without joining the room.
  for (const clientInfo of clients.values()) {
    const subscription = clientInfo.terminalSubscription;
    if (!subscription) continue;
    const newId = targets.get(subscription.worktreeId);
    if (!newId) continue;

    try {
      if (!isCliToolType(subscription.cliToolId)) continue;
      subscription.sessionName = resolveSessionName(subscription.cliToolId, newId);
      subscription.worktreeId = newId;
    } catch (error) {
      logger.warn('terminal:rename-failed', {
        worktreeId: subscription.worktreeId,
        newId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (moved.length > 0) {
    logger.info('rooms:migrated', { count: moved.length });
  }
  return moved;
}

/**
 * Clean up WebSocket rooms for deleted worktrees
 * Removes rooms from the rooms map (clients will naturally disconnect or resubscribe)
 *
 * Issue #2220: bridged. `/repositories` DELETE is the main caller and runs in a
 * route bundle, so before the bridge it swept a map that was empty anyway and
 * the owner kept the rooms of deleted worktrees for the life of the process.
 *
 * @param worktreeIds - Array of worktree IDs to clean up
 *
 * @example
 * ```typescript
 * cleanupRooms(['wt-1', 'wt-2', 'wt-3']);
 * ```
 */
export function cleanupRooms(worktreeIds: string[]): void {
  const owner = remoteRoomPublisher();
  if (owner) {
    owner.cleanupRooms(worktreeIds);
    return;
  }
  cleanupLocalRooms(worktreeIds);
}

/** {@link cleanupRooms} against *this* instance's maps. */
function cleanupLocalRooms(worktreeIds: string[]): void {
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
  // Issue #2220: hand back the token rather than clearing the registry, and read
  // the answer. If a newer `setupWebSocket` has already taken over — HMR, or a
  // suite standing a second server up — this instance is not the owner any more,
  // the withdrawal is declined, and the live publisher stays in place.
  const wasOwner = publisherHandle !== null && publisherHandle.unregister();
  publisherHandle = null;

  // Issue #1788: drop the waiting-edge subscription before `wss` goes, or it
  // outlives the server and CI shares one process across the whole suite.
  //
  // Issue #2220: but only when this instance was the owner, or when nobody is.
  // That subscription is a single `globalThis` slot by design, so a superseded
  // instance closing down would otherwise take the *running* server's waiting
  // edge with it — the same hazard the token guard above exists for. The
  // "nobody owns it" arm keeps the defensive teardown that suites rely on when
  // they start a subscription by hand and never call `setupWebSocket`.
  if (wasOwner || getRoomPublisher() === null) {
    stopWaitingStatusBroadcast();
  }

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
  handleClientVersion,
  handleProxyUpgrade,
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
