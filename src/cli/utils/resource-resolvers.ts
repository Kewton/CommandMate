/**
 * Resource Path Resolvers
 * Issue #136: Phase 1 - Task 1.2
 *
 * Provides Strategy pattern implementation for resolving resource paths:
 * - Database paths (cm.db, cm-{issueNo}.db)
 * - PID file paths (.commandmate.pid, pids/{issueNo}.pid)
 * - Log file paths (commandmate.log, commandmate-{issueNo}.log)
 *
 * SF-SEC-001: TOCTOU protection via try-catch pattern in validate()
 *
 * @module resource-resolvers
 */

import { realpathSync } from 'fs';
import path from 'path';
import { getConfigDir } from './install-context';

/**
 * Interface for resource path resolvers
 * Strategy pattern for unified resource path handling
 */
export interface ResourcePathResolver {
  /**
   * Resolve the path for a resource
   * @param issueNo - Optional issue number for worktree-specific resources
   * @returns Absolute path to the resource
   */
  resolve(issueNo?: number): string;

  /**
   * Validate that a path is within the allowed directory
   * SF-SEC-001: Uses try-catch pattern for TOCTOU protection
   *
   * @param targetPath - Path to validate
   * @returns true if path is valid and within allowed boundaries
   */
  validate(targetPath: string): boolean;
}

/**
 * Database path resolver
 *
 * @example
 * ```typescript
 * const resolver = new DbPathResolver();
 * resolver.resolve(); // ~/.commandmate/data/cm.db
 * resolver.resolve(135); // ~/.commandmate/data/cm-135.db
 * ```
 */
export class DbPathResolver implements ResourcePathResolver {
  resolve(issueNo?: number): string {
    const configDir = getConfigDir();
    if (issueNo !== undefined) {
      return path.join(configDir, 'data', `cm-${issueNo}.db`);
    }
    return path.join(configDir, 'data', 'cm.db');
  }

  validate(targetPath: string): boolean {
    const configDir = getConfigDir();

    // SF-SEC-001: try-catch for TOCTOU protection
    try {
      const resolved = realpathSync(targetPath);
      return resolved.startsWith(configDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // New file - validate parent directory
        const parentDir = path.dirname(targetPath);
        try {
          const resolvedParent = realpathSync(parentDir);
          return resolvedParent.startsWith(configDir);
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

/**
 * PID file path resolver
 *
 * Maintains backward compatibility:
 * - No issueNo: ~/.commandmate/.commandmate.pid (main server)
 * - With issueNo: ~/.commandmate/pids/{issueNo}.pid (worktree server)
 *
 * @example
 * ```typescript
 * const resolver = new PidPathResolver();
 * resolver.resolve(); // ~/.commandmate/.commandmate.pid
 * resolver.resolve(135); // ~/.commandmate/pids/135.pid
 * ```
 */
export class PidPathResolver implements ResourcePathResolver {
  resolve(issueNo?: number): string {
    const configDir = getConfigDir();
    if (issueNo !== undefined) {
      return path.join(configDir, 'pids', `${issueNo}.pid`);
    }
    // Backward compatibility: main PID file in config root
    return path.join(configDir, '.commandmate.pid');
  }

  validate(targetPath: string): boolean {
    const configDir = getConfigDir();

    // SF-SEC-001: try-catch for TOCTOU protection
    try {
      const resolved = realpathSync(targetPath);
      return resolved.startsWith(configDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // New file - validate parent directory
        const parentDir = path.dirname(targetPath);
        try {
          const resolvedParent = realpathSync(parentDir);
          return resolvedParent.startsWith(configDir);
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

/**
 * Log file path resolver
 *
 * @example
 * ```typescript
 * const resolver = new LogPathResolver();
 * resolver.resolve(); // ~/.commandmate/logs/commandmate.log
 * resolver.resolve(135); // ~/.commandmate/logs/commandmate-135.log
 * ```
 */
export class LogPathResolver implements ResourcePathResolver {
  resolve(issueNo?: number): string {
    const configDir = getConfigDir();
    const logsDir = path.join(configDir, 'logs');
    if (issueNo !== undefined) {
      return path.join(logsDir, `commandmate-${issueNo}.log`);
    }
    return path.join(logsDir, 'commandmate.log');
  }

  validate(targetPath: string): boolean {
    const configDir = getConfigDir();
    const logsDir = path.join(configDir, 'logs');

    // SF-SEC-001: try-catch for TOCTOU protection
    try {
      const resolved = realpathSync(targetPath);
      return resolved.startsWith(logsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // New file - validate logs directory exists within config
        try {
          const resolvedLogsDir = realpathSync(logsDir);
          return resolvedLogsDir.startsWith(configDir);
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

/**
 * Factory function for DbPathResolver
 */
export function createDbPathResolver(): DbPathResolver {
  return new DbPathResolver();
}

/**
 * Factory function for PidPathResolver
 */
export function createPidPathResolver(): PidPathResolver {
  return new PidPathResolver();
}

/**
 * Factory function for LogPathResolver
 */
export function createLogPathResolver(): LogPathResolver {
  return new LogPathResolver();
}
