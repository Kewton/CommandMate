/**
 * Proxy Logger Tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 * Issue #42: Proxy routing for multiple frontend applications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProxyLogEntry } from '@/lib/proxy/logger';
import type { Logger } from '@/lib/logger';

// Mock the logger module
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
}));

describe('Proxy Logger', () => {
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    withContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const { createLogger } = await import('@/lib/logger');
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(),
    };
    vi.mocked(createLogger).mockReturnValue(mockLogger as unknown as Logger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ProxyLogEntry type', () => {
    it('should have required fields', async () => {
      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-svelte',
        method: 'GET',
        path: '/page',
        statusCode: 200,
        responseTime: 50,
        isWebSocket: false,
      };

      expect(entry.timestamp).toBeDefined();
      expect(entry.pathPrefix).toBe('app-svelte');
      expect(entry.method).toBe('GET');
      expect(entry.path).toBe('/page');
      expect(entry.statusCode).toBe(200);
      expect(entry.responseTime).toBe(50);
      expect(entry.isWebSocket).toBe(false);
    });

    it('should allow optional error field', async () => {
      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-svelte',
        method: 'GET',
        path: '/page',
        statusCode: 502,
        responseTime: 0,
        isWebSocket: false,
        error: 'Connection refused',
      };

      expect(entry.error).toBe('Connection refused');
    });
  });

  describe('logProxyRequest', () => {
    it('should log successful request with info level', async () => {
      const { logProxyRequest } = await import('@/lib/proxy/logger');

      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-svelte',
        method: 'GET',
        path: '/page',
        statusCode: 200,
        responseTime: 50,
        isWebSocket: false,
      };

      logProxyRequest(entry);

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[Proxy]'),
        expect.objectContaining({ pathPrefix: 'app-svelte' })
      );
    });

    it('should log request with error using warn level', async () => {
      const { logProxyRequest } = await import('@/lib/proxy/logger');

      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-svelte',
        method: 'GET',
        path: '/page',
        statusCode: 502,
        responseTime: 0,
        isWebSocket: false,
        error: 'Connection refused',
      };

      logProxyRequest(entry);

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Proxy]'),
        expect.objectContaining({ error: 'Connection refused' })
      );
    });

    it('should format log message correctly', async () => {
      const { logProxyRequest } = await import('@/lib/proxy/logger');

      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-streamlit',
        method: 'POST',
        path: '/api/data',
        statusCode: 201,
        responseTime: 120,
        isWebSocket: false,
      };

      logProxyRequest(entry);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('POST /proxy/app-streamlit/api/data'),
        expect.any(Object)
      );
    });

    it('should log WebSocket requests', async () => {
      const { logProxyRequest } = await import('@/lib/proxy/logger');

      const entry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix: 'app-streamlit',
        method: 'GET',
        path: '/_stcore/stream',
        statusCode: 101,
        responseTime: 0,
        isWebSocket: true,
      };

      logProxyRequest(entry);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ isWebSocket: true })
      );
    });
  });

  describe('logProxyError', () => {
    it('should log error with error level', async () => {
      const { logProxyError } = await import('@/lib/proxy/logger');

      const error = new Error('ECONNREFUSED');
      error.stack = 'Error: ECONNREFUSED\n    at test.ts:1:1';

      logProxyError('app-svelte', 'GET', '/page', error);

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[Proxy]'),
        expect.objectContaining({
          pathPrefix: 'app-svelte',
          method: 'GET',
          path: '/page',
          error: 'ECONNREFUSED',
        })
      );
    });

    it('should include stack trace in log data', async () => {
      const { logProxyError } = await import('@/lib/proxy/logger');

      const error = new Error('Connection timeout');
      error.stack = 'Error: Connection timeout\n    at handler.ts:50:10';

      logProxyError('app-next2', 'POST', '/api/submit', error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          stack: expect.stringContaining('Connection timeout'),
        })
      );
    });
  });
});
