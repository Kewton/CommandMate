/**
 * The one path `~/.gemini/config/hooks.json` is allowed to name (Issue #4505).
 *
 * ## The bug this module exists for
 *
 * `hooks-config` writes one file for the whole machine — `~/.gemini/config/hooks.json`,
 * the only place agy reads named hooks from (#1757 §5.4.2) — and its hook
 * commands used to name `process.cwd()/scripts/hooks/cmate-agent-event.sh`: the
 * checkout of whichever worktree server wrote the file last. Measured on
 * 2026-11-19: start agy from a feature worktree's server, then delete that
 * worktree, and every agy session on the machine — production's included —
 * posts its `Stop` and `PostToolUse` to a path that no longer exists.
 *
 * ## The fix
 *
 * Put the script beside the hooks file it is named from, under
 * `<hooks.json's directory>/commandmate/`. Each server copies its shipped relay
 * there (a no-op when the bytes already match) and the generated file names the
 * installed copy, so it no longer contains a checkout at all — it is a function
 * of the hooks file's location, which is the directory agy reads the hooks from
 * by construction. The shape is codex's (Issue #2315,
 * `lib/hooks/sources/codex/relay-install`); the two are not shared because the
 * codex one is keyed by `$CODEX_HOME`, not by a possibly-overridden hooks path.
 *
 * A server whose own copy of the script is unreachable — a global install whose
 * `process.cwd()` is the user's shell directory — installs nothing and uses the
 * copy that is already there, rather than naming a checkout again.
 *
 * Copying the SCRIPT rather than its path is deliberate: the hooks file cannot
 * see what an absolute path executes, and two servers on different versions of
 * the script still have to agree on one stable file name.
 *
 * @module lib/hooks/sources/antigravity/relay-install
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isVirtualFilesystemPath } from '@/config/system-directories';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/sources/antigravity/relay-install');

/**
 * Subdirectory of the hooks file's directory this server owns.
 *
 * Namespaced rather than dropped beside `hooks.json` because that directory is
 * agy's: everything CommandMate puts there is under one name the operator can
 * delete in one command, and nothing it writes can collide with a file agy
 * itself introduces later.
 */
export const ANTIGRAVITY_RELAY_INSTALL_DIRNAME = 'commandmate';

/** Basename kept identical to the shipped script, so the two are recognisably one file. */
export const ANTIGRAVITY_RELAY_INSTALL_BASENAME = 'cmate-agent-event.sh';

/**
 * Where the relay lives for a given hooks file.
 *
 * @param hooksConfigPath - The `hooks.json` the generated config is written to
 */
export function getAntigravityRelayInstallPath(hooksConfigPath: string): string {
  return join(
    dirname(hooksConfigPath),
    ANTIGRAVITY_RELAY_INSTALL_DIRNAME,
    ANTIGRAVITY_RELAY_INSTALL_BASENAME
  );
}

/**
 * The temp file the relay is written to before it is renamed over the target.
 *
 * Carries the pid so two servers installing at once cannot delete each other's
 * half-written script or rename the inode the other is still writing. Within
 * one process the name is deterministic, which is what lets
 * `sharedHookWritePolicy` check the exact path.
 */
export function getAntigravityRelayStagingPath(target: string): string {
  return `${target}.${process.pid}.tmp`;
}

/**
 * The installed relay, or null when nothing has installed one yet.
 *
 * Read-only, so the command builders stay free of side effects: the install
 * itself is done once by {@link installAntigravityRelayScript}, from the one
 * function that was going to touch the disk anyway.
 *
 * A directory or device node at the path is not a relay: naming it in
 * `hooks.json` would make every session fail to run its hook in silence, so it
 * answers null here and the install answers null too.
 *
 * @param hooksConfigPath - The `hooks.json` the config belongs to
 */
export function getInstalledAntigravityRelayPath(hooksConfigPath: string): string | null {
  const target = getAntigravityRelayInstallPath(hooksConfigPath);
  return isRegularFile(target) ? target : null;
}

/**
 * Copy the shipped relay to the stable path, and answer where the hooks file
 * should point.
 *
 * Never fails a launch: hooks are an enhancement to a session that has to start
 * regardless, so an install error degrades to "use whatever copy is already
 * installed", and then to null, which the caller turns into
 * `antigravity-hook-relay-missing` and a session without hooks.
 *
 * Idempotent: the file is opened for writing only when the bytes differ, so the
 * ordinary launch does not touch it. The write itself goes through a temporary
 * file and a rename, because the file being replaced is one a *running* agy
 * session may be executing at that moment — truncating it in place would hand
 * that session half a script.
 *
 * Issue #1774: a target inside `/proc`, `/sys` or `/dev` is refused by throwing
 * BEFORE the mkdir. A recursive mkdir there does not fail, it spins the event
 * loop until the process is killed, and `writeJsonObjectFile`'s own guard comes
 * after this copy would have happened. The caller's fail-open `catch` turns the
 * throw into `antigravity-hooks-config-write-failed` and a launch without hooks.
 *
 * @param hooksConfigPath - The `hooks.json` the generated config is written to
 * @param sourcePath - The shipped script, or null when this process cannot find its own
 * @returns The path to name in `hooks.json`, or null when there is none
 * @throws If the install path is inside a virtual filesystem
 */
export function installAntigravityRelayScript(
  hooksConfigPath: string,
  sourcePath: string | null
): string | null {
  const target = getAntigravityRelayInstallPath(hooksConfigPath);
  if (isVirtualFilesystemPath(target)) {
    throw new Error(
      `Refusing to install the relay inside a virtual filesystem: ${target} ` +
        `(a recursive mkdir under /proc, /sys or /dev never returns on Linux; Issue #1774)`
    );
  }

  if (sourcePath && sourcePath !== target) {
    try {
      copyRelayIfChanged(sourcePath, target);
    } catch (error) {
      // An install that failed is not a launch that failed. If a previous
      // server already put a copy there, that copy is still the right path to
      // name — and naming it is what keeps this file checkout-independent.
      logger.warn('antigravity-relay-install-failed', {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return isRegularFile(target) ? target : null;
}

/**
 * {@link installAntigravityRelayScript} for `CM_UAT_ISOLATION=own-home`
 * (Issue #3312): every failure throws instead of being absorbed — no shipped
 * relay, a copy that could not be written, or a copy whose bytes still differ
 * from the shipped one — so the caller refuses the launch rather than running
 * the check against an older relay.
 *
 * @returns The installed path, byte-identical to `sourcePath`
 * @throws When the relay is missing or could not be made identical
 */
export function installAntigravityRelayScriptOrThrow(
  hooksConfigPath: string,
  sourcePath: string | null
): string {
  if (!sourcePath) throw new Error('this build ships no relay script');
  const target = getAntigravityRelayInstallPath(hooksConfigPath);
  if (isVirtualFilesystemPath(target)) {
    throw new Error(
      `Refusing to install the relay inside a virtual filesystem: ${target} ` +
        `(a recursive mkdir under /proc, /sys or /dev never returns on Linux; Issue #1774)`
    );
  }
  if (sourcePath !== target) copyRelayIfChanged(sourcePath, target);
  if (!isRegularFile(target) || readFileSync(target, 'utf8') !== readFileSync(sourcePath, 'utf8')) {
    throw new Error(`the installed relay ${target} differs from the one this build ships`);
  }
  return target;
}

/**
 * Copy `sourcePath` to `target` when the bytes differ. Throws on any failure.
 *
 * The temp file is removed first and then created exclusively (`wx`), so a
 * symlink planted at that name is removed, never written through; the rename
 * stays beside the target so it cannot cross a filesystem.
 *
 * A byte-identical copy is left in place, but its executable bit is restored if
 * it lost one: the hook is invoked by path, so a copy that cannot be executed
 * drops every event in silence.
 */
function copyRelayIfChanged(sourcePath: string, target: string): void {
  const desired = readFileSync(sourcePath, 'utf8');
  const current = isRegularFile(target) ? readFileSync(target, 'utf8') : null;
  if (current === desired) {
    ensureExecutable(target);
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = getAntigravityRelayStagingPath(target);
  try {
    unlinkIfPresent(staging);
    writeFileSync(staging, desired, { mode: 0o700, flag: 'wx' });
    renameSync(staging, target);
  } catch (error) {
    unlinkIfPresent(staging);
    throw error;
  }
  logger.info('antigravity-relay-installed', { target });
}

/** Whether `file` exists and is a regular file (not a directory or device). */
function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Put the executable bit back on a copy that has the right bytes but none. */
function ensureExecutable(target: string): void {
  if ((statSync(target).mode & 0o111) !== 0) return;
  chmodSync(target, 0o700);
}

function unlinkIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Nothing to clean up, or nothing that can be.
  }
}
