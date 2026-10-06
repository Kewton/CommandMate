/**
 * `CM_UAT_ISOLATION=1` — the mode a UAT / daily-check server and its CLI run in
 * (Issue #3360).
 *
 * A UAT server is isolated from production by its own port, DB, tmux socket and
 * state directories (`.commandmate/uat.yaml`). Three paths were left that those
 * do not cover, because they are keyed by the user's login rather than by
 * anything the UAT can move:
 *
 *  1. **codex's shared files.** `$CODEX_HOME/hooks.json`, the relay under
 *     `$CODEX_HOME/commandmate/` and the hook trust in `config.toml` live beside
 *     codex's login (`auth.json`), so moving `CODEX_HOME` logs codex out. In this
 *     mode the server writes none of them: it reuses the shared file only when it
 *     is already byte-identical to what this build would write (the per-session
 *     URL travels in the environment, so the hooks then reach THIS server), and
 *     otherwise refuses the launch ({@link UatIsolationLaunchRefusedError}) —
 *     a bare codex would still read the shared file and run production's hooks.
 *     antigravity's `~/.gemini/config/hooks.json` and copilot's
 *     `~/.copilot/settings.json` (Issue #3391) are handled the same way. It
 *     also never answers the hook review with *trust*, which is codex writing
 *     `config.toml`.
 *  2. **claude's user-level hooks.** `--settings` is added to
 *     `~/.claude/settings.json`, not substituted for it, so the user's own hooks
 *     (which post to production) would run in a UAT session too. Moving
 *     `CLAUDE_CONFIG_DIR` logs claude out (measured, `-p` and interactive). In
 *     this mode claude is launched with `--setting-sources project,local`, which
 *     drops the user source and keeps `--settings` (measured on 2.1.289) — the
 *     interactive launch and `claude -p` (Schedules, daily summary) alike.
 *  3. **the CLI's `.env`.** A client in this mode reads no `.env` file at all and
 *     refuses to fall back to port 3000: it dials only the `CM_PORT` the caller
 *     exported.
 *
 * Unset (or any value other than `1` / `own-home`) changes nothing anywhere.
 *
 * ## `CM_UAT_ISOLATION=own-home` (Issue #3312)
 *
 * For a run under a dedicated OS user (the daily product-path check), whose
 * HOME holds nobody else's CLI config. Everything above still holds — the
 * launch is refused rather than started bare when hook setup fails, the
 * receiver URL travels in the launch environment, headless `codex exec` /
 * `agy -p` are refused, claude reads no user-level settings, the CLI reads no
 * `.env` and never falls back to 3000 — with one difference: the shared hook
 * files (codex's `hooks.json`, relay and trust, antigravity's and copilot's
 * hook files, the claude settings under `CM_AGENT_HOOKS_DIR`) are WRITTEN by
 * this build, instead of being reused read-only. Only after
 * {@link assertUatOwnHomeWriteTargets} has checked, before each launch, that
 * this process runs as `CM_UAT_DEDICATED_USER`, that HOME is that user's, and
 * that every file it is about to write resolves (symlinks followed) to a place
 * inside that HOME owned by that user. {@link sharedHookWritePolicy} is the one
 * rule each tool's launch path calls.
 *
 * `docs/user-guide/uat-isolation.md` has the measurement table and the skip
 * conditions for what cannot be isolated.
 *
 * @module config/uat-isolation
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** The switch. Only the exact values `1` and `own-home` turn it on. */
export const UAT_ISOLATION_ENV_VAR = 'CM_UAT_ISOLATION';

/** The value of {@link UAT_ISOLATION_ENV_VAR} for a run under a dedicated OS user (Issue #3312). */
export const UAT_ISOLATION_OWN_HOME = 'own-home';

/** The login name `own-home` must run as (Issue #3312). Compared with `os.userInfo().username`. */
export const UAT_DEDICATED_USER_ENV_VAR = 'CM_UAT_DEDICATED_USER';

/**
 * - `off`: not isolated.
 * - `shared-read-only` (`1`): the shared hook files are reused only when they
 *   already match this build, never written.
 * - `own-home`: the shared hook files are written, inside the dedicated user's
 *   own HOME only (Issue #3312).
 */
export type UatIsolationMode = 'off' | 'shared-read-only' | 'own-home';

/**
 * `--setting-sources` for a claude session in this mode: the user source
 * (`$CLAUDE_CONFIG_DIR/settings.json`, hooks and plugins included) is dropped;
 * the repository's own `project` / `local` settings and `--settings` stay.
 */
export const CLAUDE_UAT_SETTING_SOURCES = 'project,local';

type Env = Readonly<Record<string, string | undefined>>;

/** Which isolation mode this process runs in. */
export function getUatIsolationMode(env: Env = process.env): UatIsolationMode {
  const value = env[UAT_ISOLATION_ENV_VAR];
  if (value === '1') return 'shared-read-only';
  if (value === UAT_ISOLATION_OWN_HOME) return 'own-home';
  return 'off';
}

/**
 * Whether this process runs in UAT isolation mode — `1` or `own-home`. Every
 * protection except "never write the shared hook files" keys off this.
 */
export function isUatIsolationEnabled(env: Env = process.env): boolean {
  return getUatIsolationMode(env) !== 'off';
}

/**
 * Thrown by a launch that would otherwise start an agent which reads a shared
 * hook config this server did not (and in this mode may not) write.
 *
 * Starting the agent "without hooks" is not an option for codex, antigravity
 * or copilot: the shared file is read regardless of what this server passes,
 * so the production server's hooks — already trusted — would run in the UAT
 * session and post to production. So the launch is refused, and the message says what
 * makes it start.
 */
export class UatIsolationLaunchRefusedError extends Error {
  constructor(tool: string, reason: string, fix: string) {
    super(
      getUatIsolationMode() === 'own-home'
        ? `${UAT_ISOLATION_ENV_VAR}=${UAT_ISOLATION_OWN_HOME}: refusing to start ${tool}: ${reason}. ` +
            `This server writes the hook config only inside the dedicated user's own HOME, and ${tool} ` +
            `would otherwise start with hooks this server did not prepare. ${fix}`
        : `${UAT_ISOLATION_ENV_VAR}=1: refusing to start ${tool}: ${reason}. ` +
            `This server does not write the shared hook config in UAT isolation, and ${tool} ` +
            `would read it anyway and run the production hooks. ${fix}`
    );
    this.name = 'UatIsolationLaunchRefusedError';
  }
}

/** The fix for a shared hook config that does not match this build. */
export const UAT_SAME_BUILD_FIX =
  'Run the UAT with the same CommandMate build as the production server, so the shared file already matches what this build writes.';

/** The fix for an `own-home` launch whose user, HOME or write targets did not check out. */
export const UAT_OWN_HOME_FIX =
  `Run ${UAT_ISOLATION_ENV_VAR}=${UAT_ISOLATION_OWN_HOME} as the user named by ${UAT_DEDICATED_USER_ENV_VAR}, ` +
  'with HOME set to that user\'s home and every hook config path (CODEX_HOME, CM_AGENT_HOOKS_DIR, ...) inside it.';

/** Who this process is. `os.userInfo()` reads the account database, not `$HOME`. */
export interface ProcessIdentity {
  username: string;
  uid: number;
  homedir: string;
}

function currentIdentity(): ProcessIdentity {
  const info = os.userInfo();
  return { username: info.username, uid: info.uid, homedir: info.homedir };
}

/**
 * Where a write to `target` would land, symlinks followed, and whose entry
 * decides who may write there: the target itself when it exists, else its
 * nearest existing ancestor (a file not yet created is judged by the directory
 * it would be created in). A dangling symlink is refused: writing through it
 * would create a file wherever it points.
 */
function resolveWriteTarget(target: string): { real: string; owner: number } | string {
  const absolute = path.resolve(target);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    let entryExists = false;
    try {
      fs.lstatSync(existing);
      entryExists = true;
    } catch {
      entryExists = false;
    }
    if (entryExists) break;
    const parent = path.dirname(existing);
    if (parent === existing) return `${target} has no existing ancestor`;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    return `${existing} is a symlink that points nowhere`;
  }
  return { real: path.join(real, ...rest), owner: fs.statSync(real).uid };
}

/**
 * Why an `own-home` launch may not write `writeTargets`, or null when it may
 * (Issue #3312). Checks, in this order: `CM_UAT_DEDICATED_USER` is set and is
 * the user this process runs as; `HOME` resolves to that user's home directory
 * (from the account database) and is owned by them; each target resolves —
 * every symlink on the way followed — to a path inside that home, and the entry
 * that decides the write (the target, or its nearest existing ancestor) is
 * owned by that user.
 */
export function checkUatOwnHomeWriteTargets(
  writeTargets: readonly string[],
  env: Env = process.env,
  identity: ProcessIdentity = currentIdentity()
): string | null {
  const dedicated = env[UAT_DEDICATED_USER_ENV_VAR];
  if (!dedicated) return `${UAT_DEDICATED_USER_ENV_VAR} is not set`;
  if (identity.username !== dedicated) {
    return `this process runs as ${identity.username}, not as the dedicated user ${dedicated}`;
  }
  const home = env.HOME;
  if (!home || !path.isAbsolute(home)) return 'HOME is not set to an absolute path';
  let homeReal: string;
  let accountHomeReal: string;
  try {
    homeReal = fs.realpathSync(home);
    accountHomeReal = fs.realpathSync(identity.homedir);
  } catch {
    return `HOME (${home}) or ${dedicated}'s home directory (${identity.homedir}) does not exist`;
  }
  if (homeReal !== accountHomeReal) {
    return `HOME (${home}) is not ${dedicated}'s home directory (${identity.homedir})`;
  }
  if (fs.statSync(homeReal).uid !== identity.uid) return `HOME (${home}) is not owned by ${dedicated}`;

  for (const target of writeTargets) {
    const resolved = resolveWriteTarget(target);
    if (typeof resolved === 'string') return resolved;
    if (resolved.real !== homeReal && !resolved.real.startsWith(`${homeReal}${path.sep}`)) {
      return `${target} resolves to ${resolved.real}, outside ${dedicated}'s HOME (${homeReal})`;
    }
    if (resolved.owner !== identity.uid) {
      return `${target} (${resolved.real}) is not owned by ${dedicated}`;
    }
  }
  return null;
}

/**
 * Under `own-home`, refuse the launch of `tool` unless
 * {@link checkUatOwnHomeWriteTargets} passes for `writeTargets`. A no-op in
 * every other mode.
 *
 * @throws {UatIsolationLaunchRefusedError}
 */
export function assertUatOwnHomeWriteTargets(
  tool: string,
  writeTargets: readonly string[],
  env: Env = process.env
): void {
  if (getUatIsolationMode(env) !== 'own-home') return;
  const problem = checkUatOwnHomeWriteTargets(writeTargets, env);
  if (problem) throw new UatIsolationLaunchRefusedError(tool, problem, UAT_OWN_HOME_FIX);
}

/**
 * The one rule for a hook file shared with the user's other CommandMate
 * servers (codex, antigravity and copilot call it; Issue #3312):
 *
 * - not isolated: `write`
 * - `CM_UAT_ISOLATION=1`: `read-only` — reuse it only when it already matches
 * - `CM_UAT_ISOLATION=own-home`: `write`, once
 *   {@link assertUatOwnHomeWriteTargets} has passed for every path the write
 *   touches; otherwise the launch is refused
 *
 * @throws {UatIsolationLaunchRefusedError} Under `own-home` only
 */
export function sharedHookWritePolicy(
  tool: string,
  writeTargets: readonly string[],
  env: Env = process.env
): 'write' | 'read-only' {
  const mode = getUatIsolationMode(env);
  if (mode === 'shared-read-only') return 'read-only';
  assertUatOwnHomeWriteTargets(tool, writeTargets, env);
  return 'write';
}
