/**
 * The one path `$CODEX_HOME/hooks.json` is allowed to name (Issue #2315).
 *
 * ## The bug this module exists for
 *
 * `hooks-config` writes ONE file — `$CODEX_HOME/hooks.json` — shared by every
 * codex session on the machine, and its whole design rests on that file being
 * byte-identical whoever wrote it: codex keys hook trust by the hash of the
 * handler, so a file whose bytes move puts the review dialog back in front of
 * the next launch. `writeCodexHookSettings` already refuses to rewrite matching
 * content, and `buildCodexHookSettings` already keeps the port, the worktree and
 * the instance out of the file.
 *
 * One value got through anyway, and it is the one that moves most: the absolute
 * path of the relay script, which `resolveRelayScriptPath()` resolves against
 * `process.cwd()` — the checkout of the server that happened to write the file.
 * Measured on the reporting machine on 2026-09-04, with 22 worktrees registered
 * and several dev servers running:
 *
 * ```
 * $ grep -o "'[^']*cmate-agent-event.sh'" ~/.codex/hooks.json
 * '/Users/…/MyCodeBranchDesk/scripts/hooks/cmate-agent-event.sh'
 * $ pwd   # a worktree server, which would rewrite it as its own
 * /Users/…/commandmate-issue-2315
 * ```
 *
 * So each server rewrites the shared file with its own checkout, every rewrite
 * invalidates the hash the human trusted, and the next codex opens on
 * `Trust  Modified since last trusted - review required`. The servers eat each
 * other's trust, forever, which is the "度々" in the Issue.
 *
 * ## The fix
 *
 * Put the script where every server agrees it is: beside the hooks file it is
 * named from, under `$CODEX_HOME/commandmate/`. Each server copies its shipped
 * relay there (a no-op when the bytes already match) and `hooks.json` names the
 * installed copy, so the generated file no longer contains a checkout at all —
 * it is a function of `$CODEX_HOME` alone, which is the same directory codex
 * reads the hooks from by construction.
 *
 * A server whose own copy of the script is unreachable — a global install whose
 * `process.cwd()` is the user's shell directory — installs nothing and uses the
 * copy that is already there, rather than falling back to the inline `curl`
 * form and rewriting the file into a third shape.
 *
 * Copying the SCRIPT rather than hashing it is deliberate. codex trusts a
 * command *string*; it cannot see what that string executes, so two servers on
 * different versions of the script still share one trusted `hooks.json`. The
 * newest server to start wins the script content, which is the same rule the
 * hooks file itself has always had.
 *
 * @module lib/hooks/sources/codex/relay-install
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/sources/codex/relay-install');

/**
 * Subdirectory of `$CODEX_HOME` this server owns.
 *
 * Namespaced rather than dropped beside `hooks.json` because the directory is
 * the operator's: everything CommandMate puts there is under one name they can
 * delete in one command, and nothing it writes can collide with a file codex
 * itself introduces later.
 */
export const CODEX_RELAY_INSTALL_DIRNAME = 'commandmate';

/** Basename kept identical to the shipped script, so the two are recognisably one file. */
export const CODEX_RELAY_INSTALL_BASENAME = 'cmate-agent-event.sh';

/** Where {@link installCodexRelayScript} puts the relay, for a given codex home. */
export function getCodexRelayInstallPath(codexHome: string): string {
  return join(codexHome, CODEX_RELAY_INSTALL_DIRNAME, CODEX_RELAY_INSTALL_BASENAME);
}

/**
 * The installed relay, or null when nothing has installed one yet.
 *
 * Read-only, so the command builders stay free of side effects: the install
 * itself is done once by {@link installCodexRelayScript}, from the one function
 * that was going to touch the disk anyway.
 */
export function getInstalledCodexRelayPath(codexHome: string): string | null {
  const target = getCodexRelayInstallPath(codexHome);
  return existsSync(target) ? target : null;
}

/**
 * Copy the shipped relay to the stable path, and answer where codex should look.
 *
 * Never throws and never fails a launch: hooks are an enhancement to a session
 * that has to start regardless, so every error path here degrades to "use
 * whatever copy is already installed", and then to "no relay", which
 * `buildCodexEventHookCommand` answers with its inline `curl`.
 *
 * Idempotent: the file is opened for writing only when the bytes differ, so the
 * ordinary launch does not touch it. The write itself goes through a temporary
 * file and a rename, because the file being replaced is one a *running* codex
 * session may be executing at that moment — truncating it in place would hand
 * that session half a script.
 *
 * @param codexHome - The directory `hooks.json` lives in
 * @param sourcePath - The shipped script, or null when this process cannot find its own
 * @returns The path to name in `hooks.json`, or null when there is none
 */
export function installCodexRelayScript(
  codexHome: string,
  sourcePath: string | null
): string | null {
  const target = getCodexRelayInstallPath(codexHome);

  if (sourcePath && sourcePath !== target) {
    try {
      const desired = readFileSync(sourcePath, 'utf8');
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current !== desired) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        // `.tmp` beside the target so the rename cannot cross a filesystem.
        const staging = `${target}.tmp`;
        try {
          writeFileSync(staging, desired, { mode: 0o700 });
          renameSync(staging, target);
        } catch (error) {
          try {
            unlinkSync(staging);
          } catch {
            // Nothing to clean up, or nothing that can be.
          }
          throw error;
        }
        logger.info('codex-relay-installed', { target });
      }
    } catch (error) {
      // An install that failed is not a launch that failed. If a previous
      // server already put a copy there, that copy is still the right path to
      // name — and naming it is what keeps this file byte-identical.
      logger.warn('codex-relay-install-failed', {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return existsSync(target) ? target : null;
}
