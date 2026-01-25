/**
 * Environment variable configuration and validation
 * Provides type-safe access to environment variables
 */

import path from 'path';

// ============================================================
// [SF-1] Log Configuration
// ============================================================

/**
 * Log level type (defined here to avoid circular dependency with logger.ts)
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log configuration
 */
export interface LogConfig {
  level: LogLevel;
  format: 'json' | 'text';
}

/**
 * Validate log level
 */
function isValidLogLevel(level: string | undefined): level is LogLevel {
  return level !== undefined && ['debug', 'info', 'warn', 'error'].includes(level);
}

/**
 * Get log configuration
 *
 * @returns Log configuration with level and format
 *
 * @example
 * ```typescript
 * const config = getLogConfig();
 * console.log(config.level); // 'debug' in development, 'info' in production
 * console.log(config.format); // 'text' or 'json'
 * ```
 */
export function getLogConfig(): LogConfig {
  const levelEnv = process.env.MCBD_LOG_LEVEL?.toLowerCase();
  const formatEnv = process.env.MCBD_LOG_FORMAT?.toLowerCase();

  // Default: debug in development, info in production
  const defaultLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

  return {
    level: isValidLogLevel(levelEnv) ? levelEnv : defaultLevel,
    format: formatEnv === 'json' ? 'json' : 'text',
  };
}

// ============================================================
// Environment Configuration
// ============================================================

export interface Env {
  /** Root directory for worktree scanning */
  MCBD_ROOT_DIR: string;

  /** Server port */
  MCBD_PORT: number;

  /** Bind address (127.0.0.1 or 0.0.0.0) */
  MCBD_BIND: string;

  /** Authentication token (optional for localhost) */
  MCBD_AUTH_TOKEN?: string;

  /** Database file path */
  DATABASE_PATH: string;
}

/**
 * Get and validate environment variables
 *
 * @throws {Error} If required variables are missing or invalid
 * @returns Validated environment configuration
 *
 * @example
 * ```typescript
 * const env = getEnv();
 * console.log(`Root directory: ${env.MCBD_ROOT_DIR}`);
 * ```
 */
export function getEnv(): Env {
  // Get raw values with defaults
  const rootDir = process.env.MCBD_ROOT_DIR || process.cwd();
  const port = parseInt(process.env.MCBD_PORT || '3000', 10);
  const bind = process.env.MCBD_BIND || '127.0.0.1';
  const authToken = process.env.MCBD_AUTH_TOKEN;
  const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite');

  // Validate values
  if (!rootDir) {
    throw new Error('MCBD_ROOT_DIR is required');
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCBD_PORT: ${process.env.MCBD_PORT}. Must be between 1 and 65535.`);
  }

  if (bind !== '127.0.0.1' && bind !== '0.0.0.0' && bind !== 'localhost') {
    throw new Error(`Invalid MCBD_BIND: ${bind}. Must be '127.0.0.1', '0.0.0.0', or 'localhost'.`);
  }

  // Require auth token for public binding
  if (bind === '0.0.0.0' && !authToken) {
    throw new Error('MCBD_AUTH_TOKEN is required when MCBD_BIND=0.0.0.0');
  }

  return {
    MCBD_ROOT_DIR: path.resolve(rootDir),
    MCBD_PORT: port,
    MCBD_BIND: bind,
    MCBD_AUTH_TOKEN: authToken,
    DATABASE_PATH: path.resolve(databasePath),
  };
}

/**
 * Validate environment variables without throwing
 *
 * @returns Validation result with errors if any
 */
export function validateEnv(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    getEnv();
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof Error) {
      errors.push(error.message);
    }
    return { valid: false, errors };
  }
}

/**
 * Check if authentication is required based on bind address
 *
 * @returns True if authentication is required
 */
export function isAuthRequired(): boolean {
  const env = getEnv();
  return env.MCBD_BIND === '0.0.0.0';
}
