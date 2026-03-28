/**
 * Security event logging utilities
 * Issue #574: Unified security event logging with security: prefix
 *
 * This module provides a typed helper for logging security events.
 * All security events MUST be logged via logSecurityEvent() to ensure
 * they pass through logger.ts sanitization pipeline.
 * Do NOT use console.log or other methods that bypass sanitization.
 */

import type { Logger } from '@/lib/logger';

/**
 * Security event action types.
 * Each action represents a specific security event detected by the system.
 */
export type SecurityAction =
  | 'symlink-rejected'
  | 'dangling-symlink-rejected'
  | 'symlink-ancestor-rejected'
  | 'trust-proxy-unexpected';

/**
 * Log a security event with the unified security: prefix.
 *
 * @param logger - Logger instance (from createLogger)
 * @param action - Security action identifier
 * @param details - Additional context for the security event
 */
export function logSecurityEvent(
  logger: Logger,
  action: SecurityAction,
  details: Record<string, unknown>
): void {
  logger.warn(`security:${action}`, details);
}
