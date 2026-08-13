/**
 * The one place a configured directory becomes a directory this process is
 * willing to create (Issue #1774).
 *
 * ## What this is defending against
 *
 * Pointing a configured path at `/proc`, `/sys` or `/dev` does not make
 * CommandMate fail — it makes it **stop**. procfs answers a `mkdir` for a child
 * that cannot exist with ENOENT rather than EPERM, and Node's recursive mkdir
 * reads ENOENT as "the parent is missing", creates the parent, and retries; the
 * parent is created with EEXIST, so one level is enough to loop. Measured in a
 * container: `mkdirSync('/proc/x/y', {recursive:true})` had not returned after
 * 25s at 100.4% CPU, and `fs.promises.mkdir` on the same path never settled and
 * held a libuv threadpool thread (there are four) forever. The synchronous form
 * stops the event loop outright, which is also why the `try/catch` these call
 * sites already have does nothing: control never reaches it. There is no error
 * log, no OOM and no timeout — the process simply goes quiet. PR #1773's CI job
 * ran 5h31m that way.
 *
 * On macOS none of the three paths exist, so the same call throws instantly and
 * everything looks fine. The failure is Linux- and container-only.
 *
 * ## Why a resolver rather than a check at each mkdir
 *
 * Five settings reach a recursive mkdir this way (`CM_AGENT_HOOKS_DIR`,
 * `CM_LOG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CM_OPENCODE_PORT_FILE`), and
 * three of the five arrived with Phase 4 (#1760 / #1761 / #1763) as copies of
 * the first. Guarding the mkdir sites individually invites a sixth copy; putting
 * the guard on the *resolution* of the value means a new tool is protected by
 * calling the resolver its siblings already call.
 *
 * ## Why it never throws
 *
 * A bad log directory must not take out logging, and hook injection is
 * fail-open by design (`hook-settings-generator.buildClaudeLaunchCommand`).
 * Falling back to the built-in default and saying so keeps a misconfigured
 * server running with its events intact.
 *
 * @module config/safe-directory
 */

import { createLogger } from '@/lib/logger';
import { isVirtualFilesystemPath } from './system-directories';

const logger = createLogger('safe-directory');

/**
 * Settings already warned about, so a rejection is reported once rather than on
 * every call.
 *
 * `getLogDir()` runs on the path of every log write; an unconditional warning
 * would turn one misconfigured variable into a log flood, in the log directory
 * that is already not the one the operator asked for.
 */
const warnedRejections = new Set<string>();

/** Forget which rejections have been warned about. For tests. */
export function resetSafeDirectoryWarnings(): void {
  warnedRejections.clear();
}

/**
 * The directory to actually use for `candidate`, which is `candidate` unless
 * using it would hang the process.
 *
 * Pure with respect to the filesystem in the sense that matters here: it reads
 * (symlink resolution) but creates nothing, so it is safe to call — and to test
 * — with a path that no `mkdir` could survive.
 *
 * A *file* path is a valid candidate. The check is prefix-based, so a file
 * inside a virtual filesystem is rejected exactly as its directory would be;
 * `CM_OPENCODE_PORT_FILE` relies on that.
 *
 * @param candidate - The configured path. Empty or undefined means "unset"
 * @param fallback - The built-in default to use when the candidate is refused
 * @param source - What supplied the candidate, e.g. `'CM_LOG_DIR'`. Appears in
 *   the warning, because the operator's next question is which setting to fix
 * @returns `candidate`, or `fallback` when the candidate is inside `/proc`,
 *   `/sys` or `/dev`
 *
 * @example
 * ```typescript
 * const fallback = join(homedir(), '.commandmate', 'hooks');
 * return resolveSafeDirectory(process.env.CM_AGENT_HOOKS_DIR, fallback, 'CM_AGENT_HOOKS_DIR');
 * ```
 */
export function resolveSafeDirectory(
  candidate: string | undefined,
  fallback: string,
  source: string
): string {
  if (!candidate) return fallback;
  if (!isVirtualFilesystemPath(candidate)) return candidate;

  const key = `${source}|${candidate}`;
  if (!warnedRejections.has(key)) {
    warnedRejections.add(key);
    logger.warn('virtual-filesystem-path-rejected', {
      source,
      candidate,
      fallback,
      reason:
        'A recursive mkdir under /proc, /sys or /dev never returns on Linux; ' +
        'the built-in default is used instead (Issue #1774).',
    });
  }

  return fallback;
}
