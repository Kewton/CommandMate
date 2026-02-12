/**
 * API Logger - withLogging() higher-order function
 *
 * Issue #11: Development environment API request/response logging
 *
 * Wraps Next.js API route handlers to log request and response details
 * in development environment only. In production/test, the handler is
 * called directly without any logging overhead.
 *
 * Design decisions:
 * - Path extracted from request.nextUrl.pathname (NOT from params)
 *   to avoid Promise/non-Promise inconsistency in Next.js 14/15
 * - Response body read via response.clone() to avoid consuming the stream
 * - Truncation applied to prevent excessive log output
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

// ============================================================
// Type Definitions
// ============================================================

/**
 * Generic API handler type compatible with Next.js App Router
 * P represents the route params shape (e.g., { id: string })
 */
type ApiHandler<P extends Record<string, string> = Record<string, string>> = (
  request: NextRequest,
  context: { params: P | Promise<P> }
) => Promise<NextResponse>;

/**
 * Options for withLogging() behavior
 */
interface WithLoggingOptions {
  /** Log level to use. Default: 'info' */
  logLevel?: 'debug' | 'info';
  /** Maximum response body length to log. Default: 1024 (1KB) */
  maxResponseBodyLength?: number;
  /** Skip response body logging entirely. Default: false */
  skipResponseBody?: boolean;
}

// ============================================================
// Logger Instance
// ============================================================

const logger = createLogger('api');

// ============================================================
// withLogging() Implementation
// ============================================================

/**
 * Wraps an API route handler with request/response logging.
 *
 * Logging is only active when NODE_ENV === 'development'.
 * In production and test environments, the handler is called directly
 * with zero overhead.
 *
 * @param handler - The API route handler to wrap
 * @param options - Logging configuration options
 * @returns Wrapped handler with logging
 *
 * @example
 * ```typescript
 * export const GET = withLogging<{ id: string }>(async (request, context) => {
 *   const params = await context.params;
 *   return NextResponse.json({ id: params.id });
 * });
 * ```
 */
export function withLogging<P extends Record<string, string> = Record<string, string>>(
  handler: ApiHandler<P>,
  options?: WithLoggingOptions
): ApiHandler<P> {
  const {
    logLevel = 'info',
    maxResponseBodyLength = 1024,
    skipResponseBody = false,
  } = options ?? {};

  return async (request: NextRequest, context: { params: P | Promise<P> }): Promise<NextResponse> => {
    // Skip logging in non-development environments
    if (process.env.NODE_ENV !== 'development') {
      return handler(request, context);
    }

    const startTime = Date.now();
    const method = request.method;
    const path = request.nextUrl.pathname;
    const searchParams = request.nextUrl.search;

    // Log request
    const logFn = logLevel === 'debug' ? logger.debug : logger.info;
    logFn('request', {
      method,
      path,
      ...(searchParams && { searchParams }),
    });

    // Execute handler
    const response = await handler(request, context);

    // Log response
    const duration = Date.now() - startTime;
    const responseLogData: Record<string, unknown> = {
      status: response.status,
      duration: `${duration}ms`,
    };

    // Read and log response body unless skipped
    if (!skipResponseBody) {
      try {
        const cloned = response.clone();
        let bodyText = await cloned.text();
        if (bodyText.length > maxResponseBodyLength) {
          bodyText = bodyText.slice(0, maxResponseBodyLength) + '... [truncated]';
        }
        responseLogData.body = bodyText;
      } catch {
        // If body cannot be read, skip it silently
      }
    }

    logFn('response', responseLogData);

    return response;
  };
}
