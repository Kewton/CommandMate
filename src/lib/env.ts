/**
 * Environment variable configuration and validation
 * Provides type-safe access to environment variables
 *
 * Issue #76: Environment variable fallback support
 * Supports both new (CM_*) and legacy (MCBD_*) environment variable names
 *
 * Issue #135: DB path resolution fix
 * Uses getDefaultDbPath() from db-path-resolver.ts for consistent DB path handling
 *
 * Issue #2132: startup self-check for ".env exists but nothing was loaded"
 * See {@link runDotenvSelfCheck}.
 */

import fs from 'fs';
import path from 'path';
import { getDefaultDbPath, validateDbPath } from './db/db-path-resolver';

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
// [Issue #2132] ".env is right there and none of it was loaded"
// ============================================================

/**
 * The environment shape this module's self-check reads.
 *
 * Same escape hatch `lib/push/vapid.ts` gives `inspectVapidConfig`: tests vary
 * the environment by passing one in, never by mutating `process.env`.
 */
export type DotenvCheckEnv = Record<string, string | undefined>;

/** What {@link inspectDotenvLoad} found. */
export interface DotenvLoadInspection {
  /** Absolute path of the `.env` that was read. */
  envPath: string;
  /** Assignment keys declared by the file, first-seen order, deduplicated. */
  declaredKeys: string[];
  /** The subset of {@link declaredKeys} that reached this process. */
  presentKeys: string[];
  /**
   * True when the file declares at least one key and NOT ONE of them is set.
   *
   * The all-or-nothing threshold is deliberate. A partially applied `.env` has
   * ordinary explanations — a key commented out mid-edit, a value deliberately
   * overridden on the command line — and warning about those would train the
   * reader to skip the line. Zero out of N has only one explanation: the load
   * never happened.
   */
  loadFailed: boolean;
}

/** `KEY`, `export KEY`, ` KEY ` — the assignment forms a `.env` line can take. */
const DOTENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The variable names a `.env` file declares, in file order, without duplicates.
 *
 * Values are never returned. `CM_VAPID_PRIVATE_KEY` lives in this file, and the
 * only reason to parse it here is to count how many of its NAMES arrived.
 */
export function parseDotenvKeys(contents: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = DOTENV_ASSIGNMENT.exec(line);
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Options for {@link inspectDotenvLoad} and {@link runDotenvSelfCheck}. */
export interface DotenvSelfCheckOptions {
  /** Directory holding `.env` (default: `process.cwd()`). */
  cwd?: string;
  /** Environment to inspect (default: `process.env`). */
  env?: DotenvCheckEnv;
  /** Where the report goes (default: `console.warn`). */
  warn?: (message: string) => void;
}

/**
 * Compare the `.env` on disk against the environment this process actually got.
 *
 * @returns `null` when there is nothing to compare — no `.env`, an unreadable
 *   one, or one that declares no variables. None of those is a fault worth a
 *   line of startup output.
 */
export function inspectDotenvLoad(
  options: DotenvSelfCheckOptions = {},
): DotenvLoadInspection | null {
  const { cwd = process.cwd(), env = process.env } = options;
  const envPath = path.join(cwd, '.env');

  let contents: string;
  try {
    if (!fs.existsSync(envPath)) return null;
    contents = fs.readFileSync(envPath, 'utf8');
  } catch {
    // Unreadable is a permissions question, not a loading question.
    return null;
  }

  const declaredKeys = parseDotenvKeys(contents);
  if (declaredKeys.length === 0) return null;

  const presentKeys = declaredKeys.filter((key) => env[key] !== undefined);

  return {
    envPath,
    declaredKeys,
    presentKeys,
    loadFailed: presentKeys.length === 0,
  };
}

/** How many key names the report is willing to print before it says "and N more". */
const DOTENV_REPORT_KEY_LIMIT = 8;

/**
 * The lines {@link runDotenvSelfCheck} prints — empty when the load worked.
 *
 * Exported so the wording is pinned by a test rather than by a screenshot.
 */
export function formatDotenvReportLines(inspection: DotenvLoadInspection): string[] {
  if (!inspection.loadFailed) return [];

  const shown = inspection.declaredKeys.slice(0, DOTENV_REPORT_KEY_LIMIT);
  const omitted = inspection.declaredKeys.length - shown.length;
  const names = omitted > 0 ? `${shown.join(', ')}, and ${omitted} more` : shown.join(', ');

  return [
    `[env] ${inspection.envPath} declares ${inspection.declaredKeys.length} variable(s) `
      + 'and NOT ONE of them is set in this process: '
      + `${names}.`,
    '[env] The server is running on defaults. Web Push, the database path and the '
      + 'worktree root are all configured through those variables, so this is very '
      + 'unlikely to be what you wanted.',
    '[env] Most likely cause (Issue #2132): the server was started by hand after '
      + '`source scripts/load-env.sh` from a shell that is not bash. That script now '
      + 'refuses instead of exporting nothing, so re-run it and read what it says.',
    '[env] Supported restart, no rebuild: ./scripts/restart-nobuild.sh  '
      + '(or ./scripts/start.sh --daemon)',
  ];
}

/**
 * Report, in one place at startup, that `.env` exists and none of it arrived.
 *
 * Same contract as `runVapidSelfCheck` in `lib/push/vapid.ts`, deliberately:
 * fail-open, never throws, never blocks `listen`, and a healthy install prints
 * NOTHING — which is what makes the presence of a line meaningful.
 *
 * It exists because the failure it names is invisible from inside the process.
 * Every consumer of these variables has a defensible default, so a server that
 * received none of them starts, listens, and answers requests; what it does not
 * do is send a single push notification, and it may open a different database
 * than the one the operator believes they are looking at. During the Epic #2002
 * device UAT the only signal was the VAPID warning, and reading it as "push is
 * broken" rather than "the environment is empty" cost two UAT rounds.
 *
 * @returns The inspection, or `null` when there was nothing to check.
 */
export function runDotenvSelfCheck(
  options: DotenvSelfCheckOptions = {},
): DotenvLoadInspection | null {
  const { warn = (message: string) => console.warn(message) } = options;

  try {
    const inspection = inspectDotenvLoad(options);
    if (!inspection) return null;
    for (const line of formatDotenvReportLines(inspection)) {
      warn(line);
    }
    return inspection;
  } catch {
    // A diagnostic must never be the reason a server fails to start.
    return null;
  }
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

/** Fallback port, shared by {@link getServerPort} and {@link getEnv}. */
const DEFAULT_PORT = 3000;

/**
 * The port this server listens on, for callers that only need the port.
 *
 * Distinct from {@link getEnv} in two ways that matter to its users: it does no
 * database-path resolution, and it never throws. Issue #1722 builds the hook
 * endpoint URL baked into every injected Claude settings file from this, on the
 * session-start path — where an unrelated `CM_DB_PATH` problem must not be able
 * to prevent an agent from starting, and a nonsense `CM_PORT` should degrade to
 * hooks pointing at the default port rather than to no session at all.
 *
 * @returns A port in [1, 65535]; {@link DEFAULT_PORT} when CM_PORT is unset or
 *   unusable
 */
export function getServerPort(): number {
  const raw = getEnvByKey('CM_PORT');
  if (!raw) return DEFAULT_PORT;

  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return DEFAULT_PORT;
  }
  return port;
}

// ============================================================
// Environment Configuration
// ============================================================

export interface Env {
  /** Root directory for worktree scanning */
  CM_ROOT_DIR: string;

  /**
   * Issue #1517: extra comma-separated directories the folder picker may browse
   * and register from. Read via `getAllowedBrowseRoots()`, which always unions
   * it with CM_ROOT_DIR.
   */
  CM_BROWSE_ROOTS?: string;

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
  const port = parseInt(getEnvByKey('CM_PORT') || String(DEFAULT_PORT), 10);
  const bind = getEnvByKey('CM_BIND') || '127.0.0.1';
  // Issue #135: DB path resolution with proper fallback chain
  // Priority: CM_DB_PATH > DATABASE_PATH (deprecated) > getDefaultDbPath()
  const explicitDbPath = getEnvByKey('CM_DB_PATH');
  const databasePath = explicitDbPath
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
  } catch (error) {
    // Issue #1267: A rejected CM_DB_PATH must fail closed. Falling back here
    // handed the caller a different, fully usable database, so an isolated
    // environment silently became the real one.
    if (explicitDbPath !== undefined) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid CM_DB_PATH: ${reason}. `
        + `Set CM_DB_PATH to an allowed location, `
        + `or unset it to use the default (${getDefaultDbPath()}).`
      );
    }
    // DATABASE_PATH predates CM_DB_PATH and cannot be assumed deliberate,
    // so it keeps the historical warn-and-fall-back behaviour.
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
