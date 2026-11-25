/**
 * A fake HTTP server for Issue #4535's send-outcome tests.
 *
 * Real `http.createServer` on `127.0.0.1`, port 0, so a real `fetch` meets what
 * a front or a broken server actually sends: an empty 2xx, a non-JSON body, an
 * HTML 408, a 307/308 that `fetch` follows with the same body, a socket dropped
 * after the request arrived. `mockRoutes`-style `global.fetch` stubs cannot make
 * those (they never follow redirects and always answer JSON), so a test of the
 * three outcomes that used one would stay green with the guard removed.
 *
 * Every request is recorded per path, so a test can count the POSTs that reached
 * the handler (design I6). Close the server in `afterEach`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';

/** What one path answers. */
export type SendOutcomeRoute =
  | {
    /** Exactly this status, type and body. No `contentType` → no `content-type` header. */
    kind: 'reply';
    status: number;
    contentType?: string;
    body?: string;
  }
  | {
    /** `JSON.stringify(body)` with `application/json`. */
    kind: 'json';
    status: number;
    body: unknown;
  }
  | {
    /** A redirect to `location` (a path on this server, or a full URL). */
    kind: 'redirect';
    status: 301 | 302 | 303 | 307 | 308;
    location: string;
  }
  | {
    /** Read the whole request, then destroy the socket without answering. */
    kind: 'drop';
  };

export interface RecordedRequest {
  method: string;
  body: string;
}

export interface SendOutcomeServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  /** Every request to `path`, oldest first. */
  requests(path: string): RecordedRequest[];
  /** The bodies of the POSTs to `path`, oldest first. */
  posts(path: string): string[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function answer(route: SendOutcomeRoute | undefined, res: ServerResponse): void {
  if (route === undefined) {
    res.writeHead(404, { 'content-length': '0' });
    res.end();
    return;
  }
  switch (route.kind) {
    case 'reply': {
      const body = route.body ?? '';
      res.writeHead(route.status, {
        'content-length': String(Buffer.byteLength(body)),
        ...(route.contentType !== undefined ? { 'content-type': route.contentType } : {}),
      });
      res.end(body);
      return;
    }
    case 'json': {
      const body = JSON.stringify(route.body);
      res.writeHead(route.status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }
    case 'redirect':
      res.writeHead(route.status, { location: route.location, 'content-length': '0' });
      res.end();
      return;
    case 'drop':
      res.socket?.destroy();
      return;
  }
}

/**
 * Start a server answering `routes` (keyed by path, query ignored). Unlisted
 * paths answer 404 with no body.
 */
export async function startSendOutcomeServer(
  routes: Readonly<Record<string, SendOutcomeRoute>>
): Promise<SendOutcomeServer> {
  const recorded = new Map<string, RecordedRequest[]>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void readBody(req).then(
      (body) => {
        const list = recorded.get(path) ?? [];
        list.push({ method: req.method ?? '', body });
        recorded.set(path, list);
        answer(routes[path], res);
      },
      () => res.socket?.destroy(),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: (path) => [...(recorded.get(path) ?? [])],
    posts: (path) => (recorded.get(path) ?? []).filter((r) => r.method === 'POST').map((r) => r.body),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * A URL on `127.0.0.1` that nothing listens on: a port the OS just handed out
 * and that was closed again. A request to it fails with `ECONNREFUSED`.
 */
export async function refusedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
