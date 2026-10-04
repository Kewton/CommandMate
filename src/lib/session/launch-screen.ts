/**
 * Keep the launch line off the pane (Issue #3180).
 *
 * Every `startSession` types its launch line into the pane's login shell —
 * `CM_HOOK_URL='…' CM_PERMISSION_HOOK_URL='…' CM_PORT='3000' 'agy'` — and the
 * shell echoes it. A tool that repaints the whole screen hides the echo once it
 * draws; agy and codex draw inline, so the line, with its internal URL, port
 * and worktree ID, stayed in the scrollback for the life of the session.
 *
 * `clear` runs in the same shell, before the agent, so the echo is wiped before
 * the agent paints. The shell stays the agent's parent exactly as before, which
 * is what keeps exit detection (`judgeToolLiveness`, `relaunchIfToolExited`)
 * unchanged: when the agent quits, the pane falls back to the same shell prompt.
 *
 * `clear` alone only empties the visible screen. tmux 3.4+ defaults to
 * `scroll-on-clear on`, which moves what `clear` wiped INTO the scrollback, and
 * CommandMate's capture reads the scrollback: in the 2026-10-04 UAT (tmux 3.5a)
 * codex, antigravity, Command Code and gemini still had the launch line twice in
 * `tmux capture-pane -p -J -S -` (two `CM_HOOK_URL` hits), and it surfaced in the
 * UI terminal and in codex's trust-dialog sheet. So `printf '\033[3J'` follows
 * `clear`: ESC [3J (Erase Saved Lines) drops the scrollback, the echo included.
 * `tmux clear-history` would also work but depends on the pane having a tmux
 * binary and `TMUX` set, so it is not used. `printf` is a builtin in zsh, bash,
 * dash and fish, and each reads `\033` in the format as octal ESC; the single
 * quotes keep the backslash for printf in all of them.
 *
 * Joined with `;`, not `&&`, and with `clear`'s stderr dropped: a pane whose
 * `clear` is missing or fails (unknown `TERM`, no ncurses), or whose `printf`
 * fails, must still start the agent — a launch line left on screen is a
 * cosmetic leak, a session that never starts is not — and must not print the
 * failure in the line's place.
 *
 * Applied at the `sendKeys` call site, AFTER any flags a tool appends
 * (`--model`, `-s <id>`, Command Code's launch flags): `buildAgentLaunchCommandLine`
 * stays `NAME='value' … command`, and an appended flag lands on the agent, not
 * on `clear`.
 *
 * Deliberately not in a module the session suites mock wholesale
 * (`agent-session-lifecycle`, `tmux`), so those suites see the real prefix.
 *
 * @module lib/session/launch-screen
 */

/** The prefix every launch line is typed with. */
export const LAUNCH_SCREEN_CLEAR_PREFIX = "clear 2>/dev/null; printf '\\033[3J'; ";

/**
 * The line to type into the pane: clear the screen and the scrollback, then launch.
 *
 * @param launchCommand - The rendered launch line, flags included
 * @returns `clear 2>/dev/null; printf '\033[3J'; <launchCommand>`
 */
export function withLaunchScreenCleared(launchCommand: string): string {
  return `${LAUNCH_SCREEN_CLEAR_PREFIX}${launchCommand}`;
}
