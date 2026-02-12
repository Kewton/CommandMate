/**
 * Log Directory Configuration
 * Issue #11: Centralized LOG_DIR constant
 *
 * Eliminates duplicate LOG_DIR definitions previously found in:
 * - src/lib/log-manager.ts
 * - src/app/api/worktrees/[id]/logs/[filename]/route.ts
 *
 * Dependency chain: log-config.ts -> env.ts -> db-path-resolver.ts (no circular dependency)
 *
 * @module log-config
 */

import path from 'path';
import { getEnvByKey } from '@/lib/env';

/**
 * Get the log directory path.
 *
 * Resolution order:
 * 1. CM_LOG_DIR environment variable (with MCBD_LOG_DIR fallback via getEnvByKey)
 * 2. Default: `${process.cwd()}/data/logs`
 *
 * @returns Absolute path to the log directory
 *
 * @example
 * ```typescript
 * import { getLogDir } from '@/config/log-config';
 *
 * const logDir = getLogDir();
 * // => '/path/to/project/data/logs' (default)
 * // => '/custom/log/dir' (when CM_LOG_DIR is set)
 * ```
 */
export function getLogDir(): string {
  return getEnvByKey('CM_LOG_DIR') || path.join(process.cwd(), 'data', 'logs');
}
