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
 *     antigravity's `~/.gemini/config/hooks.json` is handled the same way. It
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
 * Unset (or any value other than `1`) changes nothing anywhere.
 *
 * `docs/user-guide/uat-isolation.md` has the measurement table and the skip
 * conditions for what cannot be isolated.
 *
 * @module config/uat-isolation
 */

/** The switch. Only the exact value `1` turns it on. */
export const UAT_ISOLATION_ENV_VAR = 'CM_UAT_ISOLATION';

/**
 * `--setting-sources` for a claude session in this mode: the user source
 * (`$CLAUDE_CONFIG_DIR/settings.json`, hooks and plugins included) is dropped;
 * the repository's own `project` / `local` settings and `--settings` stay.
 */
export const CLAUDE_UAT_SETTING_SOURCES = 'project,local';

/** Whether this process runs in UAT isolation mode. */
export function isUatIsolationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[UAT_ISOLATION_ENV_VAR] === '1';
}

/**
 * Thrown by a launch that would otherwise start an agent which reads a shared
 * hook config this server did not (and in this mode may not) write.
 *
 * Starting the agent "without hooks" is not an option for codex or antigravity:
 * the shared file is read regardless of what this server passes, so the
 * production server's hooks — already trusted — would run in the UAT session
 * and post to production. So the launch is refused, and the message says what
 * makes it start.
 */
export class UatIsolationLaunchRefusedError extends Error {
  constructor(tool: string, reason: string, fix: string) {
    super(
      `${UAT_ISOLATION_ENV_VAR}=1: refusing to start ${tool}: ${reason}. ` +
        `This server does not write the shared hook config in UAT isolation, and ${tool} ` +
        `would read it anyway and run the production hooks. ${fix}`
    );
    this.name = 'UatIsolationLaunchRefusedError';
  }
}

/** The fix for a shared hook config that does not match this build. */
export const UAT_SAME_BUILD_FIX =
  'Run the UAT with the same CommandMate build as the production server, so the shared file already matches what this build writes.';
