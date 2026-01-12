/**
 * Type definitions for infinite message loading functionality
 *
 * Used by useInfiniteMessages hook and related components.
 */

/**
 * Error codes for infinite message loading operations
 */
export type InfiniteMessagesErrorCode =
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'PARSE_ERROR'
  | 'UNKNOWN';

/**
 * Error state for infinite message loading
 *
 * Provides structured error information with retry capability indication.
 */
export interface InfiniteMessagesError {
  /** Error code for categorizing the error type */
  code: InfiniteMessagesErrorCode;
  /** Human-readable error message */
  message: string;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Original error object if available */
  originalError?: Error;
}

/**
 * Pagination state for message loading
 */
export interface PaginationState {
  /** Whether older messages are currently being loaded */
  isLoadingOlder: boolean;
  /** Whether newer messages are currently being loaded */
  isLoadingNewer: boolean;
  /** Current error state, null if no error */
  error: InfiniteMessagesError | null;
  /** Timestamp of last successful fetch */
  lastFetchTime: Date | null;
}

/**
 * Message cache structure for efficient message storage
 */
export interface MessageCacheEntry<T> {
  /** ID of the message */
  id: string;
  /** The message data */
  data: T;
  /** When the message was cached */
  cachedAt: Date;
}

/**
 * Options for creating an InfiniteMessagesError
 */
export interface CreateErrorOptions {
  /** The original error that occurred */
  error: unknown;
  /** Default message if error doesn't have one */
  defaultMessage?: string;
}

/**
 * Creates a structured InfiniteMessagesError from an unknown error
 *
 * @param options - Error creation options
 * @returns Structured error object
 */
export function createInfiniteMessagesError(
  options: CreateErrorOptions
): InfiniteMessagesError {
  const { error, defaultMessage = 'An error occurred' } = options;

  // Handle TypeError (typically network errors)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Network error occurred. Please check your connection.',
      retryable: true,
      originalError: error,
    };
  }

  // Handle Response objects (server errors)
  if (error instanceof Response) {
    if (error.status >= 500) {
      return {
        code: 'SERVER_ERROR',
        message: 'Server error occurred. Please try again later.',
        retryable: true,
      };
    }
    return {
      code: 'UNKNOWN',
      message: `Request failed with status ${error.status}`,
      retryable: error.status !== 404,
    };
  }

  // Handle SyntaxError (parse errors)
  if (error instanceof SyntaxError) {
    return {
      code: 'PARSE_ERROR',
      message: 'Failed to parse response. Please try again.',
      retryable: true,
      originalError: error,
    };
  }

  // Handle generic Error objects
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: error.message || defaultMessage,
      retryable: true,
      originalError: error,
    };
  }

  // Handle unknown error types
  return {
    code: 'UNKNOWN',
    message: defaultMessage,
    retryable: true,
  };
}
