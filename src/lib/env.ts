/**
 * Environment variable configuration and validation
 * Provides type-safe access to environment variables
 *
 * Issue #76: Environment variable fallback support
 * Supports both new (CM_*) and legacy (MCBD_*) environment variable names
 *
 * Issue #135: DB path resolution fix
 * Uses getDefaultDbPath() from db-path-resolver.ts for consistent DB path handling
 */

import path from 'path';
import { getDefaultDbPath, validateDbPath } from './db-path-resolver';

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
// [Issue #135] DATABASE_PATH Deprecation Support
// ============================================================

/**
 * Set to track warned keys for DATABASE_PATH deprecation (separate from ENV_MAPPING warnings)
 */
let databasePathWarned = false;

/**
 * Reset DATABASE_PATH warning state (for testing purposes)
 */
export function resetDatabasePathWarning(): void {
  databasePathWarned = false;
}

/**
 * Get DATABASE_PATH with deprecation warning
 *
 * SEC-004: Logs security event when deprecated DATABASE_PATH is used
 *
 * @returns DATABASE_PATH value if set, undefined otherwise
 */
export function getDatabasePathWithDeprecationWarning(): string | undefined {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    if (!databasePathWarned) {
      console.warn('[DEPRECATED] DATABASE_PATH is deprecated. Use CM_DB_PATH instead.');
      databasePathWarned = true;
    }
  }
  return dbPath;
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

  /** Database file path */
  CM_DB_PATH: string;

  /** Issue #331: SHA-256 hash of authentication token (optional) */
  CM_AUTH_TOKEN_HASH?: string;

  /** Issue #331: Token expiration duration (optional, e.g., "24h") */
  CM_AUTH_EXPIRE?: string;

  /** Issue #331: Path to TLS certificate file (optional) */
  CM_HTTPS_CERT?: string;

  /** Issue #331: Path to TLS private key file (optional) */
  CM_HTTPS_KEY?: string;

  /** Issue #332: Allowed IP addresses/CIDR ranges (comma-separated, optional) */
  CM_ALLOWED_IPS?: string;

  /** Issue #332: Trust reverse proxy X-Forwarded-For header ('true'/'false', optional) */
  CM_TRUST_PROXY?: string;
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
  // Issue #135: DB path resolution with proper fallback chain
  // Priority: CM_DB_PATH > DATABASE_PATH (deprecated) > getDefaultDbPath()
  const databasePath = getEnvByKey('CM_DB_PATH')
    || getDatabasePathWithDeprecationWarning()
    || getDefaultDbPath();

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

  // Issue #135: Validate DB path for security (SEC-001)
  let validatedDbPath: string;
  try {
    validatedDbPath = validateDbPath(databasePath);
  } catch {
    // If validation fails, fall back to default path
    // This can happen if DATABASE_PATH points to a system directory
    console.warn(`[Security] Invalid DB path "${databasePath}", using default.`);
    validatedDbPath = validateDbPath(getDefaultDbPath());
  }

  return {
    CM_ROOT_DIR: path.resolve(rootDir),
    CM_PORT: port,
    CM_BIND: bind,
    CM_DB_PATH: validatedDbPath,
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
