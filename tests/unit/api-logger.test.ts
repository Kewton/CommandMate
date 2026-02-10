/**
 * API Logger Unit Tests
 * Tests for withLogging() higher-order function
 *
 * Issue #11: API logging for development environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Use vi.hoisted() so the mock logger is available when vi.mock is hoisted
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});

// Mock the logger module before importing the module under test
vi.mock('@/lib/logger', () => {
  return {
    createLogger: vi.fn(() => mockLogger),
  };
});

import { withLogging } from '@/lib/api-logger';

/**
 * Helper to set NODE_ENV in tests.
 * Next.js types declare NODE_ENV as read-only, so we use a type assertion.
 */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe('withLogging', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setNodeEnv(originalEnv ?? 'test');
  });

  /**
   * Helper to create a mock NextRequest
   */
  function createMockRequest(url: string, method = 'GET'): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), { method });
  }

  /**
   * Helper to create a simple handler that returns JSON
   */
  function createMockHandler(body: Record<string, unknown> = { ok: true }, status = 200) {
    return vi.fn(async () => {
      return NextResponse.json(body, { status });
    });
  }

  // ---------------------------------------------------------------
  // Test 1: Logs request/response in development environment
  // ---------------------------------------------------------------
  it('should log request and response in development environment', async () => {
    setNodeEnv('development');
    const handler = createMockHandler({ message: 'hello' }, 200);
    const wrappedHandler = withLogging(handler);

    const request = createMockRequest('http://localhost:3000/api/worktrees/wt-1/logs?cliTool=claude');
    const context = { params: { id: 'wt-1' } };

    await wrappedHandler(request, context);

    // Should log request info
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('request'),
      expect.objectContaining({
        method: 'GET',
        path: '/api/worktrees/wt-1/logs',
      })
    );
    // Should log response info
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('response'),
      expect.objectContaining({
        status: 200,
      })
    );
  });

  // ---------------------------------------------------------------
  // Test 2: No logging in production
  // ---------------------------------------------------------------
  it('should not log in production environment', async () => {
    setNodeEnv('production');
    const handler = createMockHandler();
    const wrappedHandler = withLogging(handler);

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await wrappedHandler(request, context);

    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // Test 3: No logging when NODE_ENV=test
  // ---------------------------------------------------------------
  it('should not log when NODE_ENV is test', async () => {
    setNodeEnv('test');
    const handler = createMockHandler();
    const wrappedHandler = withLogging(handler);

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await wrappedHandler(request, context);

    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // Test 4: Debug level logging when specified
  // ---------------------------------------------------------------
  it('should use debug level when logLevel option is debug', async () => {
    setNodeEnv('development');
    const handler = createMockHandler();
    const wrappedHandler = withLogging(handler, { logLevel: 'debug' });

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await wrappedHandler(request, context);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('request'),
      expect.any(Object)
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('response'),
      expect.any(Object)
    );
  });

  // ---------------------------------------------------------------
  // Test 5: Truncates response body > 1KB
  // ---------------------------------------------------------------
  it('should truncate response body longer than maxResponseBodyLength', async () => {
    setNodeEnv('development');
    const largeBody = { data: 'x'.repeat(2000) };
    const handler = createMockHandler(largeBody);
    const wrappedHandler = withLogging(handler, { maxResponseBodyLength: 1024 });

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await wrappedHandler(request, context);

    // Find the response log call
    const responseCalls = mockLogger.info.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('response')
    );
    expect(responseCalls.length).toBeGreaterThan(0);
    const responseData = responseCalls[0][1] as Record<string, unknown>;
    expect(typeof responseData.body).toBe('string');
    expect((responseData.body as string).length).toBeLessThanOrEqual(1024 + 20); // Allow for "... [truncated]" suffix
    expect((responseData.body as string)).toContain('[truncated]');
  });

  // ---------------------------------------------------------------
  // Test 6: Skips response body when skipResponseBody=true
  // ---------------------------------------------------------------
  it('should skip response body logging when skipResponseBody is true', async () => {
    setNodeEnv('development');
    const handler = createMockHandler({ secret: 'data' });
    const wrappedHandler = withLogging(handler, { skipResponseBody: true });

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await wrappedHandler(request, context);

    const responseCalls = mockLogger.info.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('response')
    );
    expect(responseCalls.length).toBeGreaterThan(0);
    const responseData = responseCalls[0][1] as Record<string, unknown>;
    expect(responseData.body).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // Test 7: Returns original handler response unchanged
  // ---------------------------------------------------------------
  it('should return the original handler response unchanged', async () => {
    setNodeEnv('development');
    const expectedBody = { id: 1, name: 'test' };
    const handler = createMockHandler(expectedBody, 201);
    const wrappedHandler = withLogging(handler);

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    const response = await wrappedHandler(request, context);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual(expectedBody);
  });

  // ---------------------------------------------------------------
  // Test 8: Propagates handler errors
  // ---------------------------------------------------------------
  it('should propagate handler errors', async () => {
    setNodeEnv('development');
    const testError = new Error('Handler failed');
    const handler = vi.fn(async () => {
      throw testError;
    });
    const wrappedHandler = withLogging(handler);

    const request = createMockRequest('http://localhost:3000/api/test');
    const context = { params: {} };

    await expect(wrappedHandler(request, context)).rejects.toThrow('Handler failed');
  });

  // ---------------------------------------------------------------
  // Test 9: Generic type parameter is correctly inferred
  // ---------------------------------------------------------------
  it('should correctly type the generic parameter', async () => {
    setNodeEnv('development');

    // This test verifies that the generic type parameter works at compile time.
    // The handler receives the typed params through the context.
    const handler = vi.fn(async (
      _request: NextRequest,
      context: { params: { id: string; filename: string } | Promise<{ id: string; filename: string }> }
    ) => {
      const params = await Promise.resolve(context.params);
      return NextResponse.json({ id: params.id, filename: params.filename });
    });

    const wrappedHandler = withLogging<{ id: string; filename: string }>(handler);

    const request = createMockRequest('http://localhost:3000/api/worktrees/wt-1/logs/test.md');
    const context = { params: { id: 'wt-1', filename: 'test.md' } };

    const response = await wrappedHandler(request, context);
    const body = await response.json();

    expect(body).toEqual({ id: 'wt-1', filename: 'test.md' });
    expect(handler).toHaveBeenCalledWith(request, context);
  });

  // ---------------------------------------------------------------
  // Test 10: Does not access params directly
  // ---------------------------------------------------------------
  it('should not access params directly - uses request.nextUrl.pathname instead', async () => {
    setNodeEnv('development');
    const handler = createMockHandler();
    const wrappedHandler = withLogging(handler);

    // Create params as a Promise to simulate Next.js 15 behavior
    const paramsPromise = Promise.resolve({ id: 'wt-1' });
    // Add a spy to track if .then() is called on the Promise (params access)
    const thenSpy = vi.spyOn(paramsPromise, 'then');

    const request = createMockRequest('http://localhost:3000/api/worktrees/wt-1/logs');
    const context = { params: paramsPromise };

    await wrappedHandler(request, context);

    // The withLogging wrapper itself should NOT resolve params
    // Only the inner handler may do so
    // The path should come from request.nextUrl.pathname, not from params
    const requestCalls = mockLogger.info.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('request')
    );
    expect(requestCalls.length).toBeGreaterThan(0);
    const requestData = requestCalls[0][1] as Record<string, unknown>;
    expect(requestData.path).toBe('/api/worktrees/wt-1/logs');

    // The then spy should not have been called by withLogging
    // (handler itself is mocked and does not access params)
    expect(thenSpy).not.toHaveBeenCalled();
  });
});
