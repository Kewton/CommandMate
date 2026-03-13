/**
 * Environment Variable Sanitizer
 * Issue #294: Sanitizes environment variables for child processes
 *
 * Removes sensitive environment variables (auth tokens, certificates, database paths)
 * before spawning child processes like `claude -p`.
 *
 * [S1-001/S4-001] Centralized sensitive key management
 */

/**
 * List of environment variable keys that must be removed before
 * passing environment to child processes.
 *
 * These include authentication tokens, TLS certificates, IP restriction
 * settings, and database paths that should not be inherited by spawned
 * CLI tool processes.
 */
export const SENSITIVE_ENV_KEYS = [
  'CLAUDECODE',
  'CM_AUTH_TOKEN_HASH',
  'CM_AUTH_EXPIRE',
  'CM_HTTPS_KEY',
  'CM_HTTPS_CERT',
  'CM_ALLOWED_IPS',
  'CM_TRUST_PROXY',
  'CM_DB_PATH',
] as const;

/**
 * Create a sanitized copy of process.env suitable for child processes.
 *
 * Removes all keys listed in SENSITIVE_ENV_KEYS from the environment.
 * Non-sensitive variables (PATH, HOME, NODE_ENV, etc.) are preserved.
 *
 * @returns A shallow copy of process.env with sensitive keys removed
 *
 * @example
 * ```typescript
 * import { execFile } from 'child_process';
 * import { sanitizeEnvForChildProcess } from './env-sanitizer';
 *
 * execFile('claude', ['-p', message], {
 *   env: sanitizeEnvForChildProcess(),
 *   cwd: worktreePath,
 * });
 * ```
 */
export function sanitizeEnvForChildProcess(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
