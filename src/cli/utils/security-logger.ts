/**
 * Security Event Logger
 * Issue #96: npm install CLI support
 * SF-SEC-2: Security event logging for CLI commands
 */

import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
 */
function getLogPath(): string {
  const logDir = process.env.CM_LOG_DIR;
  if (logDir) {
    return join(logDir, 'security.log');
  }
  return join(homedir(), '.commandmate-security.log');
}

/**
 * Log a security event
 * Silently fails if file operations fail (non-critical)
 */
export function logSecurityEvent(event: SecurityEvent): void {
  try {
    const logPath = getLogPath();
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

  // Mask CM_AUTH_TOKEN values
  let result = input.replace(/CM_AUTH_TOKEN=\S+/g, 'CM_AUTH_TOKEN=***masked***');

  // Mask any token-like strings (12+ hex/alphanumeric characters after "token:")
  result = result.replace(/(?:token|Token)[:\s]+([a-zA-Z0-9]{12,})/gi, (_match, token) => {
    return _match.replace(token, '***');
  });

  return result;
}
