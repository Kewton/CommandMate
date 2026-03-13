/**
 * Shared logger mock helper for tests
 *
 * Issue #480: console.log cleanup / logger unification
 *
 * Usage:
 * ```typescript
 * import { createMockLogger } from '../helpers/logger-mock';
 *
 * // At module level (before imports of modules that use logger):
 * const mockLogger = createMockLogger();
 * vi.mock('@/lib/logger', () => ({
 *   createLogger: vi.fn(() => mockLogger),
 *   generateRequestId: vi.fn(() => 'test-request-id'),
 * }));
 * ```
 */
import { vi } from 'vitest';

/**
 * Create a mock logger instance with vi.fn() for all methods
 */
export function createMockLogger() {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  // withContext returns the same mock logger for chaining
  mockLogger.withContext.mockReturnValue(mockLogger);
  return mockLogger;
}

/**
 * Setup vi.mock for @/lib/logger module.
 *
 * NOTE: Due to Vitest hoisting, vi.mock() calls must be at the top level
 * of the test file. This function is provided as a convenience for creating
 * the mock logger object, but the vi.mock() call itself should be written
 * directly in the test file.
 *
 * @returns Mock logger instance that can be used for assertions
 */
export function setupLoggerMock() {
  const mockLogger = createMockLogger();
  return {
    mockLogger,
    mockModule: {
      createLogger: vi.fn(() => mockLogger),
      generateRequestId: vi.fn(() => 'test-request-id'),
    },
  };
}
