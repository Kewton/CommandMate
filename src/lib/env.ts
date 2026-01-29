/**
 * Environment variable configuration and validation
 * Provides type-safe access to environment variables
 *
 * Issue #76: Environment variable fallback support
 * Supports both new (CM_*) and legacy (MCBD_*) environment variable names
 */

import path from 'path';

// ============================================================
// Environment Variable Mapping (for fallback support)
// Issue #76: CommandMate rename - Phase 1
// ============================================================

/**
 * Environment variable mapping definition
 * New name -> Old name mapping for fallback support
 */
export const ENV_MAPPING = {
  CM_ROOT_DIR: 'MCBD_ROOT_DIR',
  CM_PORT: 'MCBD_PORT',
  CM_BIND: 'MCBD_BIND',
  CM_AUTH_TOKEN: 'MCBD_AUTH_TOKEN',
  CM_LOG_LEVEL: 'MCBD_LOG_LEVEL',
  CM_LOG_FORMAT: 'MCBD_LOG_FORMAT',
  CM_LOG_DIR: 'MCBD_LOG_DIR',
  CM_DB_PATH: 'MCBD_DB_PATH',
} as const;

export type EnvKey = keyof typeof ENV_MAPPING;

/**
 * Set to track warned keys and prevent duplicate warnings
 * Module-scoped to persist across function calls
 */
const warnedKeys = new Set<string>();

/**
 * Reset warned keys (for testing purposes)
 */
export function resetWarnedKeys(): void {
  warnedKeys.clear();
}

/**
 * Get environment variable with fallback support
 *
 * @param newKey - New environment variable name (CM_*)
 * @param oldKey - Old environment variable name (MCBD_*)
 * @returns Environment variable value (undefined if not set)
 */
export function getEnvWithFallback(newKey: string, oldKey: string): string | undefined {
  const newValue = process.env[newKey];
  if (newValue !== undefined) {
    return newValue;
  }

  const oldValue = process.env[oldKey];
  if (oldValue !== undefined) {
    if (!warnedKeys.has(oldKey)) {
      console.warn(`[DEPRECATED] ${oldKey} is deprecated, use ${newKey} instead`);
      warnedKeys.add(oldKey);
    }
    return oldValue;
  }

  return undefined;
}

/**
 * Get environment variable using ENV_MAPPING (type-safe version)
 *
 * @param key - New environment variable key (from ENV_MAPPING)
 * @returns Environment variable value (undefined if not set)
 */
export function getEnvByKey(key: EnvKey): string | undefined {
  return getEnvWithFallback(key, ENV_MAPPING[key]);
}

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
 * Get log configuration (with fallback support)
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
  const levelEnv = getEnvByKey('CM_LOG_LEVEL')?.toLowerCase();
  const formatEnv = getEnvByKey('CM_LOG_FORMAT')?.toLowerCase();

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
  CM_ROOT_DIR: string;

  /** Server port */
  CM_PORT: number;

  /** Bind address (127.0.0.1 or 0.0.0.0) */
  CM_BIND: string;

  /** Authentication token (optional for localhost) */
  CM_AUTH_TOKEN?: string;

  /** Database file path */
  CM_DB_PATH: string;
}

/**
 * Get and validate environment variables (with fallback support)
 *
 * @throws {Error} If required variables are missing or invalid
 * @returns Validated environment configuration
 *
 * @example
 * ```typescript
 * const env = getEnv();
 * console.log(`Root directory: ${env.CM_ROOT_DIR}`);
 * ```
 */
export function getEnv(): Env {
  // Get raw values with defaults (using fallback support)
  const rootDir = getEnvByKey('CM_ROOT_DIR') || process.cwd();
  const port = parseInt(getEnvByKey('CM_PORT') || '3000', 10);
  const bind = getEnvByKey('CM_BIND') || '127.0.0.1';
  const authToken = getEnvByKey('CM_AUTH_TOKEN');
  const databasePath = getEnvByKey('CM_DB_PATH')
    || process.env.DATABASE_PATH
    || path.join(process.cwd(), 'data', 'db.sqlite');

  // Validate values
  if (!rootDir) {
    throw new Error('CM_ROOT_DIR (or MCBD_ROOT_DIR) is required');
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CM_PORT: ${getEnvByKey('CM_PORT')}. Must be between 1 and 65535.`);
  }

  if (bind !== '127.0.0.1' && bind !== '0.0.0.0' && bind !== 'localhost') {
    throw new Error(`Invalid CM_BIND: ${bind}. Must be '127.0.0.1', '0.0.0.0', or 'localhost'.`);
  }

  // Require auth token for public binding
  if (bind === '0.0.0.0' && !authToken) {
    throw new Error('CM_AUTH_TOKEN (or MCBD_AUTH_TOKEN) is required when CM_BIND=0.0.0.0');
  }

  return {
    CM_ROOT_DIR: path.resolve(rootDir),
    CM_PORT: port,
    CM_BIND: bind,
    CM_AUTH_TOKEN: authToken,
    CM_DB_PATH: path.resolve(databasePath),
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
  return env.CM_BIND === '0.0.0.0';
}
