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
import { resolveSafeDirectory } from './safe-directory';

/**
 * Get the log directory path.
 *
 * Resolution order:
 * 1. CM_LOG_DIR environment variable (with MCBD_LOG_DIR fallback via getEnvByKey)
 * 2. Default: `${process.cwd()}/data/logs`
 *
 * Issue #1774: a CM_LOG_DIR inside `/proc`, `/sys` or `/dev` falls back to the
 * default with a warning. `log-manager.ensureLogDirectory()` calls
 * `fs.mkdir(dir, {recursive:true})` on the result, and on Linux that promise
 * never settles for such a path — it holds a libuv threadpool thread for the
 * life of the process instead. Throwing is not an option here: the log
 * directory is where the complaint would have to go.
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
  const fallback = path.join(process.cwd(), 'data', 'logs');
  return resolveSafeDirectory(getEnvByKey('CM_LOG_DIR'), fallback, 'CM_LOG_DIR');
}
