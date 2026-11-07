/**
 * Security Event Logger
 * Issue #96: npm install CLI support
 * SF-SEC-2: Security event logging for CLI commands
 */

import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// Relative, not '@/': `tsconfig.cli.json` has no path aliases, so nothing the
// CLI build compiles may reach an '@/' import. That is also why this does not
// call `getLogDir()` (config/log-config → lib/env → lib/db/db-path-resolver,
// all '@/'); `system-directories` is the guard `getLogDir()` itself ends in.
import { isVirtualFilesystemPath } from '../../config/system-directories';

/**
 * Security event types
 */
export interface SecurityEvent {
  /** ISO timestamp */
  timestamp: string;
  /** Command that triggered the event */
  command: string;
  /** Event outcome */
  action: 'success' | 'failure' | 'warning';
  /** Additional details */
  details?: string;
}

/**
 * Get security log file path
 *
 * Issue #4210: `CM_LOG_DIR` is judged the way `getLogDir()`
 * (`config/log-config.ts`) judges it for every other log writer. A value inside
 * `/proc`, `/sys` or `/dev` — literally, through a symlink, or as the absolute
 * form of a relative value — is refused and the default file is used. A
 * relative value is otherwise kept as given and so resolved against this
 * process's cwd, which is also what `getLogDir()` does: the file is only ever
 * opened by the process that resolved it, so nothing else has to agree on it.
 *
 * The default stays `~/.commandmate-security.log` rather than `getLogDir()`'s
 * `<cwd>/data/logs`: a CLI run from an arbitrary directory has no `data/logs`.
 *
 * @returns The file security events are appended to
 */
export function getSecurityLogPath(): string {
  const fallback = join(homedir(), '.commandmate-security.log');
  const logDir = process.env.CM_LOG_DIR;
  if (!logDir || isRefusedLogDir(logDir)) {
    return fallback;
  }
  return join(logDir, 'security.log');
}

/**
 * Whether `logDir` is one `getLogDir()` would refuse.
 *
 * An exception from the check itself keeps the configured value. Nothing here
 * creates a directory — `appendFileSync` has no recursive mkdir, which is what
 * hangs under `/proc` (Issue #1774) — so the worst a kept value can do is fail
 * the append, which `logSecurityEvent` already ignores. Refusing on an
 * exception would instead move events away from the directory that was asked
 * for whenever the filesystem layer misbehaves (a test's `vi.mock('fs')` is
 * one: `realpathSync` then answers `undefined`).
 */
function isRefusedLogDir(logDir: string): boolean {
  try {
    return isVirtualFilesystemPath(logDir);
  } catch {
    return false;
  }
}

/**
 * Log a security event
 * Silently fails if file operations fail (non-critical)
 */
export function logSecurityEvent(event: SecurityEvent): void {
  try {
    const logPath = getSecurityLogPath();
    const maskedDetails = maskSensitiveData(event.details);
    const logLine = `${event.timestamp} [${event.action.toUpperCase()}] ${event.command}: ${maskedDetails || ''}\n`;

    appendFileSync(logPath, logLine, { mode: 0o600 });
  } catch {
    // Silently ignore logging failures - they should not affect CLI operation
  }
}

/**
 * Mask sensitive data in log messages
 * SF-SEC-2: Mask authentication tokens in logs
 */
export function maskSensitiveData(input: string | undefined): string | undefined {
  if (!input) {
    return input;
  }

  // Mask any token-like strings (12+ hex/alphanumeric characters after "token:")
  let result = input;
  result = result.replace(/(?:token|Token)[:\s]+([a-zA-Z0-9]{12,})/gi, (_match, token) => {
    return _match.replace(token, '***');
  });

  return result;
}
