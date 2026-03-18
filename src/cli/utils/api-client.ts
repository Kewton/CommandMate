/**
 * API Client for CLI Commands
 * Issue #518: HTTP communication layer with auth, error handling
 *
 * [DR1-01] Responsibilities separated:
 * - resolveAuthToken(): Token resolution (--token > CM_AUTH_TOKEN)
 * - handleApiError(): Error classification and user-friendly messages
 * - ApiClient: HTTP get/post with base URL and auth headers
 */

import { ExitCode } from '../types';

/** Maximum stop-pattern length [SEC4-06] */
export const MAX_STOP_PATTERN_LENGTH = 500;

/** Worktree ID validation pattern [SEC4-04] */
const WORKTREE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Validate worktree ID format [SEC4-04]
 * @param id - Worktree ID to validate
 * @returns True if valid
 */
export function isValidWorktreeId(id: string): boolean {
  return WORKTREE_ID_PATTERN.test(id) && id.length <= 200;
}

/**
 * Resolve authentication token from options or environment.
 * [SEC4-01] Warns on stderr when --token flag is used.
 *
 * @param options - Options object with optional token
 * @returns Resolved token or undefined
 */
export function resolveAuthToken(options?: { token?: string }): string | undefined {
  if (options?.token) {
    // [SEC4-01] Warn about token exposure in process list
    console.error(
      'Warning: --token flag exposes token in process list and shell history. Use CM_AUTH_TOKEN environment variable instead.'
    );
    return options.token;
  }
  return process.env.CM_AUTH_TOKEN;
}

/**
 * Error result from API operations
 */
export interface ApiErrorResult {
  message: string;
  exitCode: number;
}

/**
 * Classify API errors into user-friendly messages and exit codes.
 * [IA3-09] Covers: ECONNREFUSED, 400, 401/403, 404, 429, 500, timeout
 *
 * @param error - Error object or unknown
 * @param status - HTTP status code if available
 * @returns User-friendly error message and exit code
 */
export function handleApiError(error: unknown, status?: number): ApiErrorResult {
  // HTTP status-based errors
  if (status !== undefined) {
    switch (status) {
      case 400:
        return {
          message: 'Bad request. Check your input parameters.',
          exitCode: ExitCode.CONFIG_ERROR,
        };
      case 401:
      case 403:
        return {
          message: 'Authentication failed. Use --token <token> or set CM_AUTH_TOKEN environment variable.',
          exitCode: ExitCode.CONFIG_ERROR,
        };
      case 404:
        return {
          message: 'Resource not found. Check the worktree ID.',
          exitCode: ExitCode.UNEXPECTED_ERROR,
        };
      case 429:
        return {
          message: 'Rate limited. Please retry after a moment.',
          exitCode: ExitCode.DEPENDENCY_ERROR,
        };
      case 500:
      default:
        if (status >= 500) {
          return {
            message: 'Server error. Check server logs for details.',
            exitCode: ExitCode.UNEXPECTED_ERROR,
          };
        }
        return {
          message: `Unexpected HTTP status: ${status}`,
          exitCode: ExitCode.UNEXPECTED_ERROR,
        };
    }
  }

  // Network/connection errors
  if (error instanceof Error) {
    const msg = error.message || '';
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        message: 'Server is not running. Start it with: commandmate start',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
    if (error.name === 'AbortError' || msg.includes('timeout') || msg.includes('Timeout')) {
      return {
        message: 'Server did not respond in time. Check server status.',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
    if (error.name === 'TypeError') {
      return {
        message: 'Network error. Check your connection and server status.',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
  }

  return {
    message: 'An unexpected error occurred.',
    exitCode: ExitCode.UNEXPECTED_ERROR,
  };
}

/**
 * Check if a URL points to a localhost address.
 */
function isLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * API Client for CLI HTTP communication.
 * Uses Node.js built-in fetch. Handles auth headers and error mapping.
 */
export class ApiClient {
  private baseUrl: string;
  private token?: string;

  constructor(options?: { baseUrl?: string; token?: string }) {
    const port = process.env.CM_PORT || '3000';
    this.baseUrl = options?.baseUrl || `http://localhost:${port}`;
    this.token = resolveAuthToken(options);

    // [SEC4-02] Warn about HTTP to non-localhost
    if (this.token && !this.baseUrl.startsWith('https://') && !isLocalhost(this.baseUrl)) {
      console.error(
        'Warning: Connecting to remote server over HTTP. Auth token will be sent in plaintext. Use HTTPS for non-localhost connections.'
      );
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * HTTP GET request
   * [DR1-05] Generic type parameter specified at call site
   */
  async get<T>(path: string): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const errResult = handleApiError(null, response.status);
        throw new ApiError(errResult.message, errResult.exitCode, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const errResult = handleApiError(error);
      throw new ApiError(errResult.message, errResult.exitCode);
    }
  }

  /**
   * HTTP POST request
   * [DR1-05] Generic type parameter specified at call site
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errResult = handleApiError(null, response.status);
        throw new ApiError(errResult.message, errResult.exitCode, response.status);
      }

      // Handle 204 No Content
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const errResult = handleApiError(error);
      throw new ApiError(errResult.message, errResult.exitCode);
    }
  }
}

/**
 * API Error with exit code for CLI process.exit()
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
