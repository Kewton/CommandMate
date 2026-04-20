/**
 * WebSocket Server /proxy/<prefix> upgrade handler unit tests
 * Issue #671: External Apps WebSocket TCP proxy
 *
 * Tests the handleProxyUpgrade() helper exposed via __internal.
 * Covers branching for missing prefix, cache miss, disabled app,
 * websocketEnabled=false, non-localhost targetHost (SSRF defense),
 * upstream connect success/failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';

// Helper: build a socket stub that records writes and destroy calls
interface SocketStub extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  writable: boolean;
}

function createSocketStub(): SocketStub {
  const emitter = new EventEmitter() as SocketStub;
  emitter.write = vi.fn();
  emitter.destroy = vi.fn(() => {
    emitter.destroyed = true;
  });
  emitter.pipe = vi.fn();
  emitter.destroyed = false;
  emitter.writable = true;
  return emitter;
}

interface UpstreamStub extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createUpstreamStub(): UpstreamStub {
  const emitter = new EventEmitter() as UpstreamStub;
  emitter.write = vi.fn();
  emitter.destroy = vi.fn();
  emitter.pipe = vi.fn();
  emitter.end = vi.fn();
  return emitter;
}

/** Build a minimal IncomingMessage-like object for the upgrade handler */
function createRequest(
  url: string,
  headersOverride: Record<string, string> = {}
): IncomingMessage {
  const req = {
    url,
    method: 'GET',
    httpVersion: '1.1',
    headers: {
      host: 'localhost:3000',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...headersOverride,
    },
  } as unknown as IncomingMessage;
  return req;
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    name: 'streamlit',
    displayName: 'Streamlit',
    pathPrefix: 'stl',
    targetPort: 8501,
    targetHost: '127.0.0.1',
    appType: 'streamlit',
    websocketEnabled: true,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ws-server handleProxyUpgrade', () => {
  let handleProxyUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    deps: {
      getDb: () => unknown;
      getCache: (db: unknown) => { getByPathPrefix: (p: string) => Promise<unknown> };
      netConnect: (opts: { host: string; port: number }) => unknown;
    }
  ) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    const wsServer = await import('@/lib/ws-server');
    // @ts-expect-error - __internal.handleProxyUpgrade is the DI entry point
    handleProxyUpgrade = wsServer.__internal.handleProxyUpgrade;
    expect(typeof handleProxyUpgrade).toBe('function');
  });

  it('returns 400 when pathPrefix is missing (/proxy/)', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/');
    const getCache = vi.fn();
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix: getCache }),
      netConnect: netConnect as never,
    });

    expect(socket.write).toHaveBeenCalled();
    const written = String(socket.write.mock.calls[0][0]);
    expect(written).toContain('400');
    expect(socket.destroy).toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('returns 404 when cache lookup returns null', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/unknown/_stcore/stream');
    const getByPathPrefix = vi.fn().mockResolvedValue(null);
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(getByPathPrefix).toHaveBeenCalledWith('unknown');
    expect(socket.write).toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0][0])).toContain('404');
    expect(socket.destroy).toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('returns 503 when app.enabled is false', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp({ enabled: false });
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(String(socket.write.mock.calls[0][0])).toContain('503');
    expect(socket.destroy).toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('returns 403 when app.websocketEnabled is false', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp({ websocketEnabled: false });
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(String(socket.write.mock.calls[0][0])).toContain('403');
    expect(socket.destroy).toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('returns 403 when targetHost is not localhost or 127.0.0.1 (SSRF defense)', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp({ targetHost: 'evil.example.com' });
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(String(socket.write.mock.calls[0][0])).toContain('403');
    expect(socket.destroy).toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('allows localhost as targetHost', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp({ targetHost: 'localhost', targetPort: 8501 });
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const upstream = createUpstreamStub();
    const netConnect = vi.fn().mockReturnValue(upstream);

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(netConnect).toHaveBeenCalledWith({ host: 'localhost', port: 8501 });
  });

  it('connects upstream via netConnect and forwards WS upgrade request on "connect"', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream', {
      'sec-websocket-key': 'TEST-KEY-123',
      'sec-websocket-protocol': 'streamlit',
    });
    const app = makeApp({ targetHost: '127.0.0.1', targetPort: 8501 });
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const upstream = createUpstreamStub();
    const netConnect = vi.fn().mockReturnValue(upstream);

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    expect(netConnect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8501 });

    // Trigger connect event -> upstream should receive the raw upgrade request
    upstream.emit('connect');

    // Upstream should have been written to with the upgrade request
    expect(upstream.write).toHaveBeenCalled();
    const payload = String(upstream.write.mock.calls[0][0]);
    expect(payload).toMatch(/^GET \/proxy\/stl\/_stcore\/stream HTTP\/1\.1\r\n/);
    expect(payload.toLowerCase()).toContain('upgrade: websocket');
    expect(payload.toLowerCase()).toContain('connection: upgrade');
    expect(payload.toLowerCase()).toContain('sec-websocket-key: test-key-123');
    expect(payload.toLowerCase()).toContain('sec-websocket-protocol: streamlit');
    // Final blank line separator must be present
    expect(payload.endsWith('\r\n\r\n')).toBe(true);

    // Bidirectional piping should be wired up
    expect(socket.pipe).toHaveBeenCalledWith(upstream);
    expect(upstream.pipe).toHaveBeenCalledWith(socket);
  });

  it('writes 502 and destroys client socket when upstream emits error before connect', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp();
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const upstream = createUpstreamStub();
    const netConnect = vi.fn().mockReturnValue(upstream);

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    // Trigger an error BEFORE 'connect' fires
    upstream.emit('error', new Error('ECONNREFUSED'));

    const written = socket.write.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('502');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('destroys client socket when upstream closes after connect', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp();
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const upstream = createUpstreamStub();
    const netConnect = vi.fn().mockReturnValue(upstream);

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    upstream.emit('connect');
    upstream.emit('close');

    expect(socket.destroy).toHaveBeenCalled();
  });

  it('destroys upstream when client socket closes', async () => {
    const socket = createSocketStub();
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp();
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const upstream = createUpstreamStub();
    const netConnect = vi.fn().mockReturnValue(upstream);

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    upstream.emit('connect');
    socket.emit('close');

    expect(upstream.destroy).toHaveBeenCalled();
  });

  it('does not proceed after await when socket already destroyed', async () => {
    const socket = createSocketStub();
    socket.destroyed = true;
    socket.writable = false;
    const req = createRequest('/proxy/stl/_stcore/stream');
    const app = makeApp();
    const getByPathPrefix = vi.fn().mockResolvedValue(app);
    const netConnect = vi.fn();

    await handleProxyUpgrade(req, socket as unknown as Duplex, Buffer.alloc(0), {
      getDb: () => ({}),
      getCache: () => ({ getByPathPrefix }),
      netConnect: netConnect as never,
    });

    // Should not even call netConnect since socket is already gone
    expect(netConnect).not.toHaveBeenCalled();
  });
});
